// The `@ever-works/agent/{activity-log,generators}` barrels transitively
// import NestJS modules whose source uses the agent-side `@src/...` path
// alias — but the API jest config maps `@src/...` to `apps/api/src/...`
// (where those subdirectories do NOT exist). Stub the barrels to expose
// only the service classes we use as DI tokens. Class identity is
// preserved because both prod and test resolve to the same mocked module.
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
}));
jest.mock('@ever-works/monitoring', () => ({
    AnalyticsService: class AnalyticsService {},
}));
jest.mock('@ever-works/agent/generators', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));
jest.mock('@ever-works/agent/database', () => ({
    WorkRepository: class WorkRepository {},
}));
jest.mock('@ever-works/agent/config', () => ({
    config: {
        subscriptions: {
            dataSync: {
                getLockTtlSeconds: () => 300,
                getRetryBackoffSeconds: () => 300,
                getGenInProgressNoiseWindowMs: () => 900_000,
                getSkipNoiseWindowMs: () => 3_600_000,
            },
        },
    },
}));

import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ActivityActionType, CacheEntry, GenerateStatusType } from '@ever-works/agent/entities';
import { CACHE_MANAGER, DistributedTaskLockService } from '@ever-works/agent/cache';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { WorkRepository } from '@ever-works/agent/database';
import { MarkdownGeneratorService } from '@ever-works/agent/generators';
import { AnalyticsService } from '@ever-works/monitoring';
import { DataSyncService } from './data-sync.service';
import type { SyncSource } from './data-sync.types';

/**
 * Tests for {@link DataSyncService}.
 *
 * Coverage split:
 *   - `isLocked` — G2 (this file) — cache_entries peek paths.
 *   - `runDataSync` — G3 (this file) — three-gate body + outcome shape.
 *     The render gate calls into `MarkdownGeneratorService.syncFromDataRepo`
 *     and the activity-feed writes through `ActivityLogService.log` — both
 *     are mocked so the unit test focuses on the orchestration. The
 *     end-to-end Path A / Path B / lock-contention scenarios live in the
 *     Playwright spec (apps/web/e2e/data-sync.spec.ts) and the API e2e
 *     spec the dispatcher commit adds.
 */
