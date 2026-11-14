import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
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
 *    super-linear below a cap. The reference itself gets an absolute ceiling
 *    from the spec, so a regression that slows ordinary work too cannot raise
 *    its own budget unseen.
 *
 * Every comparison times both sides over the same span of wall clock,
 * alternately, and keeps only the best of each side over a few rounds (or,
 * for a budget, times both again side by side), so a descheduled slice or a
 * garbage collection on one side is not read as a regression; a comparison
 * over its bound is timed once more from a clean heap (see {@link collect}).
 * Noise can also make work look CHEAPER (a stall on the side it is compared
 * with), so every early decision rests on the fastest timing of that side.
 *
 * Where the growth and ratio comparisons are judged. All of the above holds on
 * a busy machine, not on an oversubscribed one: in `lint-and-test`
 * (`.github/workflows/ci.yml`) turbo runs every package's tests at once in one
 * pod, and `MarkdownContent.budget.unit.spec.tsx` failed 2 tests there under
 * load (stage CI, round 26b) with nothing wrong. That step sets
 * {@link SKIP_GROWTH_ENV} to `1`, so there:
 *
 *  - {@link expectLinearTime} skips its growth steps and checks only the
 *    ceiling, on one run over the full input;
 *  - {@link RelativeBudget.measure} runs the work once and does not judge it
 *    against the reference (`budgetMs` is `Infinity`). The absolute ceilings
 *    stay: {@link RelativeBudget.calibrate} is untouched, so a spec that holds
 *    it under its own ceiling (the reference render) still does.
 *
 * The comparisons run uncontended in the CI step that runs this app's unit
 * specs on their own with the variable set to `0` (a separate step in
 * `ci.yml`, added alongside this change). Any value other than exactly `1`, or
 * none, runs the full guard.
 */

/**
 * Set to `1` to skip the growth and ratio comparisons (see above). Any other
 * value, or none, runs them. Read on every call.
 */
export const SKIP_GROWTH_ENV = 'EW_TEST_SKIP_LINEAR_TIME_GROWTH';

/** Whether this run skips the growth and ratio comparisons and keeps only the ceilings. */
export function growthStepsSkipped(): boolean {
    return process.env[SKIP_GROWTH_ENV] === '1';
}

let sink: unknown;

/** The engine's own `gc`, made reachable on first use; `null` where it cannot be. */
let gcFunction: (() => void) | null | undefined;

/**
 * A full collection. On two busy CPUs a collection cycle that earlier work
 * left running landed in the timed batches of one side and read 5–17× growth
 * on a linear function. `gc` is made reachable here (`--expose-gc` set at run
 * time, then read from a fresh context) rather than by a worker flag, which a
 * thread pool refuses; where neither works, this is a no-op.
 */
function collect(): void {
    if (gcFunction === undefined) {
        try {
            setFlagsFromString('--expose-gc');
            gcFunction = runInNewContext('gc') as () => void;
        } catch {
            gcFunction = null;
        }
    }
    gcFunction?.();
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
 * A growth step starts at every ×4 from the smallest size up to the full
 * size, so whatever an input cap is, one step ends between a quarter of the
 * cap and the cap: a quadratic under it is measured where it has grown most.
 * Every step runs: a path that only starts past a size is timed too.
 */
const RUNG = 4;
/** Shortest timed sample, in ms: short runs are batched until a sample lasts this long. */
const MIN_SAMPLE_MS = 3;
/** Runs of the large input that size the batch: the best one counts, not one slow cold run. */
const SIZING_RUNS = 2;
/** Light slices a round times before it may stop early (see `costRatio`). */
const EARLY_EXIT_SLICES = 3;
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
 * timed side by side in rounds. A round stops early when even the FASTEST of
 * at least {@link EARLY_EXIT_SLICES} light slices puts the ratio clearly under
 * `bound`: a stall in a light slice makes the light side look slower and the
 * ratio look lower, and the fastest slice is the one number a stall cannot
 * move. Over the bound, the rounds run once more from a clean heap: a
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
    let single = expectUnderCeiling(heavy, ceilingMs, what);
    for (let run = 1; run < SIZING_RUNS; run += 1) {
        single = Math.min(
            single,
            timed(() => {
                sink = heavy();
            }),
        );
    }
    const batch = Math.min(1000, Math.max(1, Math.ceil(MIN_SAMPLE_MS / Math.max(single, 0.001))));
    const timeBatch = (work: () => unknown): number =>
        timed(() => {
            for (let index = 0; index < batch; index += 1) sink = work();
        });
    // A batch of one run is what the sizing runs timed already: the first
    // round counts them instead of timing the large input again.
    const rounds = (timedHeavy = Number.POSITIVE_INFINITY): number => {
        let bestHeavy = timedHeavy;
        let bestLight = Number.POSITIVE_INFINITY;
        let fastestSlice = Number.POSITIVE_INFINITY;
        const lightFloor = (): number => Math.min(bestLight, fastestSlice * repeats);
        for (let round = 1; round <= MAX_ROUNDS; round += 1) {
            if (round > 1 || !Number.isFinite(timedHeavy)) {
                bestHeavy = Math.min(bestHeavy, timeBatch(heavy));
            }
            let lightTotal = 0;
            for (let slice = 1; slice <= repeats; slice += 1) {
                const lightSlice = timeBatch(light);
                lightTotal += lightSlice;
                fastestSlice = Math.min(fastestSlice, lightSlice);
                // `slice` slices at the fastest pace are a floor for the light time
                // so far; clearly under the bound against it: the rest is skipped.
                // Never on fewer slices than EARLY_EXIT_SLICES, so one or two stalled
                // slices cannot be the fastest.
                if (slice >= EARLY_EXIT_SLICES && bestHeavy < (bound / 2) * fastestSlice * slice) {
                    return bestHeavy / (fastestSlice * repeats);
                }
            }
            bestLight = Math.min(bestLight, lightTotal);
            // Within the bound on two rounds: done. Anything else is timed again.
            // Judged against the fastest slice too: a stall in every round's light
            // total cannot make the large input look cheap.
            if (round >= MIN_ROUNDS && bestHeavy < bound * lightFloor()) break;
        }
        return bestHeavy / lightFloor();
    };
    const ratio = rounds(batch === 1 ? single : Number.POSITIVE_INFINITY);
    if (ratio < bound) return ratio;
    collect();
    return Math.min(ratio, rounds());
}

