import { afterEach, describe, expect, it, vi } from 'vitest';
import { SKIP_GROWTH_ENV, expectLinearTime, growthStepsSkipped } from './linear-time.js';

/**
 * The guard itself (`linear-time.ts`). Noise must not hide a regression: a
 * stall in a timed batch of the SMALL input makes a step look cheaper than it
 * is, which once let a step stop early with a near-zero growth and end the
 * ladder before the steps that show a quadratic under an input cap (review of
 * #3178: a capped quadratic that fails at 10.2× read 0.019× with one 20 ms
 * stall).
 */

/** Busy for `ms` of wall clock: what a descheduled slice or a collection costs. */
function stall(ms: number): void {
	const end = performance.now() + ms;
	while (performance.now() < end) {
		// spin
	}
}

/** Like the body sanitizer, these read only the first 24,000 characters. */
const CAP = 24_000;

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
		for (let index = start; index < length; index += 32) sum += text.charCodeAt(index);
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
		}
	};
}

const build = (size: number): string => 'a'.repeat(size);

// These time code: skipped where the growth steps are skipped (the contended
// `lint-and-test`), run in the jobs that judge them (see `SKIP_GROWTH_ENV`).
describe.skipIf(growthStepsSkipped())('expectLinearTime under a stall', () => {
	it('fails a quadratic under the cap even when the first timed small batch stalls', () => {
		const stalled = stalledOnce(cappedQuadratic);
		expect(() => expectLinearTime(build, stalled.run, { maxGrowth: 3 })).toThrow(/cost per character grew/);
	});

	it('passes linear code with the same stall and still times every step up to the full size', () => {
		const stalled = stalledOnce(cappedLinear);
		expectLinearTime(build, stalled.run, { maxGrowth: 3 });
		// The large input of every step, past the cap too: no step ended the ladder early.
		for (const size of [4096, 16_384, 65_536, 262_144, 1_048_576]) expect(stalled.sizes.has(size)).toBe(true);
	});
});

/** The contended run (`lint-and-test`): no growth step, the ceiling still holds. No timing is asserted here. */
describe('expectLinearTime with the growth steps skipped', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('builds and runs only the full input, held to the ceiling', () => {
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
			}
		);
		expect(built).toEqual([1_048_576]);
		expect([...ran]).toEqual([1_048_576]);
	});

	it('still fails a run over the ceiling', () => {
		vi.stubEnv(SKIP_GROWTH_ENV, '1');
		const slow = (text: string): number => {
			stall(30);
			return text.length;
		};
		expect(() => expectLinearTime(build, slow, { size: 4096, ceilingMs: 10 })).toThrow(
			/one run on 4096 characters took/
		);
	});

	it('skips them only on exactly `1`: anything else runs them', () => {
		for (const value of ['', '0', 'true', 'yes', ' 1']) {
			vi.stubEnv(SKIP_GROWTH_ENV, value);
			expect(growthStepsSkipped()).toBe(false);
		}
		vi.stubEnv(SKIP_GROWTH_ENV, undefined);
		expect(growthStepsSkipped()).toBe(false);
		vi.stubEnv(SKIP_GROWTH_ENV, '1');
		expect(growthStepsSkipped()).toBe(true);
	});
});
