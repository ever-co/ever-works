import { describe, expect, it } from 'vitest';
import { ONBOARDING_DEFAULT_STATE } from '@ever-works/contracts/api';
import { __test__ } from './useOnboardingFlow';

const { reduce } = __test__;

function fresh() {
    return {
        state: ONBOARDING_DEFAULT_STATE,
        history: [] as number[],
        stepIndex: 0,
        refreshNonce: 0,
    };
}

describe('useOnboardingFlow — the prompt-first quick start', () => {
    it('enters the quick start with the hand-off prompt and kind, without walking to the last step', () => {
        const next = reduce(fresh(), {
            type: 'startQuickStart',
            prompt: 'AI robots directory',
            kind: 'directory',
        });

        expect(next.quickStart).toEqual({ kind: 'directory' });
        expect(next.state.prompt).toBe('AI robots directory');
        // The 11-step wizard is not advanced: nothing is marked as visited and
        // no step is recorded as the last one seen.
        expect(next.stepIndex).toBe(0);
        expect(next.history).toEqual([]);
        expect(next.state.lastStep).toBe(ONBOARDING_DEFAULT_STATE.lastStep);
    });

    it('opens the full wizard from its first step, keeping the prompt, on "Customize setup"', () => {
        const quick = reduce(fresh(), { type: 'startQuickStart', prompt: 'A blog', kind: 'blog' });
        const full = reduce(
            { ...quick, stepIndex: 4, history: [0, 1] },
            { type: 'customizeSetup' },
        );

        expect(full.quickStart).toBeUndefined();
        expect(full.stepIndex).toBe(0);
        expect(full.history).toEqual([]);
        expect(full.state.prompt).toBe('A blog');
        // The chip picked on the home page still decides the Work kind.
        expect(full.handoffKind).toBe('blog');
    });

    it('starts in the full wizard when there was no hand-off', () => {
        expect(fresh()).not.toHaveProperty('quickStart');
        expect(reduce(fresh(), { type: 'goNext' }).quickStart).toBeUndefined();
    });
});
