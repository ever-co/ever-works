import { isRepositoryWorkKind } from '@ever-works/contracts';
import { resolveTaskIsolation } from './task-isolation';

/**
 * APW-08 T35 (FR-52) — the label every Mission-filed Task carries. Declared in this leaf so the
 * dispatch choke point (`TaskTransitionService.dispatchAgentRun`) can recognise a Mission-filed
 * Task without importing the Missions module; `MissionTickService` re-exports it.
 */
export const MISSION_TASK_LABEL = 'mission-task';

/**
 * Why an unattended Mission Task on a Repository Work may not run:
 *
 *   - `agent-cannot-open-pull-requests` — no single Agent resolves for it, or the Agent may not
 *     both commit (`canCommitToRepo`) and open pull requests (`canOpenPullRequests`). Without the
 *     first the worker gives the run no workspace and it changes nothing; without the second it
 *     ends `pushed-no-pr` and the Task never completes. Either way it spends budget for nothing;
 *   - `isolation-off` — the Task would run without its own branch, so it opens no pull request;
 *   - `agent-merge-allowed` — the effective merge policy lets agents merge their own pull
 *     requests, so an unattended run could land a change in the base branch with no person in
 *     the loop, and the Mission has not opted in (`taskOutput.allowAgentMerge: true`).
 */
export type MissionRepoRunRefusal =
    | 'agent-cannot-open-pull-requests'
    | 'isolation-off'
    | 'agent-merge-allowed';

/** The stable code that prefixes a dispatch refusal, so a reader (and a spec) can match it. */
export const MISSION_REPO_RUN_REFUSAL_CODES: Readonly<Record<MissionRepoRunRefusal, string>> =
    Object.freeze({
        'agent-cannot-open-pull-requests': 'mission_repo_agent_cannot_open_pull_requests',
        'isolation-off': 'mission_repo_isolation_off',
        'agent-merge-allowed': 'mission_repo_agent_merge_allowed',
    });

const MISSION_REPO_RUN_REFUSAL_MESSAGES: Readonly<Record<MissionRepoRunRefusal, string>> =
    Object.freeze({
        'agent-cannot-open-pull-requests':
            "A Mission's Task on a Repository Work runs only with an Agent that may commit and open pull requests: its change reaches the repository only as a pull request into the base branch.",
        'isolation-off':
            "A Mission's Task on a Repository Work runs only while the Work's Task isolation is on: without it the run gets no branch and opens no pull request.",
        'agent-merge-allowed':
            "This Repository Work's merge policy lets agents merge their own pull requests, and the Mission has not opted in (taskOutput.allowAgentMerge), so its unattended Tasks are not started.",
    });

/** The dispatch `error` for a refusal: the code, then the copy. */
export function describeMissionRepoRunRefusal(refusal: MissionRepoRunRefusal): string {
    return `${MISSION_REPO_RUN_REFUSAL_CODES[refusal]}: ${MISSION_REPO_RUN_REFUSAL_MESSAGES[refusal]}`;
}

/** The dispatch `error` when the Work of a Mission-filed Task cannot be read (fail closed). */
export const MISSION_REPO_RUN_WORK_UNREADABLE =
    "mission_repo_work_unreadable: The Work of this Mission's Task could not be read, so whether it may run unattended is unknown. Nothing was started.";

/** A Task the Mission's tick filed: it carries the Mission and the Mission-task label. */
export function isMissionFiledTask(task: {
    missionId?: string | null;
    labels?: readonly string[] | null;
}): boolean {
    return Boolean(task.missionId) && (task.labels ?? []).includes(MISSION_TASK_LABEL);
}

/** The part of an Agent this rule reads. */
export interface MissionRepoRunAgentView {
    permissions?: { canCommitToRepo?: boolean; canOpenPullRequests?: boolean } | null;
}

/**
 * Whether an Agent may both commit and open pull requests, read EXACTLY as the worker reads
 * them (`agent-task-execute.task.ts`: `canCommitToRepo !== false` decides the workspace,
 * `canOpenPullRequests !== false` decides the pull request), so this cannot disagree with what
 * the run then does. No Agent at all is "no".
 */
export function agentMayCommitAndOpenPullRequests(
    agent: MissionRepoRunAgentView | null | undefined,
): boolean {
    if (!agent) return false;
    return (
        agent.permissions?.canCommitToRepo !== false &&
        agent.permissions?.canOpenPullRequests !== false
    );
}

/** Has the Mission opted in to unattended Tasks under a merge policy that lets agents merge? */
export function missionTaskOutputAllowsAgentMerge(taskOutput: unknown): boolean {
    return (
        !!taskOutput &&
        typeof taskOutput === 'object' &&
        (taskOutput as Record<string, unknown>).allowAgentMerge === true
    );
}

/**
 * The rule, for one Mission-filed Task (or one about to be filed) on one Work. `null` = it may
 * run; any other kind of Work is never refused here. Checked in this order, so the answer names
 * the first thing the owner has to fix:
 *
 *   1. the Agent (`agentMayCommitAndOpenPullRequests`);
 *   2. isolation — `resolveTaskIsolation` itself, asked as the worker will ask it (the Task's
 *      own override, else the Work's setting), so this cannot disagree with the run;
 *   3. the merge policy (`agentMergeAllowed`, the EFFECTIVE `allowAgentMerge` for that Agent on
 *      that Work) unless the Mission opted in.
 *
 * `agentMergeAllowed` may be a function: it is only asked when 1 and 2 pass (it costs a policy
 * read).
 */
export async function decideMissionRepoRun(input: {
    task: { workId?: string | null; isolationMode?: string | null };
    work: { kind?: string | null; taskIsolation?: string | null } | null | undefined;
    agent: MissionRepoRunAgentView | null | undefined;
    agentMergeAllowed: boolean | (() => Promise<boolean>);
    missionAllowsAgentMerge: boolean | (() => Promise<boolean>);
}): Promise<MissionRepoRunRefusal | null> {
    if (!input.work || !isRepositoryWorkKind(input.work.kind ?? null)) return null;
    if (!agentMayCommitAndOpenPullRequests(input.agent)) return 'agent-cannot-open-pull-requests';
    if (resolveTaskIsolation(input.task, input.work, { agentCanCommit: true }) !== 'on') {
        return 'isolation-off';
    }
    const merges =
        typeof input.agentMergeAllowed === 'function'
            ? await input.agentMergeAllowed()
            : input.agentMergeAllowed;
    if (!merges) return null;
    const optedIn =
        typeof input.missionAllowsAgentMerge === 'function'
            ? await input.missionAllowsAgentMerge()
            : input.missionAllowsAgentMerge;
    return optedIn ? null : 'agent-merge-allowed';
}
