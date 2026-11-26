import { describe, expect, it } from 'vitest';
import type { AppLauncherItem, AppLauncherListResponse } from '@ever-works/contracts';
import {
    EVER_APP_LINE_KEYS,
    addAppUrlFrom,
    everAppLineKey,
    withTranslatedLines,
} from '../ever-app-lines';

/** In-app switcher brief (2026-11-26) S3 and S7, the host's half. */

function item(partial: Partial<AppLauncherItem> & { key: string }): AppLauncherItem {
    return {
        kind: 'platform',
        section: 'platforms',
        name: partial.key,
        url: 'https://example.com',
        host: 'example.com',
        visible: true,
        pinned: false,
        pinOrder: null,
        order: 0,
        manageState: 'listed',
        ...partial,
    };
}

function list(items: AppLauncherItem[]): AppLauncherListResponse {
    return {
        items,
        meta: {
            environment: 'develop',
            catalogVersion: '0.4.0',
            catalogAvailable: true,
            scopeKey: 'personal',
            worksTotal: 0,
            total: items.length,
            truncated: false,
            pinLimit: 6,
            appWorksAvailable: true,
        },
    };
}

describe('everAppLineKey', () => {
    it('maps the eight Ever apps of the catalog to their line keys', () => {
        expect(Object.keys(EVER_APP_LINE_KEYS)).toEqual([
            'app-ever-co',
            'ever-works',
            'ever-teams',
            'ever-gauzy',
            'ever-rec',
            'ever-traduora',
            'ever-demand',
            'ever-tech',
        ]);
        expect(everAppLineKey('platform:ever-tech')).toBe('lineTech');
        expect(everAppLineKey('platform:app-ever-co')).toBe('linePlatform');
    });

    it('answers null for a Work, an unknown entry and an inherited property name', () => {
        expect(everAppLineKey('work:ever-works')).toBeNull();
        expect(everAppLineKey('platform:cal-diy')).toBeNull();
        expect(everAppLineKey('platform:toString')).toBeNull();
    });
});

describe('withTranslatedLines', () => {
    it('swaps in the translated line for known Ever apps only', () => {
        const data = list([
            item({ key: 'platform:ever-works', description: 'English' }),
            item({ key: 'platform:cal-diy', description: 'Kept' }),
            item({ key: 'work:docs', kind: 'work', section: 'works', description: undefined }),
        ]);
        const out = withTranslatedLines(data, (key) => `fr:${key}`);
        expect(out?.items.map((entry) => entry.description)).toEqual([
            'fr:lineWorks',
            'Kept',
            undefined,
        ]);
        // The input is not mutated.
        expect(data.items[0].description).toBe('English');
    });

    it('returns the same list when nothing changes, and null for null', () => {
        const data = list([item({ key: 'platform:ever-works', description: 'Same' })]);
        expect(withTranslatedLines(data, () => 'Same')).toBe(data);
        expect(withTranslatedLines(null, () => 'x')).toBeNull();
    });
});

describe('addAppUrlFrom', () => {
    it('derives <Ever Platform>/apps?add=app from the environment’s Ever Platform address', () => {
        expect(
            addAppUrlFrom(
                list([item({ key: 'platform:app-ever-co', url: 'https://app-dev.ever.co' })]),
            ),
        ).toBe('https://app-dev.ever.co/apps?add=app');
        // A path on the stored address is replaced, not appended to.
        expect(
            addAppUrlFrom(
                list([item({ key: 'platform:app-ever-co', url: 'https://app.ever.co/o/acme' })]),
            ),
        ).toBe('https://app.ever.co/apps?add=app');
    });

    it('still leads there when the person hid Ever Platform from the list', () => {
        const hidden = item({
            key: 'platform:app-ever-co',
            url: 'https://app.ever.co',
            visible: false,
        });
        expect(addAppUrlFrom(list([hidden]))).toBe('https://app.ever.co/apps?add=app');
    });

    it('answers null without an Ever Platform https address', () => {
        expect(addAppUrlFrom(null)).toBeNull();
        expect(addAppUrlFrom(list([item({ key: 'platform:ever-works' })]))).toBeNull();
        expect(addAppUrlFrom(list([item({ key: 'platform:app-ever-co', url: null })]))).toBeNull();
        expect(
            addAppUrlFrom(list([item({ key: 'platform:app-ever-co', url: 'http://app.ever.co' })])),
        ).toBeNull();
        expect(
            addAppUrlFrom(list([item({ key: 'platform:app-ever-co', url: 'not a url' })])),
        ).toBeNull();
        expect(
            addAppUrlFrom(
                list([item({ key: 'platform:app-ever-co', url: 'https://u:p@app.ever.co' })]),
            ),
            'FR-32: never an address with credentials',
        ).toBeNull();
    });
});
