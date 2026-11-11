import { TaskTransitionService } from '../task-transition.service';
import { TasksService } from '../tasks.service';
import {
    agentMayCommitAndOpenPullRequests,
    decideMissionRepoRun,
    isMissionFiledTask,
    MISSION_TASK_LABEL,
    missionTaskOutputAllowsAgentMerge,
} from '../mission-repo-run';
import { TaskStatus, TaskPriority } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';

/**
 * A Mission's unattended Task on a Repository Work runs only when its change will really be a
 * reviewable pull request: an Agent that may commit AND open pull requests (read exactly as the
 * worker reads them), the Task isolated on its own branch, and no merge policy that lets agents
 * merge unless the Mission opted in. The Mission tick asks it before planning, with the Agent
 * `runTask` will resolve; dispatch asks it again, so a change in between cannot slip a run
 * through.
 */

function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 't1',
        userId: 'u1',
        slug: 'T-1',
        title: 'Add a changelog',
        description: null,
        status: TaskStatus.TODO,
        previousStatus: null,
        priority: TaskPriority.P3,
        labels: [MISSION_TASK_LABEL],
        missionId: 'm1',
        ideaId: null,
        workId: 'w-repo',
        agentId: null,
        parentTaskId: null,
        createdByType: 'user',
        createdById: 'u1',
        requireAllApprovers: true,
        startedAt: null,
        completedAt: null,
        isRecurring: false,
        recurrenceOccurredCount: 0,
        tenantId: null,
        organizationId: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Task;
}

const BOTH = { canCommitToRepo: true, canOpenPullRequests: true };
const REPO_ON = {
    id: 'w-repo',
    kind: 'repo',
    taskIsolation: 'worktree',
    organizationId: 'org-1',
    tenantId: 'ten-1',
};

describe('mission-repo-run — the rule', () => {
    it('agentMayCommitAndOpenPullRequests reads the permissions the way the worker does', () => {
        expect(agentMayCommitAndOpenPullRequests({ permissions: BOTH })).toBe(true);
        // The worker treats a missing permission as allowed (`!== false`).
        expect(agentMayCommitAndOpenPullRequests({})).toBe(true);
        expect(agentMayCommitAndOpenPullRequests({ permissions: null })).toBe(true);
        expect(
            agentMayCommitAndOpenPullRequests({ permissions: { ...BOTH, canCommitToRepo: false } }),
        ).toBe(false);
        expect(
            agentMayCommitAndOpenPullRequests({
                permissions: { ...BOTH, canOpenPullRequests: false },
            }),
        ).toBe(false);
        expect(agentMayCommitAndOpenPullRequests(null)).toBe(false);
        expect(agentMayCommitAndOpenPullRequests(undefined)).toBe(false);
    });

    it('isMissionFiledTask needs the Mission AND the label', () => {
        expect(isMissionFiledTask({ missionId: 'm1', labels: [MISSION_TASK_LABEL] })).toBe(true);
        expect(isMissionFiledTask({ missionId: null, labels: [MISSION_TASK_LABEL] })).toBe(false);
        expect(isMissionFiledTask({ missionId: 'm1', labels: ['other'] })).toBe(false);
        expect(isMissionFiledTask({ missionId: 'm1', labels: null })).toBe(false);
    });

    it('missionTaskOutputAllowsAgentMerge only for exactly true', () => {
        expect(missionTaskOutputAllowsAgentMerge({ allowAgentMerge: true })).toBe(true);
        for (const raw of [
            null,
            undefined,
            {},
            { allowAgentMerge: 'true' },
            { allowAgentMerge: 1 },
        ]) {
            expect(missionTaskOutputAllowsAgentMerge(raw)).toBe(false);
        }
    });

    it('decides in order: the Agent, then isolation, then the merge policy (asked only when needed)', async () => {
        const merge = jest.fn(async () => true);
        const optIn = jest.fn(async () => false);
        const decide = (over: Record<string, unknown>) =>
            decideMissionRepoRun({
                task: { workId: 'w-repo' },
                work: REPO_ON,
                agent: { permissions: BOTH },
                agentMergeAllowed: false,
                missionAllowsAgentMerge: false,
                ...over,
            });
        expect(await decide({})).toBeNull();
        expect(
            await decide({
                agent: { permissions: { ...BOTH, canOpenPullRequests: false } },
                agentMergeAllowed: merge,
            }),
        ).toBe('agent-cannot-open-pull-requests');
        expect(await decide({ agent: null })).toBe('agent-cannot-open-pull-requests');
        expect(
            await decide({ work: { ...REPO_ON, taskIsolation: 'off' }, agentMergeAllowed: merge }),
        ).toBe('isolation-off');
        expect(merge).not.toHaveBeenCalled();
        // A per-Task override is read like the worker reads it.
        expect(
            await decide({
                task: { workId: 'w-repo', isolationMode: 'on' },
                work: { ...REPO_ON, taskIsolation: 'off' },
            }),
        ).toBeNull();
        expect(await decide({ task: { workId: 'w-repo', isolationMode: 'off' } })).toBe(
            'isolation-off',
        );
        expect(await decide({ agentMergeAllowed: merge, missionAllowsAgentMerge: optIn })).toBe(
            'agent-merge-allowed',
        );
        expect(await decide({ agentMergeAllowed: true, missionAllowsAgentMerge: true })).toBeNull();
    });

    it('never refuses another kind of Work, or no Work', async () => {
        for (const kind of ['app', 'directory', 'website', 'awesome-repo', 'project', null]) {
            expect(
                await decideMissionRepoRun({
                    task: { workId: 'w' },
                    work: { kind, taskIsolation: 'off' },
                    agent: null,
                    agentMergeAllowed: true,
                    missionAllowsAgentMerge: false,
                }),
            ).toBeNull();
        }
        expect(
            await decideMissionRepoRun({
                task: { workId: 'w' },
                work: null,
                agent: null,
                agentMergeAllowed: true,
                missionAllowsAgentMerge: false,
            }),
        ).toBeNull();
    });
});

