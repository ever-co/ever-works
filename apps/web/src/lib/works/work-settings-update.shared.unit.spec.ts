import { describe, expect, it } from 'vitest';
import type { GitProviderConnectionInfo } from '@/lib/api';
import {
    mayChooseRepositoryOwner,
    ownershipForSettingsSave,
    resolveRepositoryOwnership,
    workRegeneratesReadmeOnSave,
    workSupportsSourceSync,
} from './work-settings-update.shared';

const manager = { connected: true, username: 'manager-login' } as GitProviderConnectionInfo;

describe('workRegeneratesReadmeOnSave', () => {
    it.each(['repo', 'app', 'project'])(
        'is false for a %s Work — the API refuses update-readme for it',
        (kind) => {
            expect(workRegeneratesReadmeOnSave({ kind })).toBe(false);
        },
    );

    it.each([
        'directory',
        'website',
        'landing-page',
        'blog',
        'awesome-repo',
        'default',
        null,
        undefined,
    ])('is true for a %s Work', (kind) => {
        expect(workRegeneratesReadmeOnSave({ kind })).toBe(true);
    });
});

describe('workSupportsSourceSync', () => {
    it('is false for a linked existing repository, as before', () => {
        expect(workSupportsSourceSync({ kind: 'directory' }, 'link_existing')).toBe(false);
    });

    it.each(['app_link', 'app_fork', 'app_private_copy'])(
        'is false for an App Work (%s source) — the schedule API refuses App Works',
        (sourceType) => {
            expect(workSupportsSourceSync({ kind: 'app' }, sourceType)).toBe(false);
        },
    );

    it('is false for a Repository Work', () => {
        expect(workSupportsSourceSync({ kind: 'repo' }, 'fork')).toBe(false);
    });

    it('is true for an imported directory Work', () => {
        expect(workSupportsSourceSync({ kind: 'directory' }, 'fork')).toBe(true);
    });
});

describe('mayChooseRepositoryOwner', () => {
    it('allows choosing before the Work has generated (its repositories do not exist yet)', () => {
        expect(mayChooseRepositoryOwner({ kind: 'directory', generateStatus: null })).toBe(true);
        expect(mayChooseRepositoryOwner({ kind: 'directory' })).toBe(true);
    });

    it('refuses once the Work has generated — the form disables the fields too', () => {
        expect(
            mayChooseRepositoryOwner({
                kind: 'directory',
                generateStatus: { status: 'generated' },
            }),
        ).toBe(false);
    });

    it.each(['repo', 'app', 'project'])('refuses for a %s Work even before generation', (kind) => {
        expect(mayChooseRepositoryOwner({ kind, generateStatus: null })).toBe(false);
    });
});

describe('ownershipForSettingsSave', () => {
    it("leaves a generated personal Work's owner out of the save, whoever saves it", () => {
        // Before: `organization: false` → owner = the SAVER's login, so a
        // manager's rename moved a member's Work to the manager's account.
        expect(
            ownershipForSettingsSave(
                { kind: 'directory', generateStatus: { status: 'generated' } },
                manager,
                { owner: 'member-login', organization: false },
            ),
        ).toBeNull();
    });

    it('leaves the owner out for a chat rename (no owner / organization in the request)', () => {
        expect(
            ownershipForSettingsSave(
                { kind: 'directory', generateStatus: { status: 'generated' } },
                manager,
                {},
            ),
        ).toBeNull();
    });

    it("leaves a Repository Work's owner out — the API refuses any change to it", () => {
        expect(
            ownershipForSettingsSave({ kind: 'repo', generateStatus: null }, manager, {
                owner: 'repo-owner',
                organization: false,
            }),
        ).toBeNull();
    });

    it('still resolves the owner for a Work whose repositories do not exist yet', () => {
        expect(
            ownershipForSettingsSave({ kind: 'directory', generateStatus: null }, manager, {
                owner: 'acme',
                organization: true,
            }),
        ).toEqual({ organization: true, owner: 'acme' });
    });
});

describe('resolveRepositoryOwnership (unchanged create-path rule)', () => {
    it('uses the connected login for a personal Work', () => {
        expect(resolveRepositoryOwnership(manager, { organization: false })).toEqual({
            organization: false,
            owner: 'manager-login',
        });
    });

    it('keeps a named organization', () => {
        expect(
            resolveRepositoryOwnership(manager, { organization: true, owner: ' acme ' }),
        ).toEqual({
            organization: true,
            owner: 'acme',
        });
    });

    it('treats an organization named after the login as personal', () => {
        expect(
            resolveRepositoryOwnership(manager, { organization: true, owner: 'manager-login' }),
        ).toEqual({
            organization: false,
            owner: 'manager-login',
        });
    });

    it('passes the request through when no provider is connected', () => {
        expect(resolveRepositoryOwnership(null, { organization: true, owner: 'acme' })).toEqual({
            organization: true,
            owner: 'acme',
        });
    });
});
