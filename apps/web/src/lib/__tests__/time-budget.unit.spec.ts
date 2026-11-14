import { afterEach, describe, expect, it, vi } from 'vitest';
import { SKIP_GROWTH_ENV, expectLinearTime, growthStepsSkipped, relativeBudget } from './time-budget';

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

// These time code: skipped where the growth steps are skipped (the contended
// `lint-and-test`), run in the step that judges them (see `SKIP_GROWTH_ENV`).
describe.skipIf(growthStepsSkipped())('expectLinearTime under a stall', () => {
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
    // Wall-clock spins overshoot when the process is descheduled, so every
    // margin below is wide enough for a busy runner to leave the verdict alone.
    it.skipIf(growthStepsSkipped())('keeps work over budget when one reference timing of its retry is slow', () => {
        let references = 0;
        // 10 ms a reference; the 4th timing (the first one of the first retry,
        // after three to calibrate) is slowed to 150 ms by a burst of load. Judged
        // against that one timing alone, the work would pass (200 < 2 × 150).
        const budget = relativeBudget(() => stall(++references === 4 ? 150 : 10));
        budget.calibrate();
        // 200 ms of work against 2 units of ~10 ms: 10× its budget, every time.
        const run = budget.measure(2, () => stall(200));
        expect(run.ms).toBeGreaterThanOrEqual(run.budgetMs);
    });

    it.skipIf(growthStepsSkipped())('passes work within budget at once', () => {
        const budget = relativeBudget(() => stall(10));
        budget.calibrate();
        // 10 ms of work against 10 units of ~10 ms.
        const run = budget.measure(10, () => stall(10));
        expect(run.ms).toBeLessThan(run.budgetMs);
    });

    it('calibrates to the fastest reference timing, for an absolute ceiling', () => {
        let references = 0;
        const budget = relativeBudget(() => stall(++references === 2 ? 5 : 150));
        expect(budget.calibrate()).toBeLessThan(100);
    });
});

/** The contended run (`lint-and-test`): no growth or ratio comparison, the ceilings still hold. */
describe('the guards with the growth steps skipped', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('expectLinearTime builds and runs only the full input', () => {
        vi.stubEnv(SKIP_GROWTH_ENV, '1');
        const built: number[] = [];
        const ran = new Set<number>();
        expectLinearTime(
            (size) => {
                built.push(size);
                return build(size);
            },
            (text) => {
                ran.add(text.length);
                return cappedLinear(text);
            },
        );
        expect(built).toEqual([1_048_576]);
        expect([...ran]).toEqual([1_048_576]);
    });

    it('expectLinearTime still fails a run over the ceiling', () => {
        vi.stubEnv(SKIP_GROWTH_ENV, '1');
        const slow = (text: string): number => {
            stall(30);
            return text.length;
        };
        expect(() => expectLinearTime(build, slow, { size: 4096, ceilingMs: 10 })).toThrow(
            /one run on 4096 characters took/,
        );
    });

    it('relativeBudget.measure runs the work once and does not judge it against the reference', () => {
        vi.stubEnv(SKIP_GROWTH_ENV, '1');
        let references = 0;
        let works = 0;
        const budget = relativeBudget(() => {
            references += 1;
            stall(1);
        });
        // 30 ms of work against 1 unit of ~1 ms: over budget in the full guard.
        const run = budget.measure(1, () => {
            works += 1;
            stall(30);
            return 'done';
        });
        expect(run.value).toBe('done');
        expect(run.ms).toBeGreaterThanOrEqual(30);
        expect(run.budgetMs).toBe(Number.POSITIVE_INFINITY);
        expect(works).toBe(1);
        expect(references).toBe(0);
    });

    it('relativeBudget.calibrate still times the reference, for its absolute ceiling', () => {
        vi.stubEnv(SKIP_GROWTH_ENV, '1');
        let references = 0;
        const budget = relativeBudget(() => {
            references += 1;
            stall(1);
        });
        expect(budget.calibrate()).toBeGreaterThanOrEqual(1);
        expect(references).toBe(3);
    });

    it('skips only on exactly `1`: anything else runs the full guard', () => {
        for (const value of ['', '0', 'true', 'yes', ' 1']) {
            vi.stubEnv(SKIP_GROWTH_ENV, value);
            expect(growthStepsSkipped()).toBe(false);
        }
        vi.stubEnv(SKIP_GROWTH_ENV, undefined);
        expect(growthStepsSkipped()).toBe(false);
        vi.stubEnv(SKIP_GROWTH_ENV, '1');
        expect(growthStepsSkipped()).toBe(true);
    });

    // These two run the full guard, so they time code: like the specs above they
    // are skipped in the contended job (the real variable is read when collected).
    it.skipIf(growthStepsSkipped()).each(['0', undefined])('runs every growth step when the variable is %s', (value) => {
        vi.stubEnv(SKIP_GROWTH_ENV, value);
        const sizes = new Set<number>();
        expectLinearTime(build, (text) => {
            sizes.add(text.length);
            return cappedLinear(text);
        }, { maxGrowth: 4 });
        for (const size of [4096, 16_384, 65_536, 262_144, 1_048_576]) expect(sizes.has(size)).toBe(true);
    });

    it.skipIf(growthStepsSkipped())('relativeBudget.measure judges against the reference when the variable is unset or `0`', () => {
        for (const value of ['0', undefined]) {
            vi.stubEnv(SKIP_GROWTH_ENV, value);
            const budget = relativeBudget(() => stall(10));
            budget.calibrate();
            const run = budget.measure(2, () => stall(200));
            expect(Number.isFinite(run.budgetMs)).toBe(true);
            expect(run.ms).toBeGreaterThanOrEqual(run.budgetMs);
        }
    });
});
