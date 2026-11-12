import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCheckoutGitRunner, type CheckoutGitRunner } from './checkout-git';
import { cloneCheckout } from './checkout-operations';

/**
 * FL-14 create × FL-15 FR-20 — the node's half of **Fix on computer** with a
 * fresh clone of a pull request whose head branch another checkout already
 * holds. The platform cannot see a fresh clone's remote, so it sends the
 * branch the person asked for (`existingBranch`) and a unique new name
 * (`branch`, FR-19); the node picks once its clone shows what the remote has.
 *
 * Real git throughout, against a bare repository on disk, with every child
 * recorded: the claims are read off what actually ran.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();

const HEAD_BRANCH = 'nina/fix-login';
const SENTINEL = 'Authorization: Basic c2VudGluZWwtdG9rZW4tZm9yLXRoZS1jbG9uZQ==';
/** The shape the scoped credential reaches git in (environment only), with a value we can look for. */
const CREDENTIAL_ENV = {
	GIT_CONFIG_COUNT: '1',
	GIT_CONFIG_KEY_0: 'http.extraHeader',
	GIT_CONFIG_VALUE_0: SENTINEL
};

type Invocation = { args: string[]; env: Readonly<Record<string, string>> | undefined };

describe('cloneCheckout — a fresh clone of a pull request keeps its branch (FL-15 FR-20)', () => {
	let root: string;
	let remote: string;
	let headSha: string;
	let invocations: Invocation[];
	let recording: CheckoutGitRunner;
	let counter = 0;

	beforeAll(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), 'fl14-clone-')));
		remote = join(root, 'remote.git');
		const seed = join(root, 'seed');
		git(root, 'init', '--bare', '--initial-branch', 'main', remote);
		git(root, 'init', '--initial-branch', 'main', seed);
		const commit = (message: string) =>
			git(seed, '-c', 'user.name=Fleet Test', '-c', 'user.email=fleet@test.invalid', 'commit', '-m', message);
		writeFileSync(join(seed, 'README.md'), 'seed\n');
		git(seed, 'add', 'README.md');
		commit('seed');
		git(seed, 'push', remote, 'HEAD:refs/heads/main');
		git(seed, 'switch', '-c', HEAD_BRANCH);
		writeFileSync(join(seed, 'login.ts'), 'export const fixed = true;\n');
		git(seed, 'add', 'login.ts');
		commit('fix login');
		git(seed, 'push', remote, `HEAD:refs/heads/${HEAD_BRANCH}`);
		headSha = git(seed, 'rev-parse', 'HEAD');
		const real = createCheckoutGitRunner();
		invocations = [];
		recording = (args, options) => {
			invocations.push({ args: [...args], env: options.env });
			return real(args, options);
		};
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
	});

	const target = () => join(root, 'checkouts', `clone-${(counter += 1)}`);
	const branchOf = (path: string) => git(path, 'rev-parse', '--abbrev-ref', 'HEAD');
	const upstreamOf = (path: string) => git(path, 'rev-parse', '--abbrev-ref', '@{upstream}');
	const localBranches = (path: string) =>
		git(path, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split(/\r?\n/).filter(Boolean);

	it('checks out the head branch the remote has, tracking it — not the suffixed name', async () => {
		invocations = [];
		const path = target();
		const result = await cloneCheckout(
			{
				path,
				repoUrl: remote,
				branch: `${HEAD_BRANCH}-2`,
				baseRef: null,
				existingBranch: HEAD_BRANCH
			},
			{ git: recording, credentialEnv: CREDENTIAL_ENV }
		);

		expect(result.code).toBe(0);
		expect(branchOf(path)).toBe(HEAD_BRANCH);
		expect(upstreamOf(path)).toBe(`origin/${HEAD_BRANCH}`);
		expect(git(path, 'rev-parse', 'HEAD')).toBe(headSha);
		expect(localBranches(path)).not.toContain(`${HEAD_BRANCH}-2`);

		// The credential reached git only through the clone's environment: never argv, never a local command.
		expect(invocations.some((call) => call.args.join(' ').includes(SENTINEL))).toBe(false);
		const credentialed = invocations.filter((call) => call.env?.GIT_CONFIG_VALUE_0 === SENTINEL);
		expect(credentialed.map((call) => call.args[0])).toEqual(['clone']);
		// One network command: the remote check is the clone's own refs, read locally.
		expect(invocations.filter((call) => ['clone', 'fetch', 'ls-remote'].includes(call.args[0]))).toHaveLength(1);
	});

	it('checks it out even when another clone on this computer is already on it (a clone is its own repository)', async () => {
		const first = target();
		const second = target();
		expect(
			(
				await cloneCheckout(
					{ path: first, repoUrl: remote, branch: HEAD_BRANCH, baseRef: null },
					{ git: recording }
				)
			).code
		).toBe(0);
		expect(branchOf(first)).toBe(HEAD_BRANCH);

		const result = await cloneCheckout(
			{ path: second, repoUrl: remote, branch: `${HEAD_BRANCH}-2`, baseRef: null, existingBranch: HEAD_BRANCH },
			{ git: recording }
		);

		expect(result.code).toBe(0);
		expect(branchOf(second)).toBe(HEAD_BRANCH);
		expect(branchOf(first)).toBe(HEAD_BRANCH);
	});

	it('makes the unique NEW branch when the remote does not have the asked one (FR-19)', async () => {
		const path = target();
		const result = await cloneCheckout(
			{ path, repoUrl: remote, branch: 'nina/gone-2', baseRef: 'main', existingBranch: 'nina/gone' },
			{ git: recording }
		);

		expect(result.code).toBe(0);
		expect(branchOf(path)).toBe('nina/gone-2');
		expect(localBranches(path)).not.toContain('nina/gone');
		expect(git(path, 'rev-parse', 'HEAD')).toBe(git(path, 'rev-parse', 'origin/main'));
	});

	it('without existingBranch (an older platform) makes exactly the branch it was given', async () => {
		const path = target();
		const result = await cloneCheckout(
			{ path, repoUrl: remote, branch: `${HEAD_BRANCH}-2`, baseRef: null },
			{ git: recording }
		);

		expect(result.code).toBe(0);
		expect(branchOf(path)).toBe(`${HEAD_BRANCH}-2`);
	});
});
