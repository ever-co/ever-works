import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sanitiseSlug } from '../k8s.plugin';

const SANITISE_SLUG_CASES = (
	JSON.parse(readFileSync(resolve(__dirname, 'fixtures/sanitise-slug.cases.json'), 'utf-8')) as {
		cases: Array<[string, string]>;
	}
).cases;

/**
 * `sanitiseSlug` turns a project name — the plugin's `projectName` setting, or the Work's
 * website project name passed as `projectNameOverride` — into the Kubernetes object name.
 */
describe('sanitiseSlug', () => {
	/**
	 * CodeQL js/polynomial-redos. Leading and trailing dashes used to be stripped with
	 * `/^-+|-+$/g` BEFORE dash runs were collapsed, and `-+$` backtracks quadratically over a
	 * long run of `-` that is not at the end: every `-` restarts a scan to the end of the run
	 * (50 000 of them took ~2.4 s). Collapsing first leaves no run to rescan.
	 *
	 * Sized, not tightly timed: at 200 000 the old chain needs ~40 s on a dev box and today's
	 * milliseconds, so a 2 s bound can be failed neither by a CPU-throttled CI runner nor passed by
	 * the old chain. (A "< 200 ms" at 50 000 was one scheduler stall from red — develop CI, 2026-10-09.)
	 */
	it('sanitises a name with a long inner run of "-" in linear time', () => {
		const hostile = `a${'-'.repeat(200_000)}a`;

		const started = performance.now();
		const slug = sanitiseSlug(hostile);
		const elapsedMs = performance.now() - started;

		expect(slug).toBe('a-a');
		expect(elapsedMs).toBeLessThan(2_000);
	});

	// The reordered steps must answer exactly what the original chain answered. Truncation
	// after the trim can still end on a dash (the last two cases): kept as it was.
	//
	// The cases live in a fixture because the agent keeps a copy of this function
	// (`normaliseObjectName`, which decides which Works could share a deleted Work's objects)
	// and its spec reads the same file: changing the rule here without the fixture fails
	// this spec, and changing both fails the agent's until its copy follows.
	it.each(SANITISE_SLUG_CASES)('sanitises %j to %j', (input, expected) => {
		expect(sanitiseSlug(input)).toBe(expected);
	});
});
