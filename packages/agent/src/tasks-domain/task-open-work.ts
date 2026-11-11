import { Raw, type FindOperator } from 'typeorm';

/**
 * The pieces two "how many of these Tasks are still open?" caps share: a Mission's
 * `openTasksCap` per Work (`missions/mission-tick.service.ts`, `missionOpenTasksWhere`) and a
 * recurring template's `recurrenceMaxOpenInstances` (`recurrence-overlap.ts`,
 * `recurrenceOpenInstancesWhere`).
 *
 * A leaf on purpose (typeorm only): the Task repository reads it, and the Mission tick imports
 * the Tasks domain, so the rule cannot live in either service file.
 */

/** A Task's cached pull-request state once the pull request was closed WITHOUT merging. */
export const TASK_CLOSED_UNMERGED_PR_STATE = 'closed';

/**
 * A Task's cached pull-request state once the git provider answered "not found" for its pull
 * request: the repository or the pull request was deleted, or the connection can no longer see
 * it (a provider answers "not found" for a private repository it does not show you). Written by
 * the PR-status read (`TaskPrStatusService.refreshTask`). Like `closed` and `merged`, the sweep
 * never polls it again (`TaskRepository.findDuePrStatusSync` reads only null / open / draft); the
 * on-demand read re-checks it, and a new pull request on the Task resets it.
 */
export const TASK_PR_NOT_FOUND_STATE = 'not_found';

/**
 * How long a Task whose pull request was closed without merging still holds its slot of a cap:
 * 24 hours after it last changed (the later of `updatedAt` and `ciCheckedAt`, the sweep's read
 * that saw it close; a closed pull request is never polled again, and the sweep's write keeps
 * `updatedAt`). So closing a loop's pull requests throttles it to at most the cap per day,
 * instead of freeing a slot the moment each closes, and a pull request nobody merges can never
 * hold a slot for good.
 */
export const TASK_CLOSED_PR_SLOT_HOLD_MS = 24 * 60 * 60 * 1000;

/**
 * The run statuses that mean "a run of this Task is queued or running". A run parked on a
 * question for a human (`agent_runs.awaitingInput`) is still `running`, so it is covered.
 */
export const TASK_ACTIVE_RUN_STATUSES = ['queued', 'running'] as const;

/**
 * `id` EXISTS a queued or running `agent_runs` row for the Task: "a run is in flight, whatever
 * the status says". `escape` quotes an identifier for the connection's driver (Postgres, SQLite
 * and MySQL quote differently); the two statuses are constants, inlined as literals. `runAlias`
 * names the sub-query's table so two caps never collide in one statement.
 *
 * `opts.startedSince` bounds it: only a run that started (or, never started, was queued) at or
 * after that instant counts — `COALESCE(startedAt, createdAt)`, the same age the run sweeper
 * measures. Without it the SQL is exactly what it always was (the Mission cap's).
 */
export function taskActiveRunExists(
    escape: (name: string) => string = (name) => `"${name}"`,
    runAlias = 'open_work_run',
    opts: { startedSince?: Date } = {},
): FindOperator<string> {
    const run = escape(runAlias);
    const statuses = TASK_ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(', ');
    const inFlight = (alias: string) =>
        `${run}.${escape('taskId')} = ${alias} AND ${run}.${escape('status')} IN (${statuses})`;
    if (!opts.startedSince) {
        return Raw(
            (alias) =>
                `EXISTS (SELECT 1 FROM ${escape('agent_runs')} ${run} WHERE ${inFlight(alias)})`,
        );
    }
    const parameter = `${runAlias}_since`;
    return Raw(
        (alias) =>
            `EXISTS (SELECT 1 FROM ${escape('agent_runs')} ${run} WHERE ${inFlight(alias)} AND ` +
            `COALESCE(${run}.${escape('startedAt')}, ${run}.${escape('createdAt')}) >= :${parameter})`,
        { [parameter]: opts.startedSince },
    );
}
