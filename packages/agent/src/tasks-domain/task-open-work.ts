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
 * How long a Task whose pull request was closed without merging still holds its slot of a cap:
 * 24 hours after it last changed (the later of `updatedAt` and `ciCheckedAt`, the sweep's read
 * that saw it close; a closed pull request is never polled again). So closing a loop's pull
 * requests throttles it to at most the cap per day, instead of freeing a slot the moment each
 * closes, and a pull request nobody merges can never hold a slot for good.
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
 */
export function taskActiveRunExists(
    escape: (name: string) => string = (name) => `"${name}"`,
    runAlias = 'open_work_run',
): FindOperator<string> {
    const run = escape(runAlias);
    const statuses = TASK_ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(', ');
    return Raw(
        (alias) =>
            `EXISTS (SELECT 1 FROM ${escape('agent_runs')} ${run} WHERE ${run}.${escape(
                'taskId',
            )} = ${alias} AND ${run}.${escape('status')} IN (${statuses}))`,
    );
}
