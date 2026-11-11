import { DataSource, type Repository } from 'typeorm';
import type { GitPullRequestStatus } from '@ever-works/plugin';
import { ENTITIES } from '../_entities-inventory';
import { Task, TaskPriority, TaskStatus } from '../../entities/task.entity';
import type { GitFacadeService } from '../../facades/git.facade';
import { TASK_PR_NOT_FOUND_STATE } from '../../tasks-domain/task-open-work';
import { TaskPrStatusService } from '../../tasks-domain/task-pr-status.service';
import type { WorkRepository } from './work.repository';
import { TaskRepository } from './task.repository';

/**
 * Branch GC candidates (`TaskRepository.findBranchCleanupCandidates`) on REAL better-sqlite3,
 * once the PR-status sweep's writes keep `updatedAt`.
 *
 * The GC deletes the remote branch of an "abandoned" Task, and deleting the head branch of an
 * open pull request closes it. Abandoned used to mean "`updatedAt` older than the cutoff", and
 * every sweep read bumped `updatedAt`, so an open pull request the sweep kept reading was never
 * abandoned. The sweep's writes (`updatePrStatusCache`, `recordCiHead`) now keep `updatedAt`, so
 * the GC reads their own stamps (`ciCheckedAt`, `ciHeadSeenAt`) instead. Every stamp here goes
 * through those two writes, as in production.
 */
