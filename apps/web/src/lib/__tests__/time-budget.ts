import { expect } from 'vitest';

/**
 * Time guards a busy machine cannot fail, for specs that pin that hostile
 * input never keeps a page busy (PR #3137). A fixed number of milliseconds
 * says that on an idle laptop, but a loaded CI runner is several times slower
 * and fails it with nothing wrong (stage CI, round 21: 1 MB excerpts at
 * 51–94 ms against 50, a render that takes 114 ms here at 1,206 ms against
 * 500). Both guards compare the machine with itself instead.
 *
 *  - {@link expectLinearTime}: the cost of a pure function grows no faster
 *    than its input. For code that must be linear.
 *  - {@link relativeBudget}: a budget counted in runs of a REFERENCE, ordinary
 *    work of the same kind timed in the same process. For limits that are
 *    absolute by nature ("every description the renderer accepts renders in
 *    a fraction of a second"), where the code under them is allowed to be
 *    super-linear below a cap.
 *
 * Every comparison times both sides over the same span of wall clock,
 * alternately, and keeps only the best of each side over a few rounds (or,
 * for a budget, times both again side by side), so a descheduled slice or a
 * garbage collection on one side is not read as a regression; a comparison
 * over its bound is timed once more from a clean heap (see {@link collect}).
 */

let sink: unknown;

/**
 * A full collection, when the runner exposes one (`--expose-gc`, see
 * `vitest.config.ts`); a no-op without the flag. On two busy CPUs a
 * collection cycle that earlier work left running landed in the timed batches
 * of one side and read 5–17× growth on a linear function.
 */
function collect(): void {
    (globalThis as { gc?: () => void }).gc?.();
}

function timed(work: () => void): number {
    const started = performance.now();
    work();
    return performance.now() - started;
}

// ─── Linear time ──────────────────────────────────────────────────────────

/** Size ratio between the two inputs of one growth step. */
const FACTOR = 16;
/**
 * A growth step starts at every ×4 from the smallest size, so whatever an
 * input cap is, one step ends between a quarter of the cap and the cap: a
 * quadratic under it is measured where it has grown most.
 */
const RUNG = 4;
/** A step under this growth is flat: the input is past every cap, the larger steps measure nothing new. */
const FLAT = 1 / RUNG;
/** Shortest timed sample, in ms: short runs are batched until a sample lasts this long. */
const MIN_SAMPLE_MS = 3;
/** Rounds of (heavy batch, light batches); only the best of each side counts. */
const MIN_ROUNDS = 2;
const MAX_ROUNDS = 7;
/** Runs a ceiling check may take: one stalled run on a busy machine is not a blowup. */
const CEILING_ATTEMPTS = 3;

export const DEFAULT_SIZE = 1024 * 1024;
export const DEFAULT_MIN_SIZE = 256;
/**
 * Between linear and quadratic: a function that switches to a costlier path
 * past an input cap grows up to ~3× on the step that crosses it, idle or
 * under load; a quadratic one grows {@link FACTOR}×.
 */
export const DEFAULT_MAX_GROWTH = 6;
export const DEFAULT_CEILING_MS = 2000;

export interface LinearTimeOptions {
    /** The largest input, in characters. */
    size?: number;
    /** The smallest input of the ladder. */
    minSize?: number;
    /** How much the cost per character may grow over one step of the ladder. */
    maxGrowth?: number;
    /** The most one run on the largest input may take, in ms. */
    ceilingMs?: number;
}

/**
 * One run of `work` under the ceiling: the best of up to {@link CEILING_ATTEMPTS}
 * runs, stopping at the first one under it (a single stalled run on a starved
 * CPU took 7.6 s for 10 ms of work). A real blowup is over on every attempt.
 */
function expectUnderCeiling(work: () => unknown, ceilingMs: number, what: string): number {
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < CEILING_ATTEMPTS && best >= ceilingMs; attempt += 1) {
        best = Math.min(
            best,
            timed(() => {
                sink = work();
            }),
        );
    }
    expect(best, `one run on ${what} took ${best.toFixed(0)} ms`).toBeLessThan(ceilingMs);
    return best;
}

