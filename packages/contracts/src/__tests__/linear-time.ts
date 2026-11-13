import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { expect } from 'vitest';

/**
 * A time guard a busy machine cannot fail: "this stays LINEAR on hostile
 * input", checked without a wall-clock budget.
 *
 * The specs that use it pin that a function never blows up on adversarial
 * text — a quadratic scan or a backtracking pattern turns 1 MB into minutes.
 * "1 MB in under 50 ms" says that on an idle laptop, but a loaded CI runner is
 * several times slower and fails it with nothing wrong (stage CI, round 21:
 * 58–216 ms against 50 ms, on the best of three runs). So the machine is
 * compared with itself, a few milliseconds apart:
 *
 *  - Growth. ONE input of size 16n is timed against SIXTEEN inputs of size n
 *    of the same shape: the same number of characters, so a linear function
 *    answers about 1 and a quadratic one about 16, however fast the machine is
 *    right now. A step starts at every ×4 from {@link DEFAULT_MIN_SIZE}
 *    characters up to the full size, smallest first, so a quadratic under an
 *    input cap (a function that reads only the first 24,000 characters) is
 *    measured just below the cap, and a failing step fails before the large
 *    inputs run. Every step runs: a path that only starts past a size (a
 *    branch for summaries over 32,000 characters) is timed too.
 *  - A ceiling. One run on the full input stays under {@link DEFAULT_CEILING_MS}:
 *    far above what a linear pass over 1 MB costs on any machine.
 *
 * Both sides of a step span the same wall-clock time (batched to at least
 * {@link MIN_SAMPLE_MS}), are timed alternately, and only the best of each
 * side over a few rounds counts, so a descheduled slice or a garbage
 * collection on one side is not read as growth; a step over its bound is timed
 * once more from a clean heap (see {@link collect}). Noise can also make a
 * step look CHEAPER: a stall in the small side's batches. So a step may stop
 * early only on the fastest small batch, which a stall cannot lower. Both
 * sides read the same shape, so they allocate alike too: comparing hostile
 * input with DIFFERENT (ordinary) input of the same size was tried and is not
 * load-proof — on two busy CPUs the ratio of the two moved from 1.2× to 14×.
 *
 * {@link DEFAULT_MAX_GROWTH} sits between the two: a function that switches
 * to a costlier path past an input cap grows up to ~3× on the step that
 * crosses the cap, idle or under load, and a quadratic one grows 16×. Code
 * without such a path can pass a tighter `maxGrowth`.
 *
 * Where the growth steps are judged. All of the above holds on a busy machine,
 * not on an oversubscribed one: in `lint-and-test` (`.github/workflows/ci.yml`)
 * turbo runs every package's tests at once, each vitest with its own pool, in
 * one pod, and linear code read 4.2–10.0× there on every stage run of rounds
 * 26 and 26b (5, 46, 1 and 18 failures), while `node-contract-gate` ran the
 * same commit's suite green in 26 s. That step sets {@link SKIP_GROWTH_ENV}, so
 * there only the ceiling runs, on the full input; the growth steps run in the
 * jobs that run this package alone: `node-contract-gate` in ci.yml and
 * `node-contract` in promotion-gate.yml.
 */

/**
 * Set to `1` to skip the growth steps (see above). Only the `run test on all
 * packages` step of `lint-and-test` sets it (turbo.json passes it to `test`);
 * any other value, or none, runs them. Read on every call.
 */
export const SKIP_GROWTH_ENV = 'EW_TEST_SKIP_LINEAR_TIME_GROWTH';

/** Whether this run skips the growth steps and checks only the ceiling. */
export function growthStepsSkipped(): boolean {
	return process.env[SKIP_GROWTH_ENV] === '1';
}

/** Size ratio between the two inputs of one growth step. */
const FACTOR = 16;
/** A growth step starts at every ×4 (see above). */
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

/** Keeps every result reachable, so no engine can drop a run as dead code. */
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
			})
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
	what: string
): number {
	// Warm-up: compiles the patterns, flattens the built strings, settles the JIT.
	sink = light();
	let single = expectUnderCeiling(heavy, ceilingMs, what);
	for (let run = 1; run < SIZING_RUNS; run += 1) {
		single = Math.min(
			single,
			timed(() => {
				sink = heavy();
			})
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
			if (round > 1 || !Number.isFinite(timedHeavy)) bestHeavy = Math.min(bestHeavy, timeBatch(heavy));
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
 * `build` makes, and that one run on the full input stays under the ceiling.
 * `build(size)` must answer the SAME shape at every size. With
 * {@link SKIP_GROWTH_ENV} set to `1`, only the ceiling is checked.
 */
export function expectLinearTime<T>(
	build: (size: number) => T,
	run: (input: T) => unknown,
	options: LinearTimeOptions = {}
): void {
	const size = options.size ?? DEFAULT_SIZE;
	const minSize = options.minSize ?? DEFAULT_MIN_SIZE;
	const maxGrowth = options.maxGrowth ?? DEFAULT_MAX_GROWTH;
	const ceilingMs = options.ceilingMs ?? DEFAULT_CEILING_MS;

	const smallSizes: number[] = [];
	if (!growthStepsSkipped()) {
		for (let small = size / FACTOR; small >= minSize; small /= RUNG) smallSizes.unshift(Math.floor(small));
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
			`${small * FACTOR} characters`
		);
		expect(
			growth,
			`cost per character grew ${growth.toFixed(1)}× from ${small} to ${small * FACTOR} characters ` +
				`(linear ≈ 1×, quadratic ≈ ${FACTOR}×)`
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
