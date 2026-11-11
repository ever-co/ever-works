import type { GoalDoDCriterion } from '@/lib/api/goals';

/** Slugify a criterion's text into a stable, unique id within the Goal. */
export function nextGoalDodCriterionId(text: string, taken: Set<string>): string {
    const base =
        text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 48) || 'criterion';
    if (!taken.has(base)) return base;
    let suffix = 2;
    while (taken.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
}

/**
 * The checklist with one operator criterion added. Applied to the Goal's list
 * as stored NOW (read just before the write), never to the copy the page
 * loaded: `PUT /dod` replaces the whole list, so writing the page's copy
 * dropped every criterion the Goal's planner proposed since the page loaded.
 */
export function withAddedDodCriterion(
    current: readonly GoalDoDCriterion[] | null | undefined,
    text: string,
): GoalDoDCriterion[] {
    const criteria = current ?? [];
    const taken = new Set(criteria.map((entry) => entry.id));
    return [
        ...criteria,
        { id: nextGoalDodCriterionId(text, taken), text, status: 'open', source: 'operator' },
    ];
}

/** The checklist without one criterion — applied to the stored list, as above. */
export function withoutDodCriterion(
    current: readonly GoalDoDCriterion[] | null | undefined,
    criterionId: string,
): GoalDoDCriterion[] {
    return (current ?? []).filter((entry) => entry.id !== criterionId);
}
