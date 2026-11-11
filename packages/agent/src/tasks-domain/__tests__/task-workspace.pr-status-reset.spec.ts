import { TaskStatus, type Task } from '../../entities/task.entity';
import { TaskWorkspaceService } from '../task-workspace.service';

/** Constructor slots, so the doubles are typed against the real contracts. */
type ServiceArgs = ConstructorParameters<typeof TaskWorkspaceService>;

/**
 * A NEW pull request on a Task that already carries the PR-status cache of an earlier one (its
 * pull request was closed, then the Task ran again): the cache is cleared to "not read yet", so
 * the status sweep (which never polls a `closed` / `merged` row again), the Goal loop's
 * wait-for-merge and a Mission's open-Tasks cap see the new pull request as open. A Task's FIRST
 * pull request writes exactly what it always did.
 *
 * Driven through `openPullRequestForBranch`, the shared tail the cloud finalize (`finalizeRun`)
 * ends in: it is where the platform opens a pull request.
 */
describe('TaskWorkspaceService — a new pull request resets the PR-status cache', () => {
    const PR_URL = 'https://github.com/acme/bookings/pull/12';

    let works: { findById: jest.Mock };
    let tasks: { updateById: jest.Mock; findById: jest.Mock };
    let runs: { updateTelemetry: jest.Mock };
    let gitFacade: { getRepository: jest.Mock; createPullRequest: jest.Mock };

    const makeTask = (over: Partial<Task> = {}): Task =>
        ({
            id: 'task-1',
            slug: 'T-118',
            title: 'Add an SMS reminder',
            userId: 'user-1',
            workId: 'work-1',
            agentId: 'agent-task',
            status: TaskStatus.IN_PROGRESS,
            branchRef: 'task/t-118',
            branchState: 'pushed',
            prNumber: null,
            prUrl: null,
            ...over,
        }) as unknown as Task;

    const openFor = async (task: Task): Promise<unknown> => {
        const args = new Array(14).fill(undefined) as unknown[];
        args[0] = works;
        args[1] = tasks;
        args[2] = runs;
        args[4] = gitFacade;
        const service = new TaskWorkspaceService(...(args as ServiceArgs));
        const open = (
            service as unknown as {
                openPullRequestForBranch: (a: Record<string, unknown>) => Promise<unknown>;
            }
        ).openPullRequestForBranch.bind(service);
        return open({
            task,
            work: await works.findById(),
            userId: 'user-1',
            agentId: 'agent-run',
            agentCanOpenPullRequests: true,
            owner: 'acme',
            repo: 'bookings',
            gitOptions: { userId: 'user-1', providerId: 'github', workId: 'work-1' },
            baseRef: 'main',
            branch: 'task/t-118',
            gateStatus: null,
        });
    };

    /** The patch that recorded the pull request (the one carrying `prNumber`). */
    const prPatch = (): Record<string, unknown> => {
        const call = tasks.updateById.mock.calls.find(
            ([, patch]) => (patch as Record<string, unknown>).prNumber === 12,
        );
        expect(call).toBeDefined();
        return call![1] as Record<string, unknown>;
    };

    beforeEach(() => {
        works = {
            findById: jest.fn().mockResolvedValue({
                id: 'work-1',
                kind: 'repo',
                gitProvider: 'github',
                taskIsolation: 'worktree',
                taskIsolationBaseBranch: null,
                organizationId: null,
                tenantId: null,
                getRepoOwner: () => 'acme',
                getDataRepo: () => 'bookings',
            }),
        };
        tasks = { updateById: jest.fn().mockResolvedValue(undefined), findById: jest.fn() };
        runs = { updateTelemetry: jest.fn().mockResolvedValue(undefined) };
        gitFacade = {
            getRepository: jest.fn().mockResolvedValue({ defaultBranch: 'main' }),
            createPullRequest: jest.fn().mockResolvedValue({ number: 12, url: PR_URL }),
        };
    });

    it('a Task whose earlier pull request was closed gets the cache cleared with the new one', async () => {
        const rerun = makeTask({
            status: TaskStatus.IN_PROGRESS,
            branchState: 'pr-open',
            prNumber: 11,
            prUrl: 'https://github.com/acme/bookings/pull/11',
            prState: 'closed',
            ciState: 'failing',
            ciCheckedAt: new Date('2026-11-09T10:00:00.000Z'),
            prChecks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
            prHeadSha: 'c'.repeat(40),
        } as Partial<Task>);

        await openFor(rerun);

        expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
        expect(prPatch()).toEqual({
            branchState: 'pr-open',
            prNumber: 12,
            prUrl: PR_URL,
            prState: null,
            ciState: null,
            ciCheckedAt: null,
            prChecks: null,
            prHeadSha: null,
            prReadRetryAt: null,
            prNotFoundSince: null,
        });
    });

    it('a new pull request does not inherit the backoff or the first "not found" of the old one', async () => {
        // The old pull request's reads were failing: only the sweep's retry memory is left.
        await openFor(
            makeTask({
                prNumber: 11,
                prReadRetryAt: new Date('2026-11-11T16:00:00.000Z'),
                prNotFoundSince: new Date('2026-11-11T09:00:00.000Z'),
            } as Partial<Task>),
        );
        expect(prPatch()).toMatchObject({
            prNumber: 12,
            prReadRetryAt: null,
            prNotFoundSince: null,
        });
    });

    it('a discarded branch (number cleared, closed state kept) is reset too', async () => {
        await openFor(makeTask({ branchState: 'discarded', prState: 'closed' } as Partial<Task>));
        expect(prPatch()).toMatchObject({ prNumber: 12, prState: null, ciCheckedAt: null });
    });

    it('a Task’s first pull request writes exactly what it always did', async () => {
        await openFor(makeTask());
        expect(prPatch()).toEqual({ branchState: 'pr-open', prNumber: 12, prUrl: PR_URL });
    });

    it('re-recording the SAME pull request number touches no cache', async () => {
        await openFor(
            makeTask({
                prNumber: 12,
                prUrl: PR_URL,
                prState: 'open',
                ciState: 'passing',
            } as Partial<Task>),
        );
        expect(prPatch()).toEqual({ branchState: 'pr-open', prNumber: 12, prUrl: PR_URL });
    });
});
