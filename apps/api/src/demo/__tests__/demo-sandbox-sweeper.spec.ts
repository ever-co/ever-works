/**
 * Under api Jest the agent's `@src/notifications` imports (reached through the services
 * barrel) resolve to the API's notifications files, whose `AuthModule` loads better-auth's
 * ESM through this one file. Nothing here builds an auth runtime.
 */
jest.mock('../../auth/providers/auth-runtime.instance', () => ({
    createAuthRuntimeInstance: jest.fn(),
}));
/**
 * The sandbox purge removes the sandbox's uploaded files through the API's storage backend;
 * this spec is about the sweep, so the backend is a double that records the owner it is
 * asked about.
 */
const deleteAllByOwner = jest.fn(async () => ({ deleted: 0 }));
jest.mock('../../uploads/storage-backend.factory', () => ({
    getActiveStorageBackend: jest.fn(async () => ({ deleteAllByOwner })),
}));

import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CacheEntry } from '@ever-works/agent/entities';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import {
    DemoGithubRepoRepository,
    ENTITIES,
    MemoryFolderRepository,
    OrganizationRepository,
    TenantRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { withDemoSandboxLock } from '@ever-works/agent/demo';
import {
    AuthSession,
    DemoGithubRepo,
    DemoUsageCounter,
    MemoryFolder,
    Organization,
    OrganizationMember,
    Tenant,
    User,
    Work,
} from '@ever-works/agent/entities';
import type { EverWorksGitProvider } from '@ever-works/agent/ever-works-providers';
import { AnonymousUserCleanupService, type WorkLifecycleService } from '@ever-works/agent/services';
import { DemoSandboxPurgeService } from '../demo-sandbox-purge.service';
import {
    DEMO_SWEEPER_CRON,
    DEMO_SWEEPER_LOCK_KEY,
    DemoSandboxSweeperService,
} from '../demo-sandbox-sweeper.service';

/**
 * Platform demo mode — the demo sweeper (design §5.2.5, plan Task 10).
 *
 * For each expired demo sandbox, oldest first, 20 at a time:
 *   1. every pending ledger row of the sandbox: refused (warned, `attempts` + 1) unless the
 *      owner is `DEMO_GITHUB_ORG` and the name starts with `DEMO_REPO_PREFIX`;
 *   2. its live GitHub id: none (404) is "already gone"; an id that differs from the
 *      recorded one is refused; otherwise the repository is deleted and the row closed;
 *   3. only once no row of the sandbox is pending: its Works, its content, its Organization
 *      and Tenant, then the user;
 *   4. a sandbox with a row at 3 attempts is left for an operator.
 * One sandbox failing never stops the batch.
 *
 * Real SQLite tables (users, ledger, Works, Organization, Tenant, sessions …); GitHub is a
 * double of the provider's two calls. The sandbox's real seeded workspace is purged in
 * `demo-sandbox-purge.spec.ts`.
 */

const ORG = 'ever-works-cloud';
const NOW = new Date('2026-11-20T12:00:00.000Z');
const EXPIRED = new Date('2026-11-20T11:00:00.000Z');
const ALIVE = new Date('2026-11-21T11:00:00.000Z');

type GitDouble = { getRepositoryId: jest.Mock; deleteRepository: jest.Mock };

describe('DemoSandboxSweeperService', () => {
    const ORIGINAL_ENV = { ...process.env };
    let dataSource: DataSource;
    let users: UserRepository;
    let ledger: DemoGithubRepoRepository;
    let lock: DistributedTaskLockService;
    let git: GitDouble;
    let deleteWork: jest.Mock;
    let sweeper: DemoSandboxSweeperService;
    let serial = 0;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        users = new UserRepository(dataSource.getRepository(User));
        ledger = new DemoGithubRepoRepository(dataSource.getRepository(DemoGithubRepo));
        lock = new DistributedTaskLockService(dataSource.getRepository(CacheEntry));
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        for (const entity of [
            DemoGithubRepo,
            DemoUsageCounter,
            AuthSession,
            OrganizationMember,
            MemoryFolder,
            Work,
            Organization,
            Tenant,
            CacheEntry,
        ]) {
            await dataSource.getRepository(entity).clear();
        }
        await dataSource.createQueryBuilder().delete().from(User).execute();
        process.env = { ...ORIGINAL_ENV };
        process.env.DEMO = 'true';
        process.env.DEMO_GITHUB_ORG = ORG;
        delete process.env.DEMO_REPO_PREFIX;
        deleteAllByOwner.mockClear();

        git = {
            getRepositoryId: jest.fn(async () => null),
            deleteRepository: jest.fn(async () => 'deleted'),
        };
        // The Work delete path (`WorkLifecycleService.deleteWork`, repositories kept): here it
        // removes the row, as the real one does after its teardown.
        deleteWork = jest.fn(async (workId: string) => {
            await dataSource.getRepository(Work).delete({ id: workId });
            return { status: 'success' };
        });
        const cleanup = new AnonymousUserCleanupService(
            users,
            undefined,
            new MemoryFolderRepository(dataSource.getRepository(MemoryFolder)),
            new OrganizationRepository(dataSource.getRepository(Organization)),
            new TenantRepository(dataSource.getRepository(Tenant)),
        );
        const purge = new DemoSandboxPurgeService(
            dataSource,
            { deleteWork } as unknown as WorkLifecycleService,
            cleanup,
        );
        sweeper = new DemoSandboxSweeperService(
            users,
            ledger,
            git as unknown as EverWorksGitProvider,
            purge,
            lock,
        );
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        jest.restoreAllMocks();
    });

    /** A demo sandbox as `POST /api/auth/demo` + the seeder leave it: user, Tenant, Organization, a Work, a session. */
    async function sandbox(
        expiresAt: Date = EXPIRED,
    ): Promise<{ user: User; tenant: Tenant; organization: Organization }> {
        serial += 1;
        const hex = serial.toString(16).padStart(8, '0');
        const user = await users.create({
            username: `demo-${hex}`,
            displayName: 'Demo User',
            email: null,
            password: null,
            isAnonymous: true,
            anonymousExpiresAt: expiresAt,
            registrationProvider: 'demo',
            emailVerified: false,
            isActive: true,
        });
        const tenant = await dataSource.getRepository(Tenant).save(
            dataSource.getRepository(Tenant).create({
                ownerUserId: user.id,
                slug: `t-demo-${hex}`,
                displayName: 'Acme Studio (demo)',
            }),
        );
        await users.update(user.id, { tenantId: tenant.id });
        const organization = await dataSource.getRepository(Organization).save(
            dataSource.getRepository(Organization).create({
                tenantId: tenant.id,
                slug: `acme-studio-demo-${hex}`,
                displayName: 'Acme Studio',
            }),
        );
        await dataSource.getRepository(OrganizationMember).save(
            dataSource.getRepository(OrganizationMember).create({
                tenantId: tenant.id,
                organizationId: organization.id,
                userId: user.id,
                role: 'admin',
                joinedAt: expiresAt,
            }),
        );
        await dataSource.getRepository(Work).save(
            dataSource.getRepository(Work).create({
                slug: 'awesome-ai-coding-tools',
                name: 'Awesome AI Coding Tools',
                description: 'A directory',
                userId: user.id,
                tenantId: tenant.id,
                organizationId: organization.id,
            }),
        );
        await dataSource.getRepository(AuthSession).save({
            id: randomUUID(),
            userId: user.id,
            token: null,
            tokenHash: `hash-${hex}`,
            expiresAt,
        });
        return { user: (await users.findById(user.id)) as User, tenant, organization };
    }

    async function ledgerRow(
        sandboxUserId: string,
        name: string,
        githubId: number | null = 812345678,
        owner = ORG,
    ): Promise<DemoGithubRepo> {
        return ledger.record({ sandboxUserId, owner, name, githubId });
    }

    async function row(id: string): Promise<DemoGithubRepo> {
        return await dataSource.getRepository(DemoGithubRepo).findOneByOrFail({ id });
    }

    async function userExists(id: string): Promise<boolean> {
        return (await dataSource.getRepository(User).countBy({ id })) > 0;
    }

    it('deletes a demo-org, demo-prefixed repository whose live id matches, then purges the sandbox', async () => {
        const { user, tenant, organization } = await sandbox();
        const repo = await ledgerRow(user.id, 'demo-00000001-awesome-ai-coding-tools', 812345678);
        git.getRepositoryId.mockResolvedValue(812345678);

        const summary = await sweeper.sweep(NOW);

        expect(git.getRepositoryId).toHaveBeenCalledWith(
            ORG,
            'demo-00000001-awesome-ai-coding-tools',
        );
        expect(git.deleteRepository).toHaveBeenCalledWith(
            ORG,
            'demo-00000001-awesome-ai-coding-tools',
        );
        expect((await row(repo.id)).deletedAt).toEqual(NOW);
        expect(summary).toEqual({ sandboxes: 1, reposDeleted: 1, reposSkipped: 0, failures: 0 });
        // The Work went through the Work delete path, every repository kept (the ledger did them).
        expect(deleteWork).toHaveBeenCalledWith(
            expect.any(String),
            {
                delete_data_repository: false,
                delete_markdown_repository: false,
                delete_website_repository: false,
                delete_stored_data: true,
                confirm_slug: 'awesome-ai-coding-tools',
            },
            expect.objectContaining({ id: user.id }),
        );
        expect(await userExists(user.id)).toBe(false);
        expect(await dataSource.getRepository(Tenant).countBy({ id: tenant.id })).toBe(0);
        expect(await dataSource.getRepository(Organization).countBy({ id: organization.id })).toBe(
            0,
        );
        expect(
            await dataSource.getRepository(OrganizationMember).countBy({ userId: user.id }),
        ).toBe(0);
        expect(await dataSource.getRepository(AuthSession).countBy({ userId: user.id })).toBe(0);
        expect(await dataSource.getRepository(Work).countBy({ userId: user.id })).toBe(0);
        expect(deleteAllByOwner).toHaveBeenCalledWith(user.id);
    });

    it("removes the sandbox's AI quota counter with it, never the shared ones", async () => {
        const { user } = await sandbox();
        const counters = dataSource.getRepository(DemoUsageCounter);
        for (const key of [
            `ai:sandbox:${user.id}`,
            'ai:day:2026-11-20',
            'ai:sandbox:someone-else',
        ]) {
            await counters.save({ key, count: 3, windowEndsAt: ALIVE });
        }

        await sweeper.sweep(NOW);

        expect((await counters.find({ order: { key: 'ASC' } })).map((c) => c.key)).toEqual([
            'ai:day:2026-11-20',
            'ai:sandbox:someone-else',
        ]);
    });

    it('skips a repository of another owner and keeps the sandbox', async () => {
        const { user } = await sandbox();
        const repo = await ledgerRow(user.id, 'demo-00000001-foo', 812345678, 'ever-works');
        const warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        const summary = await sweeper.sweep(NOW);

        expect(git.getRepositoryId).not.toHaveBeenCalled();
        expect(git.deleteRepository).not.toHaveBeenCalled();
        expect(await row(repo.id)).toMatchObject({
            deletedAt: null,
            attempts: 1,
            lastError: 'owner mismatch',
        });
        expect(warnings).toHaveBeenCalledWith(
            expect.stringContaining('ever-works/demo-00000001-foo'),
        );
        expect(await userExists(user.id)).toBe(true);
        expect(summary).toEqual({ sandboxes: 0, reposDeleted: 0, reposSkipped: 1, failures: 0 });
    });

    it('skips a repository whose name lacks the demo prefix (anon-…) and keeps the sandbox', async () => {
        const { user } = await sandbox();
        const repo = await ledgerRow(user.id, 'anon-1a2b3c4d-foo');
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        const summary = await sweeper.sweep(NOW);

        expect(git.getRepositoryId).not.toHaveBeenCalled();
        expect(git.deleteRepository).not.toHaveBeenCalled();
        expect(await row(repo.id)).toMatchObject({
            deletedAt: null,
            attempts: 1,
            lastError: 'name prefix mismatch',
        });
        expect(await userExists(user.id)).toBe(true);
        expect(summary.reposSkipped).toBe(1);
    });

    it('skips a live repository whose id differs from the ledger, and keeps the sandbox', async () => {
        const { user } = await sandbox();
        const repo = await ledgerRow(user.id, 'demo-00000001-foo', 812345678);
        git.getRepositoryId.mockResolvedValue(999);
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        const summary = await sweeper.sweep(NOW);

        expect(git.deleteRepository).not.toHaveBeenCalled();
        expect(await row(repo.id)).toMatchObject({
            deletedAt: null,
            attempts: 1,
            lastError: 'id mismatch',
        });
        expect(await userExists(user.id)).toBe(true);
        expect(summary).toEqual({ sandboxes: 0, reposDeleted: 0, reposSkipped: 1, failures: 0 });
    });

    it('treats a 404 on lookup as already gone, and purges the sandbox', async () => {
        const { user } = await sandbox();
        const repo = await ledgerRow(user.id, 'demo-00000001-foo');
        git.getRepositoryId.mockResolvedValue(null);

        const summary = await sweeper.sweep(NOW);

        expect(git.deleteRepository).not.toHaveBeenCalled();
        expect((await row(repo.id)).deletedAt).toEqual(NOW);
        expect(await userExists(user.id)).toBe(false);
        expect(summary).toEqual({ sandboxes: 1, reposDeleted: 1, reposSkipped: 0, failures: 0 });
    });

    it('deletes a row recorded without an id (a git-facade create) on owner and prefix', async () => {
        const { user } = await sandbox();
        const repo = await ledgerRow(user.id, 'demo-00000001-foo-website', null);
        git.getRepositoryId.mockResolvedValue(77);

        await sweeper.sweep(NOW);

        expect(git.deleteRepository).toHaveBeenCalledWith(ORG, 'demo-00000001-foo-website');
        expect((await row(repo.id)).deletedAt).toEqual(NOW);
        expect(await userExists(user.id)).toBe(false);
    });

    it('records a failed delete, keeps that sandbox, and still sweeps the next one', async () => {
        const first = await sandbox();
        const second = await sandbox();
        const failing = await ledgerRow(first.user.id, 'demo-00000001-foo', 1);
        await ledgerRow(second.user.id, 'demo-00000002-foo', 2);
        git.getRepositoryId.mockImplementation(async (_owner: string, name: string) =>
            name === 'demo-00000001-foo' ? 1 : 2,
        );
        git.deleteRepository.mockImplementation(async (_owner: string, name: string) => {
            if (name === 'demo-00000001-foo') throw new Error('GitHub responded 403');
            return 'deleted';
        });
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

        const summary = await sweeper.sweep(NOW);

        expect(await row(failing.id)).toMatchObject({
            deletedAt: null,
            attempts: 1,
            lastError: 'GitHub responded 403',
        });
        expect(await userExists(first.user.id)).toBe(true);
        expect(await userExists(second.user.id)).toBe(false);
        expect(summary).toEqual({ sandboxes: 1, reposDeleted: 1, reposSkipped: 0, failures: 1 });
    });

    it('carries on with the batch when one sandbox throws outside its ledger rows', async () => {
        // Oldest first: `first` is swept first, and its ledger read is the one that throws.
        const first = await sandbox(new Date(EXPIRED.getTime() - 60_000));
        const second = await sandbox();
        jest.spyOn(ledger, 'pendingForSandbox').mockImplementationOnce(async () => {
            throw new Error('database is locked');
        });
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

        const summary = await sweeper.sweep(NOW);

        expect(await userExists(first.user.id)).toBe(true);
        expect(await userExists(second.user.id)).toBe(false);
        expect(summary).toMatchObject({ sandboxes: 1, failures: 1 });
    });

    it('leaves an unexpired demo sandbox untouched', async () => {
        const { user } = await sandbox(ALIVE);
        const repo = await ledgerRow(user.id, 'demo-00000001-foo');

        const summary = await sweeper.sweep(NOW);

        expect(git.getRepositoryId).not.toHaveBeenCalled();
        expect(git.deleteRepository).not.toHaveBeenCalled();
        expect(await row(repo.id)).toMatchObject({ deletedAt: null, attempts: 0 });
        expect(await userExists(user.id)).toBe(true);
        expect(deleteWork).not.toHaveBeenCalled();
        expect(summary).toEqual({ sandboxes: 0, reposDeleted: 0, reposSkipped: 0, failures: 0 });
    });

    it('never touches an expired anonymous visitor who is not a demo sandbox', async () => {
        const visitor = await users.create({
            username: 'anon-1a2b3c4d',
            isAnonymous: true,
            anonymousExpiresAt: EXPIRED,
            registrationProvider: 'anonymous',
        });
        await ledgerRow(visitor.id, 'demo-anon-foo');

        await sweeper.sweep(NOW);

        expect(git.getRepositoryId).not.toHaveBeenCalled();
        expect(await userExists(visitor.id)).toBe(true);
    });

    it('leaves a sandbox with a row at 3 attempts for an operator: logged with its id, no GitHub call', async () => {
        const { user } = await sandbox();
        const repo = await ledgerRow(user.id, 'demo-00000001-foo');
        await dataSource.getRepository(DemoGithubRepo).update({ id: repo.id }, { attempts: 3 });
        const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

        const summary = await sweeper.sweep(NOW);

        expect(git.getRepositoryId).not.toHaveBeenCalled();
        expect(git.deleteRepository).not.toHaveBeenCalled();
        expect(errors).toHaveBeenCalledWith(expect.stringContaining(user.id));
        expect(await userExists(user.id)).toBe(true);
        expect((await row(repo.id)).attempts).toBe(3);
        expect(summary).toEqual({ sandboxes: 0, reposDeleted: 0, reposSkipped: 0, failures: 1 });
    });

    it('logs at error level when a row reaches its third failure', async () => {
        const { user } = await sandbox();
        const repo = await ledgerRow(user.id, 'demo-00000001-foo');
        await dataSource.getRepository(DemoGithubRepo).update({ id: repo.id }, { attempts: 2 });
        git.getRepositoryId.mockRejectedValue(new Error('GitHub responded 502'));
        const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

        await sweeper.sweep(NOW);

        expect((await row(repo.id)).attempts).toBe(3);
        expect(errors).toHaveBeenCalledWith(
            expect.stringMatching(new RegExp(`${repo.id}.*${user.id}|${user.id}.*${repo.id}`)),
        );
    });

    it('refuses every deletion while DEMO_GITHUB_ORG is not set', async () => {
        process.env.DEMO_GITHUB_ORG = '';
        const { user } = await sandbox();
        const repo = await ledgerRow(user.id, 'demo-00000001-foo');
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        await sweeper.sweep(NOW);

        expect(git.getRepositoryId).not.toHaveBeenCalled();
        expect(git.deleteRepository).not.toHaveBeenCalled();
        expect(await row(repo.id)).toMatchObject({
            attempts: 1,
            lastError: 'DEMO_GITHUB_ORG not set',
        });
        expect(await userExists(user.id)).toBe(true);
    });

    it('calls GitHub only with the coordinates of ledger rows, never anything else', async () => {
        const a = await sandbox();
        const b = await sandbox();
        const c = await sandbox(ALIVE);
        const rows = [
            await ledgerRow(a.user.id, 'demo-00000001-foo', 11),
            await ledgerRow(a.user.id, 'demo-00000001-foo-website', null),
            await ledgerRow(a.user.id, 'acme-website', 12),
            await ledgerRow(b.user.id, 'demo-00000002-bar', 21, 'ever-works'),
            await ledgerRow(b.user.id, 'demo-00000002-bar-2', 22),
        ];
        await ledgerRow(c.user.id, 'demo-00000003-alive', 31);
        git.getRepositoryId.mockImplementation(async (_owner: string, name: string) => {
            const match = rows.find((entry) => entry.name === name);
            return match?.githubId ?? 1;
        });
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

        await sweeper.sweep(NOW);

        const expiredRows = rows.map((entry) => `${entry.owner}/${entry.name}`);
        const deletable = new Set([
            `${ORG}/demo-00000001-foo`,
            `${ORG}/demo-00000001-foo-website`,
            `${ORG}/demo-00000002-bar-2`,
        ]);
        for (const [owner, name] of git.getRepositoryId.mock.calls) {
            expect(expiredRows).toContain(`${owner}/${name}`);
        }
        const deleted = git.deleteRepository.mock.calls.map(([owner, name]) => `${owner}/${name}`);
        expect(new Set(deleted)).toEqual(deletable);
        expect(deleted).toHaveLength(deletable.size);
    });

    it('holds the sandbox lock while it sweeps, so a repository create of that sandbox waits for the purge', async () => {
        const { user } = await sandbox();
        await ledgerRow(user.id, 'demo-00000001-foo');
        const order: string[] = [];
        let lateCreate: Promise<void> | undefined;
        git.getRepositoryId.mockImplementation(async () => {
            // A create of this sandbox arriving mid-sweep (it takes the lock `createWork` and
            // Generate take).
            lateCreate = withDemoSandboxLock(user.id, async () => {
                order.push(`create sees user: ${await userExists(user.id)}`);
            });
            order.push('lookup');
            return null;
        });

        await sweeper.sweep(NOW);
        await lateCreate;

        // The create ran only once the whole sandbox was gone, never between the "no row
        // pending" check and the purge.
        expect(order).toEqual(['lookup', 'create sees user: false']);
    });

    it('deletes repositories but defers the purge while a generation of the sandbox is in flight', async () => {
        const { user } = await sandbox();
        await ledgerRow(user.id, 'demo-00000001-foo');
        await dataSource
            .getRepository(Work)
            .update({ userId: user.id }, { generationStartedAt: new Date(NOW.getTime() - 60_000) });

        const summary = await sweeper.sweep(NOW);

        expect(await userExists(user.id)).toBe(true);
        expect(deleteWork).not.toHaveBeenCalled();
        expect(summary).toEqual({ sandboxes: 0, reposDeleted: 1, reposSkipped: 0, failures: 0 });

        await dataSource
            .getRepository(Work)
            .update({ userId: user.id }, { generationFinishedAt: NOW });
        await sweeper.sweep(NOW);
        expect(await userExists(user.id)).toBe(false);
    });

    it('keeps a sandbox whose Tenant has another member, and sweeps the rest', async () => {
        const shared = await sandbox();
        const other = await sandbox();
        const operator = await users.create({
            username: 'operator',
            registrationProvider: 'local',
        });
        await users.update(operator.id, { tenantId: shared.tenant.id });
        const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

        const summary = await sweeper.sweep(NOW);

        expect(await userExists(shared.user.id)).toBe(true);
        expect(await dataSource.getRepository(Tenant).countBy({ id: shared.tenant.id })).toBe(1);
        expect(await userExists(operator.id)).toBe(true);
        expect(await userExists(other.user.id)).toBe(false);
        expect(errors).toHaveBeenCalledWith(expect.stringContaining(shared.user.id));
        expect(summary).toMatchObject({ sandboxes: 1, failures: 1 });
    });

    it('sweeps at most 20 sandboxes per run, oldest first', async () => {
        const created: User[] = [];
        for (let index = 0; index < 21; index += 1) {
            created.push((await sandbox(new Date(EXPIRED.getTime() - (21 - index) * 60_000))).user);
        }

        const summary = await sweeper.sweep(NOW);

        expect(summary.sandboxes).toBe(20);
        expect(await userExists(created[20].id)).toBe(true);
        expect(await userExists(created[0].id)).toBe(false);
    });

    describe('with the demo off', () => {
        beforeEach(() => {
            delete process.env.DEMO;
        });

        it('sweep touches nothing', async () => {
            const { user } = await sandbox();
            await ledgerRow(user.id, 'demo-00000001-foo');
            const findExpired = jest.spyOn(users, 'findExpiredDemo');

            const summary = await sweeper.sweep(NOW);

            expect(findExpired).not.toHaveBeenCalled();
            expect(git.getRepositoryId).not.toHaveBeenCalled();
            expect(await userExists(user.id)).toBe(true);
            expect(summary).toEqual({
                sandboxes: 0,
                reposDeleted: 0,
                reposSkipped: 0,
                failures: 0,
            });
        });
    });

    describe('handleCron', () => {
        it(`is scheduled every 15 minutes (${DEMO_SWEEPER_CRON})`, () => {
            expect(DEMO_SWEEPER_CRON).toBe('*/15 * * * *');
        });

        it(`runs the sweep under the distributed lock "${DEMO_SWEEPER_LOCK_KEY}"`, async () => {
            const run = jest.spyOn(lock, 'runExclusive');
            const sweep = jest.spyOn(sweeper, 'sweep');

            await sweeper.handleCron();

            expect(DEMO_SWEEPER_LOCK_KEY).toBe('demo-sandbox-sweeper');
            expect(run).toHaveBeenCalledWith(
                'demo-sandbox-sweeper',
                expect.any(Function),
                expect.objectContaining({ maxLifetimeMs: expect.any(Number) }),
            );
            expect(sweep).toHaveBeenCalledTimes(1);
        });

        it('does not sweep while another instance holds the lock', async () => {
            jest.spyOn(lock, 'runExclusive').mockResolvedValue({ acquired: false });
            const sweep = jest.spyOn(sweeper, 'sweep');

            await sweeper.handleCron();

            expect(sweep).not.toHaveBeenCalled();
        });

        it('never lets a failure escape the scheduler', async () => {
            jest.spyOn(lock, 'runExclusive').mockRejectedValue(new Error('database is locked'));
            jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

            await expect(sweeper.handleCron()).resolves.toBeUndefined();
        });
    });
});