/**
 * The best time of `heavy` over the best time of `repeats` runs of `light`,
 * timed side by side in rounds; stops as soon as the answer is clearly under
 * `bound`. Over the bound, the rounds run once more from a clean heap: a
 * collection cycle that earlier work left running is not the function's cost,
 * a super-linear cost is over again. Fails first when warm runs of `heavy`
 * stay over the ceiling.
 */
function costRatio(
    heavy: () => unknown,
    light: () => unknown,
    repeats: number,
    bound: number,
    ceilingMs: number,
    what: string,
): number {
    // Warm-up: compiles the patterns, flattens the built strings, settles the JIT.
    sink = light();
    const single = expectUnderCeiling(heavy, ceilingMs, what);
    const batch = Math.min(1000, Math.max(1, Math.ceil(MIN_SAMPLE_MS / Math.max(single, 0.001))));
    const timeBatch = (work: () => unknown): number =>
        timed(() => {
            for (let index = 0; index < batch; index += 1) sink = work();
        });
    const rounds = (): number => {
        let bestHeavy = Number.POSITIVE_INFINITY;
        let bestLight = Number.POSITIVE_INFINITY;
        for (let round = 1; round <= MAX_ROUNDS; round += 1) {
            bestHeavy = Math.min(bestHeavy, timeBatch(heavy));
            // `repeats` slices of light work. Once the slices so far put the ratio
            // under half the bound, the rest could only lower it: skipped, and the
            // ratio answered is extrapolated from the slices timed.
            let lightTotal = 0;
            for (let slice = 1; slice <= repeats; slice += 1) {
                lightTotal += timeBatch(light);
                if (bestHeavy < (bound / 2) * lightTotal) {
                    return (bestHeavy * slice) / (lightTotal * repeats);
                }
            }
            bestLight = Math.min(bestLight, lightTotal);
            // Within the bound on two rounds: done. Anything else is timed again.
            if (round >= MIN_ROUNDS && bestHeavy < bound * bestLight) break;
        }
        return bestHeavy / bestLight;
    };
    const ratio = rounds();
    if (ratio < bound) return ratio;
    collect();
    return Math.min(ratio, rounds());
}

/**
 * Assert that `run` costs linear time (or less) in the size of the inputs
 * `build` makes, and that one run on the full input stays under
 * {@link DEFAULT_CEILING_MS}. `build(size)` must answer the SAME shape at every
 * size.
 *
 * ONE input of size 16n is timed against SIXTEEN inputs of size n of the same
 * shape: the same number of characters, so a linear function answers about 1
 * and a quadratic one about 16, however fast the machine is right now. A step
 * starts at every ×4 from {@link DEFAULT_MIN_SIZE} characters, smallest first,
 * so a quadratic under an input cap (a function that reads only the first
 * 4 KB) is measured just below the cap and fails before the large inputs run;
 * a step that shows the cost flat (the input is past every cap) ends the
 * ladder. Both sides read the same shape, so they allocate alike too:
 * comparing hostile input with DIFFERENT (ordinary) input of the same size was
 * tried and is not load-proof — on two busy CPUs the ratio of the two moved
 * from 0.8× to 3.9×.
 */
