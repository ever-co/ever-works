import {
    canDeleteLedgerRepo,
    demoRepoDeletionConfig,
    demoRepoTargetRefusal,
    type DemoRepoDeletionConfig,
} from '../demo-repo-deletion';

/**
 * Platform demo mode — the ONE decision that lets the demo sweeper delete a GitHub repository
 * (design §5.2.5). `ever-works-cloud` also holds real customers' repositories, so a ledger row
 * of the sandbox is deleted only when all of these hold: the owner is exactly
 * `DEMO_GITHUB_ORG` (which must be set), the name starts with `DEMO_REPO_PREFIX`, and the live
 * GitHub id equals the id the ledger recorded. A row with no recorded id is never deleted
 * (design §5.2 step 5.1, ruling R28). Anything else is refused.
 * The "row of this sandbox" condition is structural: the sweeper only ever reads the
 * sandbox's own pending rows.
 */

const CONFIG: DemoRepoDeletionConfig = { githubOrg: 'ever-works-cloud', repoPrefix: 'demo-' };
const ROW = { owner: 'ever-works-cloud', name: 'demo-1a2b3c4d-foo', githubId: 812345678 };

describe('canDeleteLedgerRepo', () => {
    it('deletes when the owner, the prefix and the live id all match the ledger', () => {
        expect(canDeleteLedgerRepo(ROW, 812345678, CONFIG)).toEqual({ delete: true });
    });

    it.each([null, undefined])(
        'refuses a row recorded without an id (%p): nothing pins the live repository to the one the sandbox created (R28)',
        (githubId) => {
            expect(
                canDeleteLedgerRepo({ ...ROW, githubId: githubId as null }, 812345678, CONFIG),
            ).toEqual({ delete: false, reason: 'no recorded id' });
        },
    );

    it('refuses a row without an id even when its live id would match anything', () => {
        for (const liveId of [1, 812345678, Number.MAX_SAFE_INTEGER]) {
            expect(canDeleteLedgerRepo({ ...ROW, githubId: null }, liveId, CONFIG)).toEqual({
                delete: false,
                reason: 'no recorded id',
            });
        }
    });

    it.each([
        ['another org', { ...ROW, owner: 'ever-works' }, 'owner mismatch'],
        ['the org in another case', { ...ROW, owner: 'Ever-Works-Cloud' }, 'owner mismatch'],
        ['the org with padding', { ...ROW, owner: ' ever-works-cloud' }, 'owner mismatch'],
        ['an empty owner', { ...ROW, owner: '' }, 'owner mismatch'],
        [
            'an anonymous visitor repository',
            { ...ROW, name: 'anon-1a2b3c4d-foo' },
            'name prefix mismatch',
        ],
        ['a customer repository', { ...ROW, name: 'acme-website' }, 'name prefix mismatch'],
        [
            'the prefix in another case',
            { ...ROW, name: 'Demo-1a2b3c4d-foo' },
            'name prefix mismatch',
        ],
        [
            'the prefix not at the start',
            { ...ROW, name: 'x-demo-1a2b3c4d' },
            'name prefix mismatch',
        ],
        ['an empty name', { ...ROW, name: '' }, 'name prefix mismatch'],
    ])('refuses %s', (_label, row, reason) => {
        expect(canDeleteLedgerRepo(row, 812345678, CONFIG)).toEqual({ delete: false, reason });
    });

    it('refuses a live repository whose id differs from the ledger (a later repository of the same name)', () => {
        expect(canDeleteLedgerRepo(ROW, 999, CONFIG)).toEqual({
            delete: false,
            reason: 'id mismatch',
        });
    });

    it.each([Number.NaN, 1.5, -0.5, Number.POSITIVE_INFINITY])(
        'refuses a live id that is not an integer (%p)',
        (liveId) => {
            expect(canDeleteLedgerRepo(ROW, liveId, CONFIG)).toEqual({
                delete: false,
                reason: 'id mismatch',
            });
        },
    );

    it('refuses everything when DEMO_GITHUB_ORG is not set', () => {
        const config = { ...CONFIG, githubOrg: '' };

        expect(canDeleteLedgerRepo(ROW, 812345678, config)).toEqual({
            delete: false,
            reason: 'DEMO_GITHUB_ORG not set',
        });
        expect(canDeleteLedgerRepo({ ...ROW, owner: '' }, 812345678, config)).toEqual({
            delete: false,
            reason: 'DEMO_GITHUB_ORG not set',
        });
    });

    it('refuses everything when the prefix is empty (every name would match)', () => {
        expect(canDeleteLedgerRepo(ROW, 812345678, { ...CONFIG, repoPrefix: '' })).toEqual({
            delete: false,
            reason: 'DEMO_REPO_PREFIX not set',
        });
    });

    it('follows a configured prefix', () => {
        const config = { ...CONFIG, repoPrefix: 'ewdemo-' };

        expect(canDeleteLedgerRepo({ ...ROW, name: 'ewdemo-1a2b-foo' }, 812345678, config)).toEqual(
            {
                delete: true,
            },
        );
        expect(canDeleteLedgerRepo(ROW, 812345678, config)).toEqual({
            delete: false,
            reason: 'name prefix mismatch',
        });
    });
});

describe('demoRepoTargetRefusal (the check before any GitHub call)', () => {
    it('answers null for a demo repository in the demo org', () => {
        expect(demoRepoTargetRefusal(ROW, CONFIG)).toBeNull();
    });

    it.each([
        [{ ...ROW, owner: 'ever-works' }, CONFIG, 'owner mismatch'],
        [{ ...ROW, name: 'anon-1a2b3c4d-foo' }, CONFIG, 'name prefix mismatch'],
        [ROW, { ...CONFIG, githubOrg: '' }, 'DEMO_GITHUB_ORG not set'],
        [ROW, { ...CONFIG, repoPrefix: '' }, 'DEMO_REPO_PREFIX not set'],
    ])('refuses %o under %o', (row, config, reason) => {
        expect(demoRepoTargetRefusal(row, config)).toBe(reason);
    });

    it('never looks at the id (no live id is known yet)', () => {
        expect(demoRepoTargetRefusal({ ...ROW, githubId: 1 }, CONFIG)).toBeNull();
        // A row with no id is still looked up: a repository already gone closes it.
        expect(demoRepoTargetRefusal({ ...ROW, githubId: null }, CONFIG)).toBeNull();
    });
});

describe('demoRepoDeletionConfig', () => {
    const saved = { org: process.env.DEMO_GITHUB_ORG, prefix: process.env.DEMO_REPO_PREFIX };

    afterEach(() => {
        for (const [key, value] of [
            ['DEMO_GITHUB_ORG', saved.org],
            ['DEMO_REPO_PREFIX', saved.prefix],
        ] as const) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it('reads DEMO_GITHUB_ORG and DEMO_REPO_PREFIX on every call', () => {
        process.env.DEMO_GITHUB_ORG = 'ever-works-cloud';
        delete process.env.DEMO_REPO_PREFIX;
        expect(demoRepoDeletionConfig()).toEqual({
            githubOrg: 'ever-works-cloud',
            repoPrefix: 'demo-',
        });

        process.env.DEMO_GITHUB_ORG = '';
        process.env.DEMO_REPO_PREFIX = 'ewdemo-';
        expect(demoRepoDeletionConfig()).toEqual({ githubOrg: '', repoPrefix: 'ewdemo-' });
    });
});
