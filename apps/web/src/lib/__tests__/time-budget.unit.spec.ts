import { describe, expect, it } from 'vitest';
import { expectLinearTime, relativeBudget } from './time-budget';

/**
 * The guards themselves (`time-budget.ts`). Noise must not hide a regression:
 * a stall on the side a measurement is compared with makes it look cheaper
 * (review of #3178: a capped quadratic that fails at 10.2× read 0.019× with
 * one 20 ms stall; a render at 1.5× its budget passed against one slow
 * reference timing).
 */

/** Busy for `ms` of wall clock: what a descheduled slice or a collection costs. */
function stall(ms: number): void {
    const end = performance.now() + ms;
    while (performance.now() < end) {
        // spin
    }
}

/** Like the excerpt, these read only the first 4,096 characters. */
const CAP = 4096;

function cappedLinear(text: string): number {
    const length = Math.min(text.length, CAP);
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += text.charCodeAt(index);
    return sum;
}

function cappedQuadratic(text: string): number {
    const length = Math.min(text.length, CAP);
    let sum = 0;
    for (let start = 0; start < length; start += 1) {
        for (let index = start; index < length; index += 4) sum += text.charCodeAt(index);
    }
    return sum;
}

/**
 * `run` with one 20 ms stall in the first TIMED run of the smallest input (its
 * first run is the untimed warm-up), and every input size it was given.
 */
function stalledOnce(run: (text: string) => number, smallest = 256) {
    const sizes = new Set<number>();
    let smallRuns = 0;
    return {
        sizes,
        run: (text: string): number => {
            sizes.add(text.length);
            if (text.length === smallest && ++smallRuns === 2) stall(20);
            return run(text);
        },
    };
}

const build = (size: number): string => 'a'.repeat(size);

describe('expectLinearTime under a stall', () => {
    it('fails a quadratic under the cap even when the first timed small batch stalls', () => {
        const stalled = stalledOnce(cappedQuadratic);
        expect(() => expectLinearTime(build, stalled.run, { maxGrowth: 4 })).toThrow(
            /cost per character grew/,
        );
    });

    it('passes linear code with the same stall and still times every step up to the full size', () => {
        const stalled = stalledOnce(cappedLinear);
        expectLinearTime(build, stalled.run, { maxGrowth: 4 });
        for (const size of [4096, 16_384, 65_536, 262_144, 1_048_576]) {
            expect(stalled.sizes.has(size)).toBe(true);
        }
    });
});

describe('relativeBudget', () => {
    it('keeps work over budget when one reference timing of its retry is slow', () => {
        let references = 0;
        // 10 ms a reference; the 4th timing (the first one of the first retry,
        // after three to calibrate) is slowed to 40 ms by a burst of load. Judged
        // against that one timing alone, the work would pass (100 < 4 × 40).
        const budget = relativeBudget(() => stall(++references === 4 ? 40 : 10));
        budget.calibrate();
        // 100 ms of work against 4 units of ~10 ms: 2.5× its budget, every time.
        const run = budget.measure(4, () => stall(100));
        expect(run.ms).toBeGreaterThanOrEqual(run.budgetMs);
    });

    it('passes work within budget at once', () => {
        const budget = relativeBudget(() => stall(10));
        budget.calibrate();
        const run = budget.measure(4, () => stall(20));
        expect(run.ms).toBeLessThan(run.budgetMs);
    });

    it('calibrates to the fastest reference timing, for an absolute ceiling', () => {
        let references = 0;
        const budget = relativeBudget(() => stall(++references === 2 ? 5 : 30));
        expect(budget.calibrate()).toBeLessThan(20);
    });
});