export function expectLinearTime<T>(
    build: (size: number) => T,
    run: (input: T) => unknown,
    options: LinearTimeOptions = {},
): void {
    const size = options.size ?? DEFAULT_SIZE;
    const minSize = options.minSize ?? DEFAULT_MIN_SIZE;
    const maxGrowth = options.maxGrowth ?? DEFAULT_MAX_GROWTH;
    const ceilingMs = options.ceilingMs ?? DEFAULT_CEILING_MS;

    const smallSizes: number[] = [];
    for (let small = size / FACTOR; small >= minSize; small /= RUNG) {
        smallSizes.unshift(Math.floor(small));
    }
    for (const small of smallSizes) {
        const smallInput = build(small);
        const largeInput = build(small * FACTOR);
        const growth = costRatio(
            () => run(largeInput),
            () => run(smallInput),
            FACTOR,
            maxGrowth,
            ceilingMs,
            `${small * FACTOR} characters`,
        );
        expect(
            growth,
            `cost per character grew ${growth.toFixed(1)}× from ${small} to ` +
                `${small * FACTOR} characters (linear ≈ 1×, quadratic ≈ ${FACTOR}×)`,
        ).toBeLessThan(maxGrowth);
        if (growth < FLAT) break;
    }

    const full = build(size);
    expectUnderCeiling(() => run(full), ceilingMs, `${size} characters`);
    void sink;
}

// ─── Relative budget ──────────────────────────────────────────────────────

/** Extra side-by-side attempts for a measurement over budget. */
const RETRIES = 2;
/** Measurements between two timings of the reference. */
const UNIT_REFRESH = 8;
/** Recent reference times kept; the unit is their median. */
const UNIT_SAMPLES = 3;

export interface BudgetedRun<T> {
    /** What the work answered (on the attempt judged). */
    value: T;
    /** Its time, in ms. */
    ms: number;
    /** The budget it is judged against, in ms: `units` references. */
    budgetMs: number;
}

export interface RelativeBudget {
    /** Times the reference {@link UNIT_SAMPLES} times. Answers the unit, in ms. */
    calibrate(): number;
    /**
     * Times `work` against `units` references. Over budget, the reference and
     * the work are timed again side by side (up to {@link RETRIES} times), so a
     * burst of load between the two is not read as a regression; the attempt
     * with the best ratio is answered. Assert `ms < budgetMs`.
     */
    measure<T>(units: number, work: () => T): BudgetedRun<T>;
}

/**
 * A wall-clock budget counted in runs of `reference`: a machine three times
 * slower right now gets three times the milliseconds, and a regression (a cap
 * raised past what the code under it can take, a quadratic pass) is over on
 * every attempt.
 *
 * The unit is the median of the last {@link UNIT_SAMPLES} reference times, and
 * the reference is timed again every {@link UNIT_REFRESH} measurements: a unit
 * timed once, early, under load (or before the JIT warmed up) would make every
 * later budget too generous, and timing it before every measurement would
 * double the cost of a suite that is slow on a busy runner already. Call
 * {@link RelativeBudget.calibrate} once the code is warm.
 */
export function relativeBudget(reference: () => unknown): RelativeBudget {
    const samples: number[] = [];
    let sinceSample = 0;
    const sampleReference = (): number => {
        const ms = timed(() => {
            sink = reference();
        });
        samples.push(ms);
        if (samples.length > UNIT_SAMPLES) samples.shift();
        sinceSample = 0;
        return ms;
    };
    const unit = (): number => {
        const sorted = [...samples].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
    };
    const calibrate = (): number => {
        for (let run = 0; run < UNIT_SAMPLES; run += 1) sampleReference();
        return unit();
    };
    return {
        calibrate,
        measure<T>(units: number, work: () => T): BudgetedRun<T> {
            if (samples.length === 0) calibrate();
            else if (++sinceSample >= UNIT_REFRESH) sampleReference();
            let value = undefined as T;
            const ms = timed(() => {
                value = work();
            });
            let best: BudgetedRun<T> = { value, ms, budgetMs: units * unit() };
            for (let retry = 0; retry < RETRIES && best.ms >= best.budgetMs; retry += 1) {
                // The machine may be busier than when the unit was timed: time
                // both again, next to each other, and judge them together.
                collect();
                const unitMs = sampleReference();
                const again = timed(() => {
                    value = work();
                });
                const attempt = { value, ms: again, budgetMs: units * unitMs };
                if (attempt.ms / attempt.budgetMs < best.ms / best.budgetMs) best = attempt;
            }
            return best;
        },
    };
}
