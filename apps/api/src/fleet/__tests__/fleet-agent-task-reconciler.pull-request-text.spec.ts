import { Logger } from '@nestjs/common';
import { FleetJobCompletedEvent } from '@ever-works/agent/events';
import { TaskStatus, TaskWorkspaceService } from '@ever-works/agent/tasks-domain';
import type { FleetAgentTaskResult, FleetJobView } from '@ever-works/contracts';
import { FleetAgentTaskReconcilerService } from '../fleet-agent-task-reconciler.service';

/**
 * Review of #3145 — what a fleet run's pull request is built from, end to end:
 * the REAL reconciler hands the node's report to the REAL
 * `TaskWorkspaceService.finalizeRemotePush`, and the git provider's
 * `createPullRequest` is the only double that matters. What these pin:
 *
 *   - B1: a credential the model printed (`GITHUB_TOKEN=ghp_…`, also on its
 *     `PR-TITLE:` line) reaches neither the pull request title nor its body;
 *   - S3: a sentence quoting the Task's Mission description verbatim is left
 *     out, the rest of the summary is posted, and the Mission is read by
 *     primary key with the owner as a predicate;
 *   - fail closed: when the Mission cannot be read, the pull request carries
 *     today's text and nothing of the summary.
 */

const RUN = 'run-1';
const TASK = 'task-1';
const AGENT = 'agent-1';
const USER = 'user-1';
const NODE = '11111111-1111-4111-8111-111111111111';
const GH_TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
const ANTHROPIC = `sk-ant-api03-${'x'.repeat(90)}`;
const MISSION_DESCRIPTION =
    'Win the Acme Corp renewal before the March board meeting by shipping the salary filters they asked for in the QBR.';

function job(): FleetJobView {
    return {
        id: 'job-1',
        kind: 'agent-task',
        status: 'done',
        nodeId: NODE,
        requiredCapabilities: [],
        payload: { taskId: TASK, runId: RUN, agentId: AGENT, userId: USER },
        leaseExpiresAt: null,
        attempts: 1,
        maxAttempts: 3,
        createdAt: null,
        startedAt: null,
        completedAt: null,
    } as unknown as FleetJobView;
}

function result(summary: string): FleetAgentTaskResult {
    return {
        status: 'succeeded',
        taskId: TASK,
        runId: RUN,
        workspace: null,
        steps: [],
        model: {
            provider: 'claude-code',
            status: 'succeeded',
            exitCode: 0,
            durationMs: 5000,
            summary,
            outputTail: `TOKEN=${GH_TOKEN}`,
        },
        checks: [],
        gateStatus: 'none',
        git: {
            branch: 'task/t-1-fix',
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            empty: false,
            pushed: true,
            changedFiles: 2,
        },
    } as FleetAgentTaskResult;
}

