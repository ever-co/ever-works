import { describe, expect, it } from 'vitest';
import {
    acceptanceCheckSchema,
    ACCEPTANCE_CHECK_ID_PATTERN,
    slugifyCheckId,
} from './acceptance-checks.shared';

const base = {
    id: 'unit-tests',
    name: 'Unit tests',
    kind: 'test',
    command: 'pnpm test',
    required: true,
} as const;

describe('acceptanceCheckSchema', () => {
    it('keeps phase, mountDir and envPassthrough — the API replaces the whole list on save', () => {
        const check = {
            ...base,
            phase: 'setup',
            mountDir: 'api',
            envPassthrough: ['NPM_TOKEN', 'CI'],
            cwd: 'packages/app',
            timeoutSec: 3600,
            disabled: false,
        };
        const parsed = acceptanceCheckSchema.parse(check);
        expect(parsed).toEqual(check);
    });

    it('accepts an id with an underscore, as the API does', () => {
        expect(acceptanceCheckSchema.safeParse({ ...base, id: 'type_check' }).success).toBe(true);
    });

    it('refuses an id longer than the API allows (41)', () => {
        expect(acceptanceCheckSchema.safeParse({ ...base, id: 'a'.repeat(41) }).success).toBe(true);
        expect(acceptanceCheckSchema.safeParse({ ...base, id: 'a'.repeat(42) }).success).toBe(
            false,
        );
    });

    it.each([
        ['phase', 'teardown'],
        ['mountDir', '../escape'],
        ['envPassthrough', ['NOT-A-NAME']],
        ['kind', 'deploy'],
    ])('refuses an invalid %s, as the API does', (field, value) => {
        expect(acceptanceCheckSchema.safeParse({ ...base, [field]: value }).success).toBe(false);
    });

    it('accepts the API maximums for command, cwd and timeout (not lower web-only caps)', () => {
        expect(
            acceptanceCheckSchema.safeParse({
                ...base,
                command: 'x'.repeat(2000),
                cwd: 'd'.repeat(512),
                timeoutSec: 3600,
            }).success,
        ).toBe(true);
    });
});

describe('slugifyCheckId', () => {
    it('derives the id from the name', () => {
        expect(slugifyCheckId('Type check!')).toBe('type-check');
    });

    it('never produces an id the API refuses, even from a long name', () => {
        const id = slugifyCheckId('Run the full end to end Playwright suite on CI');
        expect(id.length).toBeLessThanOrEqual(41);
        expect(ACCEPTANCE_CHECK_ID_PATTERN.test(id)).toBe(true);
        expect(id.endsWith('-')).toBe(false);
    });
});