describe('TaskTransitionService.dispatchAgentRun — a Mission’s unattended Task on a Repository Work', () => {
    let runs: {
        createQueued: jest.Mock;
        markDispatchFailed: jest.Mock;
        setTriggerRunId: jest.Mock;
    };
    let dispatcher: { enqueue: jest.Mock };
    let works: { findById: jest.Mock };
    let mergePolicy: { resolve: jest.Mock };
    let missionRows: { findOne: jest.Mock };

    function makeSvc(
        opts: {
            permissions?: Record<string, boolean>;
            work?: Record<string, unknown> | null | 'throws';
            allowAgentMerge?: boolean;
            taskOutput?: unknown;
            withoutMergePolicy?: boolean;
        } = {},
    ): TaskTransitionService {
        runs = {
            createQueued: jest.fn().mockResolvedValue({ id: 'r1' }),
            markDispatchFailed: jest.fn().mockResolvedValue(undefined),
            setTriggerRunId: jest.fn().mockResolvedValue(undefined),
        };
        dispatcher = { enqueue: jest.fn().mockResolvedValue({ runId: 'trd-1' }) };
        works = {
            findById: jest.fn(async () => {
                if (opts.work === 'throws') throw new Error('db down');
                return opts.work === undefined ? REPO_ON : opts.work;
            }),
        };
        mergePolicy = {
            resolve: jest.fn(async () => ({
                policy: { allowAgentMerge: opts.allowAgentMerge === true },
                source: 'work',
                chain: [],
            })),
        };
        missionRows = {
            findOne: jest.fn(async () => ({ id: 'm1', taskOutput: opts.taskOutput ?? null })),
        };
        const agents = {
            findByIdAndUser: jest.fn(async (id: string, userId: string) => ({
                id,
                userId,
                permissions: opts.permissions ?? BOTH,
            })),
        };
        return new (TaskTransitionService as unknown as new (
            ...args: unknown[]
        ) => TaskTransitionService)(
            { casUpdateStatus: jest.fn(), findById: jest.fn() },
            { findByTaskId: jest.fn().mockResolvedValue([]) },
            { allApproved: jest.fn().mockResolvedValue(true) },
            { findAgentAssignees: jest.fn().mockResolvedValue([]) },
            runs,
            dispatcher,
            undefined, // notifications
            undefined, // runDenorm
            undefined, // dispatchGate
            works,
            undefined, // terminalSessions
            agents,
            undefined, // agentReviews
            undefined, // domainEvents
            undefined, // sessionSchedules
            undefined, // appWorkRunAdmission
            missionRows,
            opts.withoutMergePolicy ? undefined : mergePolicy,
        );
    }

    const refusedWith = async (svc: TaskTransitionService, code: string, task = makeTask()) => {
        const result = await svc.dispatchAgentRun(task, 'agent-a');
        expect(result).toMatchObject({ runId: null, dispatched: false, parked: false });
        expect(result.error).toMatch(new RegExp(`^${code}: `));
        // Refused before a run row exists: nothing spent, nothing queued.
        expect(runs.createQueued).not.toHaveBeenCalled();
        expect(dispatcher.enqueue).not.toHaveBeenCalled();
    };

    it('dispatches when the Agent may commit and open pull requests, the Task is isolated and agents may not merge', async () => {
        const svc = makeSvc();
        await expect(svc.dispatchAgentRun(makeTask(), 'agent-a')).resolves.toMatchObject({
            dispatched: true,
        });
        // The EFFECTIVE policy for that Agent on that Work (organization and tenant included).
        expect(mergePolicy.resolve).toHaveBeenCalledWith({
            agentId: 'agent-a',
            workId: 'w-repo',
            organizationId: 'org-1',
            tenantId: 'ten-1',
        });
    });

    it('refuses an Agent that may not commit (the FR-9 equivalent): the worker would give it no workspace', async () => {
        await refusedWith(
            makeSvc({ permissions: { ...BOTH, canCommitToRepo: false } }),
            'mission_repo_agent_cannot_open_pull_requests',
        );
    });

    it('refuses an Agent that may not open pull requests: the run would end pushed-no-pr', async () => {
        await refusedWith(
            makeSvc({ permissions: { ...BOTH, canOpenPullRequests: false } }),
            'mission_repo_agent_cannot_open_pull_requests',
        );
    });

    it('refuses when the Work’s Task isolation was turned off after filing', async () => {
        await refusedWith(
            makeSvc({ work: { ...REPO_ON, taskIsolation: 'off' } }),
            'mission_repo_isolation_off',
        );
    });

    it('refuses under a merge policy that lets agents merge, unless the Mission opted in', async () => {
        await refusedWith(makeSvc({ allowAgentMerge: true }), 'mission_repo_agent_merge_allowed');
        await refusedWith(
            makeSvc({ allowAgentMerge: true, taskOutput: { allowAgentMerge: 'yes' } }),
            'mission_repo_agent_merge_allowed',
        );
        const optedIn = makeSvc({ allowAgentMerge: true, taskOutput: { allowAgentMerge: true } });
        await expect(optedIn.dispatchAgentRun(makeTask(), 'agent-a')).resolves.toMatchObject({
            dispatched: true,
        });
        expect(missionRows.findOne).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'm1' } }),
        );
    });

    it('without the policy resolver, the Work’s own merge policy is read', async () => {
        await refusedWith(
            makeSvc({
                withoutMergePolicy: true,
                work: { ...REPO_ON, mergePolicy: { allowAgentMerge: true } },
            }),
            'mission_repo_agent_merge_allowed',
        );
    });

    it('fails CLOSED when the Work cannot be read: nobody is watching this run', async () => {
        await refusedWith(makeSvc({ work: 'throws' }), 'mission_repo_work_unreadable');
    });

    it('leaves every other Task as it was: not Mission-filed, another kind, a review run', async () => {
        const noPrs = { ...BOTH, canOpenPullRequests: false };
        for (const task of [
            makeTask({ labels: null }),
            makeTask({ missionId: null }),
            makeTask({ workId: null }),
        ]) {
            await expect(
                makeSvc({ permissions: noPrs }).dispatchAgentRun(task, 'agent-a'),
            ).resolves.toMatchObject({ dispatched: true });
        }
        await expect(
            makeSvc({
                permissions: noPrs,
                work: { id: 'w-site', kind: 'directory', taskIsolation: 'off' },
            }).dispatchAgentRun(makeTask({ workId: 'w-site' }), 'agent-a'),
        ).resolves.toMatchObject({ dispatched: true });
        const agentReviews = { bindRun: jest.fn().mockResolvedValue(undefined) };
        const svc = makeSvc({ permissions: noPrs });
        (svc as unknown as { agentReviews: unknown }).agentReviews = agentReviews;
        await expect(
            svc.dispatchAgentRun(makeTask(), 'agent-a', { reviewId: 'review-1' }),
        ).resolves.toMatchObject({ dispatched: true });
    });
});