describe('TaskRepository.findBranchCleanupCandidates (real SQLite)', () => {
    let dataSource: DataSource;
    let taskRows: Repository<Task>;
    let repository: TaskRepository;
    let slugSeq = 0;

    const OWNER = '11111111-1111-4111-8111-111111111111';
    const WORK = '33333333-3333-4333-8333-333333333333';
    const STALE_DAYS = 14;
    const DAY = 24 * 60 * 60 * 1000;
    const ago = (ms: number) => new Date(Date.now() - ms);

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        taskRows = dataSource.getRepository(Task);
        repository = new TaskRepository(taskRows);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        await taskRows.clear();
    });

    /** A Task with a live branch and an open pull request, last changed `updatedAt`. */
    async function openPrTask(updatedAt: Date, over: Partial<Task> = {}): Promise<Task> {
        slugSeq += 1;
        const row = await taskRows.save(
            taskRows.create({
                userId: OWNER,
                slug: `T-${slugSeq}`,
                title: 'Waiting for review',
                status: TaskStatus.IN_REVIEW,
                priority: TaskPriority.P3,
                createdByType: 'user',
                createdById: OWNER,
                workId: WORK,
                branchRef: `task/t-${slugSeq}`,
                branchState: 'pr-open',
                prNumber: slugSeq,
                prState: 'open',
                ...over,
            } as Partial<Task>),
        );
        // The update builder would set `updatedAt` to now unless the SET names it.
        await taskRows
            .createQueryBuilder()
            .update(Task)
            .set({ createdAt: updatedAt, updatedAt })
            .where('id = :id', { id: row.id })
            .execute();
        return row;
    }

    const candidateIds = async () =>
        (await repository.findBranchCleanupCandidates(STALE_DAYS)).map((task) => task.id).sort();

    /** The real PR-status sweep against a provider that answers `status` (`null` = "not found"). */
    async function sweepWithProvider(status: GitPullRequestStatus | null) {
        const works = {
            findById: async (id: string) => ({
                id,
                gitProvider: 'github',
                taskIsolationBaseBranch: null,
                getRepoOwner: () => 'acme',
                getDataRepo: () => 'widgets',
            }),
        };
        const git = { getPullRequestStatus: jest.fn(async () => status) };
        const service = new TaskPrStatusService(
            repository,
            works as unknown as WorkRepository,
            git as unknown as GitFacadeService,
        );
        const summary = await service.syncDuePrStatuses({ staleSeconds: 0 });
        return { summary, git };
    }

    /**
     * The review of #3158: one "not found" answer (a connection that briefly cannot see a private
     * repository), then the pull request waits 14 days for review with no push. Its branch must
     * survive: deleting it would close the pull request. Passes on `develop` too (every read moved
     * `updatedAt` there), so it pins that this change did not make the GC more eager.
     */
    it('one "not found", then 14 days: the sweep reads the pull request again, finds it open, and keeps its branch', async () => {
        const waiting = await openPrTask(ago(30 * DAY));
        await repository.updatePrStatusCache(waiting.id, { ciCheckedAt: ago(5 * 60_000) });
        const blip = await sweepWithProvider(null);
        expect(blip.summary.scanned).toBe(1);

        // 15 days later: the last stamp the sweep left is old, and access is back.
        await repository.updatePrStatusCache(waiting.id, { ciCheckedAt: ago(15 * DAY) });
        const recovered = await sweepWithProvider({
            number: waiting.prNumber!,
            state: 'open',
            merged: false,
            headSha: 'e'.repeat(40),
            ciState: 'pending',
            checks: [],
        });
        expect(recovered.summary.scanned).toBe(1);
        expect(recovered.git.getPullRequestStatus).toHaveBeenCalledTimes(1);
        expect((await taskRows.findOneByOrFail({ id: waiting.id })).prState).toBe('open');
        expect(await candidateIds()).toEqual([]);
    });

    it('never collects a Task whose pull request is "not found" while it is not Done or Cancelled', async () => {
        // Recorded `not_found`, and (say the sweep was down) not read for 15 days.
        const gone = await openPrTask(ago(30 * DAY));
        await repository.updatePrStatusCache(gone.id, {
            prState: TASK_PR_NOT_FOUND_STATE,
            ciCheckedAt: ago(15 * DAY),
        });
        const cancelled = await openPrTask(ago(30 * DAY), { status: TaskStatus.CANCELLED });
        await repository.updatePrStatusCache(cancelled.id, {
            prState: TASK_PR_NOT_FOUND_STATE,
            ciCheckedAt: ago(15 * DAY),
        });

        expect(await candidateIds()).toEqual([cancelled.id]);
    });

    it('keeps the branch of an open pull request the sweep still reads, however old its last change', async () => {
        const lastChanged = ago(30 * DAY);
        const waiting = await openPrTask(lastChanged);
        await repository.updatePrStatusCache(waiting.id, { ciCheckedAt: new Date() });

        const row = await taskRows.findOneByOrFail({ id: waiting.id });
        expect(row.updatedAt.getTime()).toBe(lastChanged.getTime());
        expect(await candidateIds()).toEqual([]);
    });

    it('keeps the branch of a Task whose head a CI result named within the cutoff', async () => {
        const lastChanged = ago(30 * DAY);
        const building = await openPrTask(lastChanged, { prState: null });
        await repository.recordCiHead({
            taskId: building.id,
            expectedHeadSha: null,
            headSha: 'd'.repeat(40),
            seenAt: new Date(),
        });

        const row = await taskRows.findOneByOrFail({ id: building.id });
        expect(row.updatedAt.getTime()).toBe(lastChanged.getTime());
        expect(await candidateIds()).toEqual([]);
    });

    it('collects a branch with no sign of life past the cutoff: no change, no read, no CI result', async () => {
        const abandoned = await openPrTask(ago(30 * DAY));
        // Its last successful read, 20 days ago (reads have failed since, or it was moved out).
        await repository.updatePrStatusCache(abandoned.id, { ciCheckedAt: ago(20 * DAY) });
        const neverRead = await openPrTask(ago(15 * DAY), { prState: null });
        const changedRecently = await openPrTask(ago(STALE_DAYS * DAY - DAY));

        expect(await candidateIds()).toEqual([abandoned.id, neverRead.id].sort());
        expect(changedRecently.id).toBeTruthy();
    });

    it('collects a terminal Task at once, whatever its stamps say', async () => {
        const done = await openPrTask(new Date(), { status: TaskStatus.DONE });
        await repository.updatePrStatusCache(done.id, { ciCheckedAt: new Date() });
        expect(await candidateIds()).toEqual([done.id]);
    });
});