/**
 * Assert that `run` costs linear time (or less) in the size of the inputs
 * `build` makes, and that one run on the full input stays under
 * {@link DEFAULT_CEILING_MS}. `build(size)` must answer the SAME shape at every
 * size. With {@link SKIP_GROWTH_ENV} set to `1`, only the ceiling is checked.
 *
 * ONE input of size 16n is timed against SIXTEEN inputs of size n of the same
 * shape: the same number of characters, so a linear function answers about 1
 * and a quadratic one about 16, however fast the machine is right now. A step
 * starts at every ×4 from {@link DEFAULT_MIN_SIZE} characters, smallest first,
 * so a quadratic under an input cap (a function that reads only the first
 * 4 KB) is measured just below the cap and fails before the large inputs run.
 * Both sides read the same shape, so they allocate alike too: comparing
 * hostile input with DIFFERENT (ordinary) input of the same size was tried and
 * is not load-proof — on two busy CPUs the ratio of the two moved from 0.8× to
 * 3.9×.
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
    if (!growthStepsSkipped()) {
        for (let small = size / FACTOR; small >= minSize; small /= RUNG) {
            smallSizes.unshift(Math.floor(small));
        }
    }
    let fullSizeChecked = false;
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
        // The warm runs of every step are held to the ceiling (see `costRatio`).
        if (small * FACTOR === size) fullSizeChecked = true;
    }

    if (!fullSizeChecked) {
        const full = build(size);
        expectUnderCeiling(() => run(full), ceilingMs, `${size} characters`);
    }
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
    /**
     * Times the reference {@link UNIT_SAMPLES} times. Answers the FASTEST of
     * them, in ms: what to hold against an absolute ceiling, so a regression
     * that slows the reference itself cannot raise every budget unseen.
     */
    calibrate(): number;
    /**
     * Times `work` against `units` references. Over budget, the work is timed
     * again between two fresh timings of the reference (up to {@link RETRIES}
     * times) and judged against the FASTER of the two: a burst of load between
     * the work and the unit is not read as a regression, and one burst on a
     * reference timing cannot raise the budget either. The attempt with the
     * best ratio is answered. Assert `ms < budgetMs`. With {@link SKIP_GROWTH_ENV}
     * set to `1` the work runs once, unjudged: `budgetMs` is `Infinity`.
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
        let fastest = Number.POSITIVE_INFINITY;
        for (let run = 0; run < UNIT_SAMPLES; run += 1) {
            fastest = Math.min(fastest, sampleReference());
        }
        return fastest;
    };
    return {
        calibrate,
        measure<T>(units: number, work: () => T): BudgetedRun<T> {
            if (growthStepsSkipped()) {
                let skipped = undefined as T;
                const took = timed(() => {
                    skipped = work();
                });
                return { value: skipped, ms: took, budgetMs: Number.POSITIVE_INFINITY };
            }
            if (samples.length === 0) calibrate();
            else if (++sinceSample >= UNIT_REFRESH) sampleReference();
            let value = undefined as T;
            const ms = timed(() => {
                value = work();
            });
            let best: BudgetedRun<T> = { value, ms, budgetMs: units * unit() };
            for (let retry = 0; retry < RETRIES && best.ms >= best.budgetMs; retry += 1) {
                // The machine may be busier than when the unit was timed: time the
                // work again between two reference timings and judge it against
                // the faster one.
                collect();
                const before = sampleReference();
                const again = timed(() => {
                    value = work();
                });
                const after = sampleReference();
                const attempt = { value, ms: again, budgetMs: units * Math.min(before, after) };
                if (attempt.ms / attempt.budgetMs < best.ms / best.budgetMs) best = attempt;
            }
            return best;
        },
    };
}