describe('FleetAgentTaskReconcilerService → TaskWorkspaceService — the pull request text', () => {
    let createPullRequest: jest.Mock;
    let missions: { findOne: jest.Mock };
    let goals: { findOne: jest.Mock };
    let taskChat: { post: jest.Mock };

    const task = {
        id: TASK,
        userId: USER,
        slug: 'T-1',
        title: 'Quality loop: fix one real defect',
        workId: 'work-1',
        missionId: 'mission-1',
        goalId: null,
        status: TaskStatus.IN_PROGRESS,
        branchRef: null,
        branchState: null,
        prNumber: null,
        prUrl: null,
        organizationId: null,
    };

    const build = () => {
        const tasks = {
            findById: jest.fn().mockResolvedValue({ ...task }),
            updateById: jest.fn().mockResolvedValue(undefined),
        };
        const runs = {
            findById: jest
                .fn()
                .mockResolvedValue({ id: RUN, userId: USER, agentId: AGENT, workId: 'work-1' }),
            markStarted: jest.fn().mockResolvedValue(true),
            markCompleted: jest.fn().mockResolvedValue(undefined),
            tryMarkCompleted: jest.fn().mockResolvedValue(true),
            markFailed: jest.fn().mockResolvedValue(undefined),
            updateGateResults: jest.fn().mockResolvedValue(undefined),
            updateTelemetry: jest.fn().mockResolvedValue(undefined),
            addTokens: jest.fn().mockResolvedValue(undefined),
            stampCostCents: jest.fn().mockResolvedValue(undefined),
            recordFleetCliSession: jest.fn().mockResolvedValue(undefined),
        };
        const works = {
            findById: jest.fn().mockResolvedValue({
                id: 'work-1',
                gitProvider: 'github',
                taskIsolationBaseBranch: null,
                organizationId: null,
                tenantId: null,
                getRepoOwner: () => 'acme',
                getDataRepo: () => 'site-data',
            }),
        };
        const gitFacade = {
            getRepository: jest.fn().mockResolvedValue({
                defaultBranch: 'main',
                cloneUrl: 'https://github.com/acme/site-data.git',
            }),
            createPullRequest,
        };
        const transitions = { transition: jest.fn().mockResolvedValue(undefined) };
        type WorkspaceArgs = ConstructorParameters<typeof TaskWorkspaceService>;
        const taskWorkspace = new TaskWorkspaceService(
            works as unknown as WorkspaceArgs[0],
            tasks as unknown as WorkspaceArgs[1],
            runs as unknown as WorkspaceArgs[2],
            {} as unknown as WorkspaceArgs[3],
            gitFacade as unknown as WorkspaceArgs[4],
            transitions as unknown as WorkspaceArgs[5],
        );
        return new FleetAgentTaskReconcilerService(
            runs as never,
            tasks as never,
            { findById: jest.fn().mockResolvedValue({ id: AGENT, permissions: {} }) } as never,
            {
                recordStarted: jest.fn().mockResolvedValue(true),
                recordTerminal: jest.fn().mockResolvedValue(true),
            } as never,
            taskWorkspace,
            taskChat as never,
            { drainForWork: jest.fn().mockResolvedValue({ dispatched: false }) } as never,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            missions as never,
            goals as never,
        );
    };

    const complete = (summary: string) =>
        build().onCompleted(
            new FleetJobCompletedEvent(
                job(),
                USER,
                'node-report',
                NODE,
                result(summary) as unknown as Record<string, unknown>,
            ),
        );

    const opened = () => createPullRequest.mock.calls[0]![0] as { title: string; body: string };

    beforeEach(() => {
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        createPullRequest = jest
            .fn()
            .mockResolvedValue({ number: 7, url: 'https://github.com/acme/site-data/pull/7' });
        missions = {
            findOne: jest.fn().mockResolvedValue({
                id: 'mission-1',
                userId: USER,
                title: 'Ship Ever Jobs v1',
                description: MISSION_DESCRIPTION,
            }),
        };
        goals = { findOne: jest.fn().mockResolvedValue(null) };
        taskChat = { post: jest.fn().mockResolvedValue({}) };
    });

    afterEach(() => jest.restoreAllMocks());

    it('B1 — posts no credential the summary carries, in the title or the body', async () => {
        await complete(
            `Fixed the deploy script.\n\nI tested with GITHUB_TOKEN=${GH_TOKEN} and ANTHROPIC_API_KEY=${ANTHROPIC}.\n\nPR-TITLE: fix: deploy script uses ${GH_TOKEN}`,
        );
        expect(createPullRequest).toHaveBeenCalledTimes(1);
        const { title, body } = opened();
        for (const secret of [GH_TOKEN, ANTHROPIC]) {
            expect(title).not.toContain(secret);
            expect(body).not.toContain(secret);
        }
        expect(title).toBe('fix: deploy script uses [redacted secret] [T-1]');
        expect(body).toContain('GITHUB_TOKEN=[redacted secret]');
        // The Task chat copy was already redacted; it still is.
        expect(JSON.stringify(taskChat.post.mock.calls)).not.toContain(GH_TOKEN);
    });

    it('S3 — leaves out the sentence that quotes the Mission description, and posts the rest', async () => {
        await complete(
            [
                'Fixed the salary filter dropping zero-minimum jobs.',
                'This matters because we need to win the Acme Corp renewal before the March board meeting. Added a spec.',
                '',
                'PR-TITLE: fix: keep zero-minimum jobs in the salary filter',
            ].join('\n'),
        );
        expect(missions.findOne).toHaveBeenCalledWith({
            where: { id: 'mission-1', userId: USER },
            select: { id: true, title: true, description: true },
        });
        const { title, body } = opened();
        expect(title).toBe('fix: keep zero-minimum jobs in the salary filter [T-1]');
        expect(body).not.toMatch(/acme corp|board meeting/i);
        expect(body).toContain('Fixed the salary filter dropping zero-minimum jobs.');
        expect(body).toContain('Added a spec.');
    });

    it('fails closed — a Mission that cannot be read means nothing of the summary is posted', async () => {
        missions.findOne.mockRejectedValue(new Error('connection reset'));
        await complete('We need to win the Acme Corp renewal.\n\nPR-TITLE: fix: the salary filter');
        expect(opened()).toEqual(
            expect.objectContaining({
                title: 'Task T-1: Quality loop: fix one real defect',
                body: "Automated changes for Task `T-1` (agent run). Review before merging — merge policy is governed by the Work's merge-policy settings.",
            }),
        );
    });
});