describe('TasksService — the Agent a new Mission Task will run with, before it exists', () => {
    const build = (agents: unknown, transitions: unknown = {}) =>
        new TasksService(
            {} as never, // tasks
            {} as never, // assignees
            {} as never, // reviewers
            {} as never, // approvers
            {} as never, // blocks
            {} as never, // relations
            {} as never, // counter
            transitions as never,
            undefined, // activityLog
            undefined, // attachments
            agents as never,
        );

    it('the explicit Agent, when its owner can use it in the scope', async () => {
        const agent = { id: 'agent-x', permissions: BOTH, tenantId: null, organizationId: null };
        const agents = {
            findByIdAndUser: jest.fn().mockResolvedValue(agent),
            findByUserIdScoped: jest.fn(),
        };
        await expect(
            build(agents).resolveRunAgentForNewTask('u1', { workId: 'w', agentId: 'agent-x' }),
        ).resolves.toBe(agent);
        expect(agents.findByUserIdScoped).not.toHaveBeenCalled();
        agents.findByIdAndUser.mockResolvedValue(null);
        await expect(
            build(agents).resolveRunAgentForNewTask('u1', { workId: 'w', agentId: 'agent-x' }),
        ).resolves.toBeNull();
    });

    it('else the Work’s ONLY Agent — none or several is null, exactly where runTask answers a 400', async () => {
        const rowsOf = (rows: unknown[]) => ({
            findByIdAndUser: jest.fn(),
            findByUserIdScoped: jest.fn().mockResolvedValue({ rows, total: rows.length }),
        });
        const one = rowsOf([{ id: 'a1' }]);
        await expect(build(one).resolveRunAgentForNewTask('u1', { workId: 'w' })).resolves.toEqual({
            id: 'a1',
        });
        expect(one.findByUserIdScoped).toHaveBeenCalledWith(
            'u1',
            { workId: 'w', limit: 25 },
            undefined,
        );
        await expect(
            build(rowsOf([])).resolveRunAgentForNewTask('u1', { workId: 'w' }),
        ).resolves.toBeNull();
        await expect(
            build(rowsOf([{ id: 'a1' }, { id: 'a2' }])).resolveRunAgentForNewTask('u1', {
                workId: 'w',
            }),
        ).resolves.toBeNull();
        // The same Agent twice is still one.
        await expect(
            build(rowsOf([{ id: 'a1' }, { id: 'a1' }])).resolveRunAgentForNewTask('u1', {
                workId: 'w',
            }),
        ).resolves.toEqual({ id: 'a1' });
    });

    it('missionRepoRunRefusalForNewTask asks the dispatch rule with that Agent and a Mission-filed Task', async () => {
        const agent = { id: 'a1', permissions: BOTH };
        const transitions = { missionRepoRunRefusal: jest.fn().mockResolvedValue('isolation-off') };
        const agents = {
            findByIdAndUser: jest.fn(),
            findByUserIdScoped: jest.fn().mockResolvedValue({ rows: [agent], total: 1 }),
        };
        await expect(
            build(agents, transitions).missionRepoRunRefusalForNewTask('u1', {
                workId: 'w-repo',
                missionId: 'm1',
            }),
        ).resolves.toBe('isolation-off');
        expect(transitions.missionRepoRunRefusal).toHaveBeenCalledWith(
            expect.objectContaining({ workId: 'w-repo', missionId: 'm1' }),
            agent,
        );
    });
});
