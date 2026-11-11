import { In, type EntityManager, type SelectQueryBuilder } from 'typeorm';
import { TaskAssignee } from '../../entities/task-assignee.entity';
import type { Task } from '../../entities/task.entity';

/**
 * Shared rules for "which Agent does an ACTIVE recurring Task drive", used by
 * the Agents card (`AgentRepository.findRecurringTaskDrivers`) and the
 * Mission "Team and agents" panel (standing Tasks on attached Works).
 */

/**
 * Narrow `qb` (alias `alias` on `tasks`) to ACTIVE recurring templates — the
 * Schedules page's `active`: a template (`isRecurring`, no parent), not
 * paused, not past `recurrenceEndsAt`, not out of occurrences, with a next
 * fire time.
 */
export function whereActiveRecurringTemplate<T extends object>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    now: Date,
): SelectQueryBuilder<T> {
    return qb
        .andWhere(`${alias}.isRecurring = :activeRecurring`, { activeRecurring: true })
        .andWhere(`${alias}.parentRecurringTaskId IS NULL`)
        .andWhere(`${alias}.recurrencePausedAt IS NULL`)
        .andWhere(`${alias}.nextOccurrenceAt IS NOT NULL`)
        .andWhere(`(${alias}.recurrenceEndsAt IS NULL OR ${alias}.recurrenceEndsAt > :activeNow)`, {
            activeNow: now,
        })
        .andWhere(
            `(${alias}.recurrenceMaxOccurrences IS NULL OR ${alias}.recurrenceOccurredCount < ${alias}.recurrenceMaxOccurrences)`,
        );
}

/**
 * The Agents each Task drives, in the order the recurrence dispatcher and the
 * Schedules page resolve them: its agent assignees, or — only for a Task with
 * no agent assignee — its own `agentId`. One query for every Task given.
 */
export async function recurringTaskDriverIds(
    manager: EntityManager,
    tasks: ReadonlyArray<Pick<Task, 'id' | 'agentId'>>,
): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (tasks.length === 0) return out;
    const assignees = await manager.find(TaskAssignee, {
        where: { taskId: In(tasks.map((task) => task.id)), assigneeType: 'agent' },
        select: ['taskId', 'assigneeId'],
    });
    const assignedByTask = new Map<string, string[]>();
    for (const row of assignees) {
        assignedByTask.set(row.taskId, [...(assignedByTask.get(row.taskId) ?? []), row.assigneeId]);
    }
    for (const task of tasks) {
        const assigned = assignedByTask.get(task.id) ?? [];
        const drivers = assigned.length > 0 ? assigned : task.agentId ? [task.agentId] : [];
        out.set(task.id, [...new Set(drivers)]);
    }
    return out;
}