describe('DataSyncService (EW-628)', () => {
    let service: DataSyncService;
    let taskLockService: jest.Mocked<DistributedTaskLockService>;
    let cacheEntryRepository: { findOne: jest.Mock };
    let cacheManager: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
    let activityLogService: { log: jest.Mock };
    let workRepository: { findById: jest.Mock; update: jest.Mock };
    let markdownGenerator: { syncFromDataRepo: jest.Mock; readDataRepoHeadSha: jest.Mock };
    let analyticsService: { track: jest.Mock };

    /**
     * Resolve `runExclusive` for the acquired path: invoke the callback,
     * return `{ acquired: true, result }`. For the contended path, call
     * `onLocked` once and return `{ acquired: false }`.
     */
    const stubLockServiceAcquired = () => {
        taskLockService.runExclusive.mockImplementation(async (_key, fn) => ({
            acquired: true,
            result: await fn(),
        }));
    };
    const stubLockServiceContended = () => {
        taskLockService.runExclusive.mockImplementation(async (_key, _fn, options) => {
            options?.onLocked?.();
            return { acquired: false };
        });
    };

    beforeEach(async () => {
        taskLockService = {
            runExclusive: jest.fn(),
        } as unknown as jest.Mocked<DistributedTaskLockService>;
        cacheEntryRepository = { findOne: jest.fn() };
        cacheManager = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
        activityLogService = { log: jest.fn().mockResolvedValue({}) };
        workRepository = {
            findById: jest.fn(),
            update: jest.fn().mockResolvedValue({}),
        };
        markdownGenerator = {
            syncFromDataRepo: jest.fn(),
            readDataRepoHeadSha: jest.fn().mockResolvedValue(undefined),
        };
        analyticsService = { track: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DataSyncService,
                { provide: DistributedTaskLockService, useValue: taskLockService },
                { provide: getRepositoryToken(CacheEntry), useValue: cacheEntryRepository },
                { provide: CACHE_MANAGER, useValue: cacheManager },
                { provide: ActivityLogService, useValue: activityLogService },
                { provide: WorkRepository, useValue: workRepository },
                { provide: MarkdownGeneratorService, useValue: markdownGenerator },
                { provide: AnalyticsService, useValue: analyticsService },
            ],
        }).compile();

        service = module.get(DataSyncService);
    });

    it('is provided as an injectable NestJS service', () => {
        expect(service).toBeInstanceOf(DataSyncService);
    });

    describe('isLocked', () => {
        it('returns false when no cache_entries row exists for the work', async () => {
            cacheEntryRepository.findOne.mockResolvedValueOnce(null);

            await expect(service.isLocked('work-123')).resolves.toBe(false);
            expect(cacheEntryRepository.findOne).toHaveBeenCalledWith({
                where: { key: 'task-lock:data-sync:work-123' },
                select: ['key', 'expiresAt'],
            });
        });

        it('returns true when a row exists with expiresAt in the future', async () => {
            const future = Date.now() + 60_000;
            cacheEntryRepository.findOne.mockResolvedValueOnce({
                key: 'task-lock:data-sync:work-456',
                expiresAt: future,
            });

            await expect(service.isLocked('work-456')).resolves.toBe(true);
        });

        it('returns false when the row exists but expiresAt is in the past (stale lock)', async () => {
            const past = Date.now() - 60_000;
            cacheEntryRepository.findOne.mockResolvedValueOnce({
                key: 'task-lock:data-sync:work-789',
                expiresAt: past,
            });

            await expect(service.isLocked('work-789')).resolves.toBe(false);
        });

        it('returns true (defensive) when expiresAt is null — no TTL set means treat as held', async () => {
            cacheEntryRepository.findOne.mockResolvedValueOnce({
                key: 'task-lock:data-sync:work-ttlless',
                expiresAt: null,
            });

            await expect(service.isLocked('work-ttlless')).resolves.toBe(true);
        });

        it('does not invoke the task-lock service (peek-only, no acquire)', async () => {
            cacheEntryRepository.findOne.mockResolvedValueOnce(null);

            await service.isLocked('work-peek-only');
            expect(taskLockService.runExclusive).not.toHaveBeenCalled();
        });
    });

    describe('runDataSync — lock contention (no body run)', () => {
        const sources: SyncSource[] = ['webhook', 'poll', 'manual'];

        it.each(sources)(
            'returns skipped:sync-in-progress when the lock cannot be acquired (source=%s)',
            async (source) => {
                stubLockServiceContended();

                await expect(service.runDataSync('work-busy', source)).resolves.toEqual({
                    status: 'skipped',
                    reason: 'sync-in-progress',
                });
                // onLocked emits the activity row.
                expect(activityLogService.log).toHaveBeenCalledWith(
                    expect.objectContaining({
                        actionType: ActivityActionType.DATA_SYNC_SKIPPED,
                        details: expect.objectContaining({ reason: 'sync-in-progress', source }),
                    }),
                );
                expect(markdownGenerator.syncFromDataRepo).not.toHaveBeenCalled();
            },
        );
    });

    describe('runDataSync — three gates inside the lock', () => {
        beforeEach(() => stubLockServiceAcquired());

        it('Gate 1: returns skipped:retry-backoff when the retry-after cache key is set', async () => {
            cacheManager.get.mockImplementation(async (key: string) =>
                key === 'data-sync:retry-after:work-1' ? '1' : null,
            );

            await expect(service.runDataSync('work-1', 'webhook')).resolves.toEqual({
                status: 'skipped',
                reason: 'retry-backoff',
            });
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.DATA_SYNC_SKIPPED,
                    details: expect.objectContaining({ reason: 'retry-backoff' }),
                }),
            );
            // Pipeline-RUNNING gate (Gate 2) is not exercised — markdown generator
            // is never invoked even though `findById` runs once for the row lookup
            // shared with the activity-row attribution.
            expect(markdownGenerator.syncFromDataRepo).not.toHaveBeenCalled();
        });

        it('Gate 2: returns skipped:generation-in-progress when work.generateStatus === GENERATING, and rate-limits the noise row', async () => {
            cacheManager.get.mockResolvedValue(null); // no backoff, no recent noise.
            workRepository.findById.mockResolvedValue({
                id: 'work-2',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATING },
            });

            await expect(service.runDataSync('work-2', 'poll')).resolves.toEqual({
                status: 'skipped',
                reason: 'generation-in-progress',
            });
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.DATA_SYNC_SKIPPED,
                    details: expect.objectContaining({ reason: 'generation-in-progress' }),
                }),
            );
            expect(cacheManager.set).toHaveBeenCalledWith(
                'data-sync:gen-in-progress-noise:work-2',
                '1',
                expect.any(Number),
            );
            expect(markdownGenerator.syncFromDataRepo).not.toHaveBeenCalled();
        });

        it('Gate 2: does NOT re-emit the skip row when the noise window is active (still returns skipped)', async () => {
            cacheManager.get.mockImplementation(async (key: string) =>
                key.startsWith('data-sync:gen-in-progress-noise:') ? '1' : null,
            );
            workRepository.findById.mockResolvedValue({
                id: 'work-noise',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATING },
            });

            const outcome = await service.runDataSync('work-noise', 'poll');
            expect(outcome).toEqual({ status: 'skipped', reason: 'generation-in-progress' });
            expect(activityLogService.log).not.toHaveBeenCalled();
        });

        it('Gate 3 success: calls markdown generator, updates the Work, clears noise window, emits success row', async () => {
            cacheManager.get.mockResolvedValue(null);
            workRepository.findById.mockResolvedValue({
                id: 'work-ok',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATED },
            });
            markdownGenerator.syncFromDataRepo.mockResolvedValue({
                beforeSha: 'aaa1111',
                afterSha: 'bbb2222',
                filesChanged: 3,
                durationMs: 1234,
            });

            await expect(service.runDataSync('work-ok', 'webhook')).resolves.toEqual({
                status: 'success',
                stats: {
                    beforeSha: 'aaa1111',
                    afterSha: 'bbb2222',
                    filesChanged: 3,
                    durationMs: 1234,
                },
            });
            expect(markdownGenerator.syncFromDataRepo).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'work-ok' }),
                expect.objectContaining({ id: 'owner-1' }),
                expect.any(Object),
            );
            expect(workRepository.update).toHaveBeenCalledWith(
                'work-ok',
                expect.objectContaining({
                    lastSyncedDataRepoSha: 'bbb2222',
                    pendingSyncRequestedAt: null,
                    lastPolledAt: expect.any(Date),
                }),
            );
            expect(cacheManager.del).toHaveBeenCalledWith(
                'data-sync:gen-in-progress-noise:work-ok',
            );
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.DATA_SYNC_SUCCESS,
                    details: expect.objectContaining({
                        source: 'webhook',
                        afterSha: 'bbb2222',
                        filesChanged: 3,
                    }),
                }),
            );
        });

        it('Gate 3 failed: catches render errors, sets retry-after cache, emits failed row, never throws', async () => {
            cacheManager.get.mockResolvedValue(null);
            workRepository.findById.mockResolvedValue({
                id: 'work-fail',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATED },
            });
            const renderError = Object.assign(new Error('GitHub 404 Not Found'), {
                stderr: 'remote: Repository not found.',
            });
            markdownGenerator.syncFromDataRepo.mockRejectedValue(renderError);

            const outcome = await service.runDataSync('work-fail', 'webhook');
            expect(outcome).toMatchObject({
                status: 'failed',
                errorClass: 'data-repo-unreachable',
            });
            expect(outcome).toHaveProperty('errorTail');
            expect(workRepository.update).not.toHaveBeenCalled(); // No success write.
            expect(cacheManager.set).toHaveBeenCalledWith(
                'data-sync:retry-after:work-fail',
                '1',
                expect.any(Number),
            );
            expect(activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.DATA_SYNC_FAILED,
                    details: expect.objectContaining({
                        errorClass: 'data-repo-unreachable',
                        source: 'webhook',
                    }),
                }),
            );
        });

        it('Gate 3 failed: maps push-rejected errors to errorClass main-repo-push-rejected', async () => {
            cacheManager.get.mockResolvedValue(null);
            workRepository.findById.mockResolvedValue({
                id: 'work-pushfail',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATED },
            });
            markdownGenerator.syncFromDataRepo.mockRejectedValue(
                new Error('push rejected: non-fast-forward'),
            );

            const outcome = await service.runDataSync('work-pushfail', 'manual');
            expect(outcome).toMatchObject({
                status: 'failed',
                errorClass: 'main-repo-push-rejected',
            });
        });

        it('Gate 3 failed: logs the error class and message, not just the class', async () => {
            const warnSpy = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            cacheManager.get.mockResolvedValue(null);
            workRepository.findById.mockResolvedValue({
                id: 'work-logged',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATED },
            });
            markdownGenerator.syncFromDataRepo.mockRejectedValue(
                new Error(
                    'something odd happened in https://x-access-token:ghs_secret@github.com/acme/repo',
                ),
            );

            const outcome = await service.runDataSync('work-logged', 'poll');

            expect(outcome).toMatchObject({ status: 'failed', errorClass: 'unknown' });
            const logged = warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
            expect(logged).toContain('work=work-logged');
            expect(logged).toContain('class=unknown');
            expect(logged).toContain('something odd happened');
            // The credential in the remote URL never reaches the log.
            expect(logged).not.toContain('ghs_secret');
            warnSpy.mockRestore();
        });

        describe('nothing to sync (skipped on purpose, no failure row)', () => {
            const generatedWork = (id: string) => ({
                id,
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATED },
            });

            it('data repository without data/: skipped:data-repo-empty, Work stamped, one rate-limited skip row, no backoff', async () => {
                cacheManager.get.mockResolvedValue(null);
                workRepository.findById.mockResolvedValue(generatedWork('work-empty'));
                markdownGenerator.syncFromDataRepo.mockResolvedValue({
                    skipped: 'no-data',
                    filesChanged: 0,
                    durationMs: 12,
                });

                await expect(service.runDataSync('work-empty', 'poll')).resolves.toEqual({
                    status: 'skipped',
                    reason: 'data-repo-empty',
                });

                expect(workRepository.update).toHaveBeenCalledTimes(1);
                expect(workRepository.update).toHaveBeenCalledWith('work-empty', {
                    pendingSyncRequestedAt: null,
                    lastPolledAt: expect.any(Date),
                });
                expect(activityLogService.log).toHaveBeenCalledTimes(1);
                expect(activityLogService.log).toHaveBeenCalledWith(
                    expect.objectContaining({
                        actionType: ActivityActionType.DATA_SYNC_SKIPPED,
                        details: expect.objectContaining({
                            reason: 'data-repo-empty',
                            source: 'poll',
                        }),
                    }),
                );
                expect(cacheManager.set).toHaveBeenCalledWith(
                    'data-sync:skip-noise:data-repo-empty:work-empty',
                    '1',
                    3_600_000,
                );
                expect(cacheManager.set).not.toHaveBeenCalledWith(
                    'data-sync:retry-after:work-empty',
                    expect.anything(),
                    expect.anything(),
                );
            });

            it('data repository without data/: no second skip row inside the noise window', async () => {
                cacheManager.get.mockImplementation(async (key: string) =>
                    key === 'data-sync:skip-noise:data-repo-empty:work-empty' ? '1' : null,
                );
                workRepository.findById.mockResolvedValue(generatedWork('work-empty'));
                markdownGenerator.syncFromDataRepo.mockResolvedValue({
                    skipped: 'no-data',
                    filesChanged: 0,
                    durationMs: 12,
                });

                await expect(service.runDataSync('work-empty', 'poll')).resolves.toEqual({
                    status: 'skipped',
                    reason: 'data-repo-empty',
                });
                expect(activityLogService.log).not.toHaveBeenCalled();
                expect(workRepository.update).toHaveBeenCalledWith(
                    'work-empty',
                    expect.objectContaining({ pendingSyncRequestedAt: null }),
                );
            });

            it('owner without a connected git account: skipped:app-not-installed-and-no-credentials, no failure row, no backoff', async () => {
                const warnSpy = jest
                    .spyOn(Logger.prototype, 'warn')
                    .mockImplementation(() => undefined);
                cacheManager.get.mockResolvedValue(null);
                workRepository.findById.mockResolvedValue(generatedWork('work-nocreds'));
                const noCredentials = new Error(
                    'No connected account found for user owner-1 with provider github',
                );
                noCredentials.name = 'NoGitCredentialsError';
                markdownGenerator.syncFromDataRepo.mockRejectedValue(noCredentials);

                await expect(service.runDataSync('work-nocreds', 'poll')).resolves.toEqual({
                    status: 'skipped',
                    reason: 'app-not-installed-and-no-credentials',
                });

                expect(activityLogService.log).toHaveBeenCalledTimes(1);
                expect(activityLogService.log).toHaveBeenCalledWith(
                    expect.objectContaining({
                        actionType: ActivityActionType.DATA_SYNC_SKIPPED,
                        details: expect.objectContaining({
                            reason: 'app-not-installed-and-no-credentials',
                        }),
                    }),
                );
                expect(activityLogService.log).not.toHaveBeenCalledWith(
                    expect.objectContaining({ actionType: ActivityActionType.DATA_SYNC_FAILED }),
                );
                expect(cacheManager.set).not.toHaveBeenCalledWith(
                    'data-sync:retry-after:work-nocreds',
                    expect.anything(),
                    expect.anything(),
                );
                expect(warnSpy.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
                    'No connected account found for user owner-1 with provider github',
                );
                warnSpy.mockRestore();
            });
        });

        // The poller re-rendered, committed and pushed every Work every 5 min
        // (prod 2026-11-20: 4,382 files per poll for one Work). A poll whose
        // data-repo HEAD equals `lastSyncedDataRepoSha` now ends before the
        // render (spec §5.2).
        describe('data-repo HEAD pre-check (poll)', () => {
            const syncedWork = (
                id: string,
                lastSyncedDataRepoSha: string | null = 'sha-synced',
            ) => ({
                id,
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATED },
                lastSyncedDataRepoSha,
            });
            const renderStats = {
                beforeSha: 'sha-synced',
                afterSha: 'sha-new',
                filesChanged: 4,
                durationMs: 50,
            };

            it('HEAD unchanged: skipped:no-changes, no render, Work stamped, one rate-limited skip row, no backoff', async () => {
                cacheManager.get.mockResolvedValue(null);
                workRepository.findById.mockResolvedValue(syncedWork('work-same'));
                markdownGenerator.readDataRepoHeadSha.mockResolvedValue('sha-synced');

                await expect(service.runDataSync('work-same', 'poll')).resolves.toEqual({
                    status: 'skipped',
                    reason: 'no-changes',
                });

                expect(markdownGenerator.readDataRepoHeadSha).toHaveBeenCalledWith(
                    expect.objectContaining({ id: 'work-same' }),
                );
                expect(markdownGenerator.syncFromDataRepo).not.toHaveBeenCalled();
                expect(workRepository.update).toHaveBeenCalledTimes(1);
                expect(workRepository.update).toHaveBeenCalledWith('work-same', {
                    pendingSyncRequestedAt: null,
                    lastPolledAt: expect.any(Date),
                });
                expect(activityLogService.log).toHaveBeenCalledTimes(1);
                expect(activityLogService.log).toHaveBeenCalledWith(
                    expect.objectContaining({
                        actionType: ActivityActionType.DATA_SYNC_SKIPPED,
                        summary: 'Sync skipped: no-changes',
                        details: { kind: 'skipped', source: 'poll', reason: 'no-changes' },
                    }),
                );
                expect(cacheManager.set).toHaveBeenCalledWith(
                    'data-sync:skip-noise:no-changes:work-same',
                    '1',
                    3_600_000,
                );
                expect(cacheManager.set).not.toHaveBeenCalledWith(
                    'data-sync:retry-after:work-same',
                    expect.anything(),
                    expect.anything(),
                );
            });

            it('HEAD unchanged inside the noise window: no second skip row, Work still stamped', async () => {
                cacheManager.get.mockImplementation(async (key: string) =>
                    key === 'data-sync:skip-noise:no-changes:work-same' ? '1' : null,
                );
                workRepository.findById.mockResolvedValue(syncedWork('work-same'));
                markdownGenerator.readDataRepoHeadSha.mockResolvedValue('sha-synced');

                await expect(service.runDataSync('work-same', 'poll')).resolves.toEqual({
                    status: 'skipped',
                    reason: 'no-changes',
                });

                expect(markdownGenerator.syncFromDataRepo).not.toHaveBeenCalled();
                expect(activityLogService.log).not.toHaveBeenCalled();
                expect(cacheManager.set).not.toHaveBeenCalled();
                expect(workRepository.update).toHaveBeenCalledWith('work-same', {
                    pendingSyncRequestedAt: null,
                    lastPolledAt: expect.any(Date),
                });
            });

            it('HEAD moved: renders against it (expectedSourceSha) and records the rendered SHA', async () => {
                cacheManager.get.mockResolvedValue(null);
                workRepository.findById.mockResolvedValue(syncedWork('work-moved'));
                markdownGenerator.readDataRepoHeadSha.mockResolvedValue('sha-new');
                markdownGenerator.syncFromDataRepo.mockResolvedValue(renderStats);

                await expect(service.runDataSync('work-moved', 'poll')).resolves.toMatchObject({
                    status: 'success',
                    stats: { afterSha: 'sha-new', filesChanged: 4 },
                });

                expect(markdownGenerator.syncFromDataRepo).toHaveBeenCalledWith(
                    expect.objectContaining({ id: 'work-moved' }),
                    expect.objectContaining({ id: 'owner-1' }),
                    { expectedSourceSha: 'sha-new' },
                );
                expect(workRepository.update).toHaveBeenCalledWith(
                    'work-moved',
                    expect.objectContaining({ lastSyncedDataRepoSha: 'sha-new' }),
                );
            });

            it('first sync (no SHA recorded yet): renders', async () => {
                cacheManager.get.mockResolvedValue(null);
                workRepository.findById.mockResolvedValue(syncedWork('work-first', null));
                markdownGenerator.readDataRepoHeadSha.mockResolvedValue('sha-first');
                markdownGenerator.syncFromDataRepo.mockResolvedValue({
                    ...renderStats,
                    beforeSha: undefined,
                    afterSha: 'sha-first',
                });

                await expect(service.runDataSync('work-first', 'poll')).resolves.toMatchObject({
                    status: 'success',
                });
                expect(markdownGenerator.syncFromDataRepo).toHaveBeenCalledWith(
                    expect.anything(),
                    expect.anything(),
                    { expectedSourceSha: 'sha-first' },
                );
            });

            it('HEAD read fails (provider error): renders as before, without an expected SHA', async () => {
                cacheManager.get.mockResolvedValue(null);
                workRepository.findById.mockResolvedValue(syncedWork('work-flaky'));
                markdownGenerator.readDataRepoHeadSha.mockRejectedValue(
                    new Error('HTTP Error: 502 Bad Gateway'),
                );
                markdownGenerator.syncFromDataRepo.mockResolvedValue(renderStats);

                await expect(service.runDataSync('work-flaky', 'poll')).resolves.toMatchObject({
                    status: 'success',
                });
                expect(markdownGenerator.syncFromDataRepo).toHaveBeenCalledWith(
                    expect.anything(),
                    expect.anything(),
                    { expectedSourceSha: undefined },
                );
                expect(activityLogService.log).not.toHaveBeenCalledWith(
                    expect.objectContaining({ actionType: ActivityActionType.DATA_SYNC_FAILED }),
                );
            });

            it('HEAD read without git credentials: skipped:app-not-installed-and-no-credentials, no render', async () => {
                const warnSpy = jest
                    .spyOn(Logger.prototype, 'warn')
                    .mockImplementation(() => undefined);
                cacheManager.get.mockResolvedValue(null);
                workRepository.findById.mockResolvedValue(syncedWork('work-nocreds'));
                const noCredentials = new Error(
                    'No connected account found for user owner-1 with provider github',
                );
                noCredentials.name = 'NoGitCredentialsError';
                markdownGenerator.readDataRepoHeadSha.mockRejectedValue(noCredentials);

                await expect(service.runDataSync('work-nocreds', 'poll')).resolves.toEqual({
                    status: 'skipped',
                    reason: 'app-not-installed-and-no-credentials',
                });
                expect(markdownGenerator.syncFromDataRepo).not.toHaveBeenCalled();
                expect(activityLogService.log).not.toHaveBeenCalledWith(
                    expect.objectContaining({ actionType: ActivityActionType.DATA_SYNC_FAILED }),
                );
                warnSpy.mockRestore();
            });

            it.each<SyncSource>(['manual', 'webhook'])(
                '%s sync with an unchanged HEAD still renders',
                async (source) => {
                    cacheManager.get.mockResolvedValue(null);
                    workRepository.findById.mockResolvedValue(syncedWork('work-forced'));
                    markdownGenerator.readDataRepoHeadSha.mockResolvedValue('sha-synced');
                    markdownGenerator.syncFromDataRepo.mockResolvedValue({
                        ...renderStats,
                        afterSha: 'sha-synced',
                    });

                    await expect(service.runDataSync('work-forced', source)).resolves.toMatchObject(
                        {
                            status: 'success',
                        },
                    );
                    expect(markdownGenerator.syncFromDataRepo).toHaveBeenCalledWith(
                        expect.objectContaining({ id: 'work-forced' }),
                        expect.anything(),
                        { expectedSourceSha: 'sha-synced' },
                    );
                    expect(activityLogService.log).not.toHaveBeenCalledWith(
                        expect.objectContaining({
                            details: expect.objectContaining({ reason: 'no-changes' }),
                        }),
                    );
                },
            );

            it('runs after the pipeline-running gate: a generating Work is not even read', async () => {
                cacheManager.get.mockResolvedValue(null);
                workRepository.findById.mockResolvedValue({
                    ...syncedWork('work-gen'),
                    generateStatus: { status: GenerateStatusType.GENERATING },
                });

                await expect(service.runDataSync('work-gen', 'poll')).resolves.toEqual({
                    status: 'skipped',
                    reason: 'generation-in-progress',
                });
                expect(markdownGenerator.readDataRepoHeadSha).not.toHaveBeenCalled();
            });
        });

        it('Gate 2 work-not-found: returns failed:work-not-found when the row is missing', async () => {
            cacheManager.get.mockResolvedValue(null);
            workRepository.findById.mockResolvedValue(null);

            const outcome = await service.runDataSync('work-ghost', 'poll');
            expect(outcome).toMatchObject({
                status: 'failed',
                errorClass: 'work-not-found',
            });
            expect(markdownGenerator.syncFromDataRepo).not.toHaveBeenCalled();
            expect(workRepository.update).not.toHaveBeenCalled();
        });
    });

    // EW-628 G10 — telemetry counter increments via the optional
    // AnalyticsService. Names locked by DATA_SYNC_METRICS in
    // packages/agent/src/cache/data-sync-metrics.ts and the Phase 8
    // contract spec (data-sync-metrics.spec.ts).
    describe('telemetry counters (EW-628 G10)', () => {
        beforeEach(() => stubLockServiceAcquired());

        it('lock contention emits data_sync_lock_contention_total once with the source label', async () => {
            stubLockServiceContended();
            await service.runDataSync('work-busy', 'webhook');
            expect(analyticsService.track).toHaveBeenCalledWith(
                'work-busy',
                'data_sync_lock_contention_total',
                expect.objectContaining({ source: 'webhook' }),
            );
        });

        it('success emits data_sync_success_total + data_sync_duration_ms with stats labels', async () => {
            cacheManager.get.mockResolvedValue(null);
            workRepository.findById.mockResolvedValue({
                id: 'w-ok',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATED },
            });
            markdownGenerator.syncFromDataRepo.mockResolvedValue({
                afterSha: 'sha-x',
                filesChanged: 4,
                durationMs: 250,
            });

            await service.runDataSync('w-ok', 'manual');

            expect(analyticsService.track).toHaveBeenCalledWith('w-ok', 'data_sync_success_total', {
                source: 'manual',
            });
            expect(analyticsService.track).toHaveBeenCalledWith(
                'w-ok',
                'data_sync_duration_ms',
                expect.objectContaining({ source: 'manual', value: 250, filesChanged: 4 }),
            );
        });

        it('skipped emits data_sync_skipped_total with reason + source labels', async () => {
            cacheManager.get.mockImplementation(async (key: string) =>
                key === 'data-sync:retry-after:w-skip' ? '1' : null,
            );

            await service.runDataSync('w-skip', 'poll');

            expect(analyticsService.track).toHaveBeenCalledWith(
                'w-skip',
                'data_sync_skipped_total',
                expect.objectContaining({ source: 'poll', reason: 'retry-backoff' }),
            );
        });

        it('failed emits data_sync_failed_total with errorClass + source labels (errorTail not sent)', async () => {
            cacheManager.get.mockResolvedValue(null);
            workRepository.findById.mockResolvedValue({
                id: 'w-fail',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATED },
            });
            markdownGenerator.syncFromDataRepo.mockRejectedValue(
                Object.assign(new Error('404 Not Found'), {
                    stderr: 'remote: Repository not found.',
                }),
            );

            await service.runDataSync('w-fail', 'webhook');

            const failCall = analyticsService.track.mock.calls.find(
                (c) => c[1] === 'data_sync_failed_total',
            );
            expect(failCall).toBeDefined();
            expect(failCall![0]).toBe('w-fail');
            expect(failCall![2]).toEqual({
                source: 'webhook',
                errorClass: 'data-repo-unreachable',
            });
            // errorTail (potentially PII / high-cardinality) must NOT leak into PostHog.
            expect(failCall![2]).not.toHaveProperty('errorTail');
        });

        it('telemetry failures never break the sync path', async () => {
            analyticsService.track.mockImplementation(() => {
                throw new Error('PostHog down');
            });
            cacheManager.get.mockResolvedValue(null);
            workRepository.findById.mockResolvedValue({
                id: 'w-resilient',
                user: { id: 'owner-1' },
                generateStatus: { status: GenerateStatusType.GENERATED },
            });
            markdownGenerator.syncFromDataRepo.mockResolvedValue({
                afterSha: 'sha-y',
                filesChanged: 1,
                durationMs: 10,
            });

            const outcome = await service.runDataSync('w-resilient', 'webhook');
            expect(outcome.status).toBe('success');
        });
    });
});
