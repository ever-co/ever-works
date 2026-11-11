import { describe, expect, it } from 'vitest';
import type { GoalDoDCriterion } from '@/lib/api/goals';
import {
    nextGoalDodCriterionId,
    withAddedDodCriterion,
    withoutDodCriterion,
} from './goal-dod.shared';

const criterion = (id: string, extra: Partial<GoalDoDCriterion> = {}): GoalDoDCriterion =>
    ({ id, text: id, status: 'open', source: 'operator', ...extra }) as GoalDoDCriterion;

describe('Definition-of-Done edits apply to the list as stored now', () => {
    it('keeps a criterion the planner proposed after the page loaded when one is added', () => {
        // The page loaded [a]; the planner proposed b since. Adding c must not
        // write [a, c] over the stored [a, b] (it used to).
        const stored = [criterion('a'), criterion('b', { source: 'planner', proposed: true })];
        const next = withAddedDodCriterion(stored, 'Ship the docs');
        expect(next.map((c) => c.id)).toEqual(['a', 'b', 'ship-the-docs']);
        expect(next[2]).toEqual({
            id: 'ship-the-docs',
            text: 'Ship the docs',
            status: 'open',
            source: 'operator',
        });
    });

    it('keeps everyone else’s criteria when one is removed', () => {
        const stored = [criterion('a'), criterion('b', { source: 'planner' }), criterion('c')];
        expect(withoutDodCriterion(stored, 'a').map((c) => c.id)).toEqual(['b', 'c']);
    });

    it('handles an empty list', () => {
        expect(withAddedDodCriterion(null, 'x').map((c) => c.id)).toEqual(['x']);
        expect(withoutDodCriterion(undefined, 'x')).toEqual([]);
    });
});

describe('nextGoalDodCriterionId', () => {
    it('slugs the text and stays unique', () => {
        expect(nextGoalDodCriterionId('Ship it!', new Set())).toBe('ship-it');
        expect(nextGoalDodCriterionId('Ship it!', new Set(['ship-it', 'ship-it-2']))).toBe(
            'ship-it-3',
        );
        expect(nextGoalDodCriterionId('!!!', new Set())).toBe('criterion');
    });
});
