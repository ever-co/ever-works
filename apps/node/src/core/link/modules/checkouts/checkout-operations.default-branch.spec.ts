import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCheckoutGitRunner, type CheckoutGitRunner } from './checkout-git';
import { cloneCheckout } from './checkout-operations';

/**
 * FL-14 FR-16 — a fresh clone with no branch named (the New checkout dialog's
 * default, the CLI without `--branch`, the Agent tool and the API without
 * one) stays on what it cloned: the base ref when given, else the
 * repository's default branch. Real git against a bare repository whose
 * default branch is deliberately not `main`, so the answer is the remote's,
 * never a guess. A tag as the base ref would leave it on no branch, so that
 * is refused.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();

describe('cloneCheckout — no branch named: the clone stays on what it cloned (FL-14 FR-16)', () => {
	let root: string;
	let remote: string;
	let calls: string[][];
	let recording: CheckoutGitRunner;
	let counter = 0;

	beforeAll(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fl14-default-')));
		remote = join(root, 'remote.git');
		const seed = join(root, 'seed');
		git(root, 'init', '--bare', '--initial-branch', 'trunk', remote);
		git(root, 'init', '--initial-branch', 'trunk', seed);
		const commit = (message: string) =>
			git(seed, '-c', 'user.name=Fleet Test', '-c', 'user.email=fleet@test.invalid', 'commit', '-m', message);
		writeFileSync(join(seed, 'README.md'), 'seed\n');
		git(seed, 'add', 'README.md');
		commit('seed');
		git(seed, 'push', remote, 'HEAD:refs/heads/trunk');
		git(seed, 'switch', '-c', 'release');
		writeFileSync(join(seed, 'CHANGELOG.md'), '1.0\n');
		git(seed, 'add', 'CHANGELOG.md');
		commit('release');
		git(seed, 'push', remote, 'HEAD:refs/heads/release');
		git(seed, 'tag', 'v1');
		git(seed, 'push', remote, 'refs/tags/v1');
		const real = createCheckoutGitRunner();
		recording = (args, options) => {
			calls.push([...args]);
			return real(args, options);
		};
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	});

	const target = () => join(root, 'checkouts', `clone-${(counter += 1)}`);
	const localBranches = (path: string) =>
		git(path, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split(/\r?\n/).filter(Boolean);

	it('stays on the repository’s default branch, tracking it, and makes no branch of its own', async () => {
		calls = [];
		const path = target();

		const result = await cloneCheckout({ path, repoUrl: remote, branch: null, baseRef: null }, { git: recording });

		expect(result.code).toBe(0);
		expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trunk');
		expect(git(path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/trunk');
		expect(localBranches(path)).toEqual(['trunk']);
		// Nothing after the clone but a local read that it is on a branch: no switch, no branch named "null".
		expect(calls.map((argv) => argv[0])).toEqual(['clone', 'symbolic-ref']);
	});

	it('stays on the base ref when one is given', async () => {
		const path = target();

		const result = await cloneCheckout(
			{ path, repoUrl: remote, branch: null, baseRef: 'release' },
			{ git: recording }
		);

		expect(result.code).toBe(0);
		expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('release');
		expect(localBranches(path)).toEqual(['release']);
	});

	it('refuses a tag as the base ref, which would leave the clone on no branch, and removes the folder', async () => {
		const path = target();

		const result = await cloneCheckout({ path, repoUrl: remote, branch: null, baseRef: 'v1' }, { git: recording });

		expect(result.code).not.toBe(0);
		expect(result.stderr).toMatch(/^v1 is not a branch/);
		expect(existsSync(path)).toBe(false);
	});
});
