import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { LocalWorkspacePlugin } from '../local-workspace.plugin.js';
import type { WorkspaceHandle, WorkspaceProvisionSpec } from '@ever-works/plugin';

/**
 * Scoped FETCH credentials — the read twin of
 * `local-workspace.push-credential.spec.ts`.
 *
 * The assertions that matter are the same negative ones the push spec
 * makes, so they are made the same way: by looking at the exact child
 * process each `git` command became. Every case here runs REAL git against
 * a hermetic origin with every invocation recorded on the way through, so
 * "the token is in no argv, in the environment of the fetches only, and in
 * no file" is read off what actually ran rather than off a fake.
 *
 * And one thing the push spec has no counterpart for: a fetch credential
 * that cannot be offered safely is WITHHELD and the fetch runs exactly as
 * it did before — where a push refuses.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

type Invocation = { args: string[]; env: NodeJS.ProcessEnv };

const TOKEN = 'ghs_fetchScopedReadTokenSentinel0123456789';
const BASIC = Buffer.from(`x-access-token:${TOKEN}`, 'utf8').toString('base64');
/** What the fleet would send: a token-free https GitHub URL. Rewritten to the local origin below. */
const REMOTE = 'https://github.com/ever-works/fetch-credential-fixture.git';
const BLOCKING_PROBE = 'credential';

let root: string;
let originDir: string;
let seedDir: string;
let baseDir: string;
let gitConfigIndex: number;
let commitCounter = 0;

/** Real `execFile`, with every invocation recorded first. */
function recordingGit(invocations: Invocation[], failFetchWith?: string): typeof execFile {
	return ((
		command: string,
		args: string[],
		options: { env?: NodeJS.ProcessEnv },
		callback: (error: Error | null, stdout: string, stderr: string) => void
	) => {
		invocations.push({ args: [...args], env: { ...(options.env ?? {}) } });
		if (failFetchWith !== undefined && args[0] === 'fetch') {
			setImmediate(() =>
				callback(Object.assign(new Error('fetch failed'), { code: 128 }), '', failFetchWith as string)
			);
			return { pid: 1 } as never;
		}
		return (execFile as unknown as (...rest: unknown[]) => unknown)(command, args, options, callback) as never;
	}) as never;
}

/** The `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` pairs a child was handed, in order. */
function configPairs(env: NodeJS.ProcessEnv): Array<[string, string]> {
	const count = Number(env.GIT_CONFIG_COUNT ?? '0');
	const pairs: Array<[string, string]> = [];
	for (let index = 0; index < count; index += 1) {
		pairs.push([String(env[`GIT_CONFIG_KEY_${index}`]), String(env[`GIT_CONFIG_VALUE_${index}`])]);
	}
	return pairs;
}

const carriesHeader = (entry: Invocation): boolean => configPairs(entry.env).some(([key]) => /extraheader$/i.test(key));
const fetchesOf = (invocations: Invocation[]): Invocation[] => invocations.filter((entry) => entry.args[0] === 'fetch');
/** The scoped-credential probe, as opposed to the hardening's own filter-driver probe. */
const credentialProbes = (invocations: Invocation[]): Invocation[] =>
	invocations.filter(
		(entry) => entry.args.includes('--get-regexp') && entry.args.some((arg) => arg.includes(BLOCKING_PROBE))
	);

function spec(bindingKey: string, branch: string, extra: Partial<WorkspaceProvisionSpec> = {}): WorkspaceProvisionSpec {
	return {
		repoUrl: REMOTE,
		baseRef: 'main',
		branch,
		bindingKey,
		settings: { baseDir, fetchDepth: 1 },
		...extra
	};
}

const credential = { username: 'x-access-token', token: TOKEN, remoteUrl: REMOTE };

/** Move the base ref on the origin, so the next fetch really updates a ref. */
function advanceOrigin(): void {
	commitCounter += 1;
	writeFileSync(join(seedDir, `advance-${commitCounter}.txt`), `${commitCounter}\n`);
	git(seedDir, 'add', '-A');
	git(
		seedDir,
		'-c',
		'user.name=Seed',
		'-c',
		'user.email=seed@test.local',
		'commit',
		'-m',
		`advance ${commitCounter}`
	);
	git(seedDir, 'push', pathToFileURL(originDir).toString(), 'HEAD:refs/heads/main');
}

/** The one bare pool this suite's provisions share. */
function poolDir(): string {
	const repos = join(baseDir, 'repos');
	const [only] = readdirSync(repos);
	return join(repos, only);
}

/** Every file under `dir` whose text contains any of `needles`. */
function filesContaining(dir: string, needles: readonly string[]): string[] {
	const offenders: string[] = [];
	const walk = (current: string): void => {
		for (const entry of readdirSync(current)) {
			const full = join(current, entry);
			let stats;
			try {
				stats = statSync(full);
			} catch {
				continue;
			}
			if (stats.isDirectory()) {
				walk(full);
				continue;
			}
			if (stats.size > 4 * 1024 * 1024) continue;
			try {
				const text = readFileSync(full, 'utf8');
				if (needles.some((needle) => text.includes(needle))) offenders.push(full);
			} catch {
				// Binary or unreadable: a token is utf8 text.
			}
		}
	};
	walk(dir);
	return offenders;
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'ew-lw-fetch-'));
	originDir = join(root, 'origin.git');
	seedDir = join(root, 'seed');
	baseDir = join(root, 'workspaces');
	mkdirSync(originDir, { recursive: true });
	mkdirSync(seedDir, { recursive: true });
	git(originDir, 'init', '--bare', '--initial-branch', 'main');
	git(seedDir, 'init', '--initial-branch', 'main');
	writeFileSync(join(seedDir, 'README.md'), 'hello\n');
	git(seedDir, 'add', '-A');
	git(seedDir, '-c', 'user.name=Seed', '-c', 'user.email=seed@test.local', 'commit', '-m', 'seed');
	git(seedDir, 'push', pathToFileURL(originDir).toString(), 'HEAD:refs/heads/main');

	// Real git, no network: the https GitHub URL the fleet would use is
	// rewritten to the test-owned bare repository for child processes only,
	// exactly as the node's own workspace spec does. The credential is keyed
	// to the https URL; git reads from disk.
	gitConfigIndex = Number(process.env.GIT_CONFIG_COUNT ?? '0');
	process.env.GIT_CONFIG_COUNT = String(gitConfigIndex + 1);
	process.env[`GIT_CONFIG_KEY_${gitConfigIndex}`] = `url.${pathToFileURL(originDir).toString()}.insteadOf`;
	process.env[`GIT_CONFIG_VALUE_${gitConfigIndex}`] = REMOTE;
});

afterAll(async () => {
	delete process.env[`GIT_CONFIG_KEY_${gitConfigIndex}`];
	delete process.env[`GIT_CONFIG_VALUE_${gitConfigIndex}`];
	if (gitConfigIndex === 0) delete process.env.GIT_CONFIG_COUNT;
	else process.env.GIT_CONFIG_COUNT = String(gitConfigIndex);
	await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('scoped fetch credential — how it reaches git (real git, every child recorded)', () => {
	it('rides the ENVIRONMENT of the fetch children, and of no other child', async () => {
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

		const handle = await plugin.provision(
			spec('fetch-env', 'task/fetch-env-aaaa1111', { hardenRepoHooks: true, fetchCredential: credential })
		);
		expect(existsSync(join(handle.path, 'README.md'))).toBe(true);

		const fetches = fetchesOf(invocations);
		// The base ref and the task branch: the only two network commands of
		// a provision, and the only two that carry the credential.
		expect(fetches).toHaveLength(2);
		for (const fetch of fetches) {
			const pairs = configPairs(fetch.env);
			// The four entries the scoped PUSH installs, in the same order,
			// appended LAST — after the operator's own entries and after the
			// provision's hardening overlay.
			const [helper, askpass, hooks, header] = pairs.slice(-4);
			expect(helper).toEqual(['credential.helper', '']);
			expect(askpass).toEqual(['core.askpass', '']);
			expect(hooks[0]).toBe('core.hooksPath');
			expect(header).toEqual([`http.${REMOTE}.extraheader`, `Authorization: Basic ${BASIC}`]);
			expect(fetch.env.GIT_TERMINAL_PROMPT).toBe('0');
		}

		// NOT in argv — of any command. And the remote stays the token-free URL.
		for (const entry of invocations) {
			expect(entry.args.join('\u0000')).not.toContain(TOKEN);
			expect(entry.args.join('\u0000')).not.toContain(BASIC);
			expect(entry.args.join('\u0000')).not.toContain('x-access-token');
		}
		expect(fetches[0].args).toContain(REMOTE);

		// And in the environment of NOTHING else: not `init`, not `remote
		// add`, not the ownership probes, not `worktree add` — the command
		// that runs with the repository's own files on disk.
		const others = invocations.filter((entry) => entry.args[0] !== 'fetch');
		expect(others.length).toBeGreaterThan(5);
		expect(others.some((entry) => entry.args[0] === 'worktree' && entry.args[1] === 'add')).toBe(true);
		for (const entry of others) {
			expect(JSON.stringify(entry.env)).not.toContain(TOKEN);
			expect(JSON.stringify(entry.env)).not.toContain(BASIC);
			expect(carriesHeader(entry)).toBe(false);
		}
	});

	it('leaves the token in NO file, no Git config and no remote URL', async () => {
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

		const handle = await plugin.provision(
			spec('fetch-disk', 'task/fetch-disk-bbbb2222', { hardenRepoHooks: true, fetchCredential: credential })
		);
		// It WAS used — otherwise the scan below proves nothing.
		expect(fetchesOf(invocations).every(carriesHeader)).toBe(true);

		// Nothing was ever written down, so there is nothing to clean up and
		// nothing for the model (which runs in this checkout next) to find.
		expect(filesContaining(baseDir, [TOKEN, BASIC])).toEqual([]);
		const poolConfig = git(poolDir(), 'config', '--local', '--list');
		expect(poolConfig.toLowerCase()).not.toContain('extraheader');
		expect(poolConfig.toLowerCase()).not.toContain('credential.');
		// The persisted remote is the literal token-free URL.
		expect(git(poolDir(), 'config', '--get', 'remote.origin.url')).toBe(REMOTE);
		expect(git(handle.path, 'config', '--get', 'remote.origin.url')).toBe(REMOTE);
		expect(git(handle.path, 'status', '--porcelain')).toBe('');
	});

	it('keeps the provision HARDENED: the credential entries repeat the empty hooks directory instead of clearing it', async () => {
		// The credential entries are appended after the hardening overlay,
		// and the last `core.hooksPath` wins. Reset to `''` — what a push
		// uses — it would take the hardening's empty directory away from the
		// one child that now carries a token; `git fetch` runs
		// `reference-transaction` and, through auto-gc, `pre-auto-gc`.
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

		await plugin.provision(
			spec('fetch-hardened', 'task/fetch-hardened-cccc3333', {
				hardenRepoHooks: true,
				fetchCredential: credential
			})
		);

		for (const fetch of fetchesOf(invocations)) {
			const hooksPaths = configPairs(fetch.env)
				.filter(([key]) => key === 'core.hooksPath')
				.map(([, value]) => value);
			// Once from the hardening overlay, once from the credential.
			expect(hooksPaths).toHaveLength(2);
			expect(hooksPaths[1]).not.toBe('');
			expect(hooksPaths[1]).toBe(hooksPaths[0]);
			expect(readdirSync(hooksPaths[1])).toEqual([]);
			// The rest of the overlay is still there, untouched.
			const keys = configPairs(fetch.env).map(([key]) => key);
			expect(keys).toContain('protocol.ext.allow');
			expect(keys).toContain('submodule.recurse');
			expect(keys).toContain('filter.lfs.smudge');
		}
	});

	it('runs NO pool hook on a credentialed fetch, so nothing can read the environment', async () => {
		// The pool is a bare repository; hooks resolve through it, outside
		// every checkout. A `reference-transaction` hook there fires on a
		// fetch that moves a ref and inherits the child's whole environment.
		const first = new LocalWorkspacePlugin();
		await first.provision(spec('fetch-hook-seed', 'task/fetch-hook-seed-dddd4444'));
		const hooksDir = join(poolDir(), 'hooks');
		const receipt = join(root, 'hook-receipt.txt');
		mkdirSync(hooksDir, { recursive: true });
		writeFileSync(
			join(hooksDir, 'reference-transaction'),
			`#!/bin/sh\nenv | grep -i 'GIT_CONFIG_VALUE' >> '${receipt.replace(/\\/g, '/')}'\necho fired >> '${receipt.replace(/\\/g, '/')}'\nexit 0\n`,
			{ mode: 0o755 }
		);

		try {
			// CONTROL — the hook is live: an ordinary, unhardened provision
			// without a credential fires it. Without this the case below
			// could pass for a hook that never runs anywhere.
			advanceOrigin();
			await first.provision(spec('fetch-hook-control', 'task/fetch-hook-control-eeee5555'));
			expect(existsSync(receipt)).toBe(true);
			await fs.rm(receipt, { force: true });

			// The credentialed fetch. `hardenRepoHooks` is deliberately OFF:
			// the credential must not depend on the caller having asked for
			// hardening to keep its own environment away from a hook.
			advanceOrigin();
			const invocations: Invocation[] = [];
			const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });
			await plugin.provision(
				spec('fetch-hook', 'task/fetch-hook-ffff6666', {
					fetchCredential: { ...credential, token: 'ghs_hookHarvestSentinelToken0123456789' }
				})
			);
			expect(fetchesOf(invocations).every(carriesHeader)).toBe(true);

			let harvested: string | null = null;
			try {
				harvested = readFileSync(receipt, 'utf8');
			} catch {
				harvested = null;
			}
			// Either the hook never ran, or it ran only for commands that
			// carry no credential (`worktree add` moves a ref too). What it
			// must never have seen is the header.
			expect(harvested ?? '').not.toContain('Authorization');
			expect(harvested ?? '').not.toContain(
				Buffer.from('x-access-token:ghs_hookHarvestSentinelToken0123456789', 'utf8').toString('base64')
			);
		} finally {
			await fs.rm(join(hooksDir, 'reference-transaction'), { force: true });
			await fs.rm(receipt, { force: true });
		}
	});

	it('removes the ambient askpass and inherited `-c` config from the fetch, and from the fetch only', async () => {
		const previous = {
			ask: process.env.GIT_ASKPASS,
			ssh: process.env.SSH_ASKPASS,
			params: process.env.GIT_CONFIG_PARAMETERS
		};
		// Never executed here: nothing in this suite prompts. They only have
		// to be present in the parent environment.
		process.env.GIT_ASKPASS = 'ambient-askpass-that-must-not-reach-the-fetch';
		process.env.SSH_ASKPASS = 'ambient-ssh-askpass';
		process.env.GIT_CONFIG_PARAMETERS = "'credential.helper='";
		try {
			const invocations: Invocation[] = [];
			const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });
			await plugin.provision(
				spec('fetch-askpass', 'task/fetch-askpass-9999aaaa', {
					hardenRepoHooks: true,
					fetchCredential: credential
				})
			);

			for (const fetch of fetchesOf(invocations)) {
				expect(fetch.env).not.toHaveProperty('GIT_ASKPASS');
				expect(fetch.env).not.toHaveProperty('SSH_ASKPASS');
				expect(fetch.env).not.toHaveProperty('GIT_CONFIG_PARAMETERS');
			}
			// Every other command keeps the operator's environment: none of
			// them carries a token, so none of them needs narrowing.
			const init = invocations.find((entry) => entry.args[0] === 'rev-parse');
			expect(init?.env.GIT_ASKPASS).toBe('ambient-askpass-that-must-not-reach-the-fetch');
		} finally {
			for (const [name, value] of [
				['GIT_ASKPASS', previous.ask],
				['SSH_ASKPASS', previous.ssh],
				['GIT_CONFIG_PARAMETERS', previous.params]
			] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it('scrubs the token — raw AND base64 — out of a failed fetch', async () => {
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({
			execFile: recordingGit(
				invocations,
				`fatal: unable to access '${REMOTE}/': header was 'Authorization: Basic ${BASIC}' (${TOKEN})`
			)
		});

		const error = await plugin
			.provision(spec('fetch-scrub', 'task/fetch-scrub-8888bbbb', { fetchCredential: credential }))
			.then(
				() => null,
				(caught: Error) => caught
			);

		expect(error?.message).toMatch(/fetch of base ref 'main' failed/);
		expect(error?.message).not.toContain(TOKEN);
		expect(error?.message).not.toContain(BASIC);
		expect(error?.message).toContain('***');
	});
});

describe('scoped fetch credential — withheld, never refused: the fetch falls back to what it always was', () => {
	let seeded: WorkspaceHandle;

	beforeAll(async () => {
		// The pool has to exist before anything can be planted in its config.
		seeded = await new LocalWorkspacePlugin().provision(spec('fetch-withheld-seed', 'task/withheld-seed-0000aaaa'));
	});

	async function provisionWithheld(
		bindingKey: string,
		branch: string,
		extra: Partial<WorkspaceProvisionSpec> = {}
	): Promise<{ invocations: Invocation[]; reasons: string[]; handle: WorkspaceHandle }> {
		const invocations: Invocation[] = [];
		const reasons: string[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });
		const handle = await plugin.provision(
			spec(bindingKey, branch, {
				hardenRepoHooks: true,
				fetchCredential: credential,
				onFetchCredentialWithheld: (reason) => reasons.push(reason),
				...extra
			})
		);
		return { invocations, reasons, handle };
	}

	function expectNoCredentialAnywhere(invocations: Invocation[]): void {
		expect(fetchesOf(invocations)).toHaveLength(2);
		for (const entry of invocations) {
			expect(carriesHeader(entry)).toBe(false);
			expect(JSON.stringify(entry.env)).not.toContain(TOKEN);
			expect(JSON.stringify(entry.env)).not.toContain(BASIC);
			expect(entry.args.join('\u0000')).not.toContain(TOKEN);
		}
	}

	// Each of these in the pool's OWN config could redirect, intercept or
	// answer for a credentialed request. The pool is the scope a previous
	// run's model can reach through its worktree's `.git` pointer, and none
	// of these is ever legitimate there: this plugin creates it with `init
	// --bare` and only adds `remote.origin.*`.
	it.each([
		['a persisted credential helper', 'credential.helper', 'store', 'credential.*'],
		['a second header', `http.${REMOTE}.extraheader`, 'Authorization: Basic cGxhbnRlZA==', 'http.*'],
		['a proxy', 'http.proxy', 'http://127.0.0.1:9', 'http.*'],
		['TLS verification switched off', 'http.sslVerify', 'false', 'http.*'],
		['a pinned address', 'http.curloptResolve', 'github.com:443:127.0.0.1', 'http.*'],
		['a URL rewrite', 'url.https://evil.tld/.insteadOf', 'https://github.com/', 'url.*.insteadOf'],
		['a push-URL rewrite', 'url.https://evil.tld/.pushInsteadOf', 'https://github.com/', 'url.*.insteadOf'],
		['a proxy on a remote NAMED by the URL', `remote.${REMOTE}.proxy`, 'http://127.0.0.1:9', 'remote.*.proxy']
	])('is withheld when the pool config carries %s', async (_label, key, value, family) => {
		const slug = key
			.replace(/[^a-z0-9]/gi, '')
			.toLowerCase()
			.slice(0, 24);
		git(poolDir(), 'config', '--local', key, value);
		try {
			const { invocations, reasons, handle } = await provisionWithheld(
				`fetch-withheld-${slug}`,
				`task/withheld-${slug}-1111`
			);

			// The provision SUCCEEDED — this is the fallback, not a refusal…
			expect(existsSync(join(handle.path, 'README.md'))).toBe(true);
			// …and Git never saw the credential, in any form, in any child.
			expectNoCredentialAnywhere(invocations);
			// The caller is told once, by FAMILY: a key's subsection is free
			// text (`url.https://user:token@host/.insteadOf`), and this
			// sentence ends up in a job result.
			expect(reasons).toHaveLength(1);
			expect(reasons[0]).toContain(family);
			expect(reasons[0]).not.toContain('evil.tld');
			expect(reasons[0]).not.toContain('127.0.0.1');
			expect(reasons[0]).not.toContain(REMOTE);
		} finally {
			git(poolDir(), 'config', '--local', '--unset-all', key);
		}
	});

	it('is withheld when the setting arrives through an `include.path` the pool config names', async () => {
		// `git config --local` skips includes unless told otherwise, so a
		// probe without `--includes` reads a pool config that says only
		// `include.path = …` as clean while Git itself honours what it pulls in.
		const included = join(root, 'planted.gitconfig');
		writeFileSync(included, '[http]\n\tsslVerify = false\n');
		git(poolDir(), 'config', '--local', 'include.path', included.replace(/\\/g, '/'));
		try {
			const { invocations, reasons } = await provisionWithheld(
				'fetch-withheld-include',
				'task/withheld-include-2222'
			);
			expectNoCredentialAnywhere(invocations);
			expect(reasons).toHaveLength(1);
			expect(reasons[0]).toContain('http.*');
			expect(credentialProbes(invocations)[0].args).toContain('--includes');
		} finally {
			git(poolDir(), 'config', '--local', '--unset-all', 'include.path');
		}
	});

	it('is withheld when it was issued for a different remote than the one being fetched', async () => {
		// The header is keyed to `remoteUrl`. A credential scoped to one
		// repository has no business near the fetch of another — the same
		// byte-identical test the push applies to `origin`.
		const { invocations, reasons, handle } = await provisionWithheld(
			'fetch-withheld-remote',
			'task/withheld-remote-3333',
			{
				fetchCredential: { ...credential, remoteUrl: 'https://github.com/someone-else/private-repo.git' }
			}
		);

		expect(existsSync(join(handle.path, 'README.md'))).toBe(true);
		expectNoCredentialAnywhere(invocations);
		expect(reasons).toEqual(['it was issued for a different remote than the one being fetched']);
		// Decided before the pool is even probed.
		expect(credentialProbes(invocations)).toHaveLength(0);
	});

	it('is withheld when the provision already carries per-operation auth', async () => {
		// The cloud path's URL-userinfo form. Its fetch is stubbed to fail:
		// a URL carrying userinfo is not the one this suite rewrites to disk,
		// and a hermetic spec must not reach the network to find that out.
		const invocations: Invocation[] = [];
		const reasons: string[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations, 'fatal: stubbed') });

		await expect(
			plugin.provision(
				spec('fetch-withheld-auth', 'task/withheld-auth-4444', {
					auth: { username: 'x-access-token', token: 'cloud-path-token-value' },
					fetchCredential: credential,
					onFetchCredentialWithheld: (reason) => reasons.push(reason)
				})
			)
		).rejects.toThrow(/fetch of base ref 'main' failed/);

		expect(fetchesOf(invocations).length).toBeGreaterThan(0);
		for (const entry of invocations) {
			expect(carriesHeader(entry)).toBe(false);
			expect(JSON.stringify(entry.env)).not.toContain(TOKEN);
		}
		expect(reasons).toEqual(['this provision already carries per-operation auth']);
	});

	it('a callback that throws never decides how a repository is fetched', async () => {
		git(poolDir(), 'config', '--local', 'credential.helper', 'store');
		try {
			const invocations: Invocation[] = [];
			const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });
			const handle = await plugin.provision(
				spec('fetch-withheld-throw', 'task/withheld-throw-5555', {
					fetchCredential: credential,
					onFetchCredentialWithheld: () => {
						throw new Error('reporting is broken');
					}
				})
			);
			expect(existsSync(join(handle.path, 'README.md'))).toBe(true);
			expectNoCredentialAnywhere(invocations);
		} finally {
			git(poolDir(), 'config', '--local', '--unset-all', 'credential.helper');
		}
	});

	it('uses the credential again once the pool config is clean', async () => {
		// The withholding is a property of the pool at that moment, not a
		// latch: nothing about the cases above is remembered.
		const invocations: Invocation[] = [];
		const reasons: string[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });
		await plugin.provision(
			spec('fetch-clean-again', 'task/clean-again-6666', {
				hardenRepoHooks: true,
				fetchCredential: credential,
				onFetchCredentialWithheld: (reason) => reasons.push(reason)
			})
		);

		expect(reasons).toEqual([]);
		expect(fetchesOf(invocations).every(carriesHeader)).toBe(true);
		expect(credentialProbes(invocations)).toHaveLength(1);
		expect(seeded.path).toBeTruthy();
	});
});

describe('no fetch credential — the provision is exactly what it was', () => {
	it('installs nothing, removes nothing and probes nothing', async () => {
		const previous = process.env.GIT_ASKPASS;
		process.env.GIT_ASKPASS = 'ambient-askpass-kept-for-an-ordinary-fetch';
		try {
			const invocations: Invocation[] = [];
			const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });
			await plugin.provision(spec('fetch-none', 'task/fetch-none-7777', { hardenRepoHooks: true }));

			const fetches = fetchesOf(invocations);
			expect(fetches).toHaveLength(2);
			for (const fetch of fetches) {
				// The machine's own Git configuration answers, as it always
				// did: no helper reset, no askpass removal, no header.
				const keys = configPairs(fetch.env).map(([key]) => key);
				expect(keys).not.toContain('credential.helper');
				expect(keys).not.toContain('core.askpass');
				expect(keys.some((key) => /extraheader$/i.test(key))).toBe(false);
				expect(fetch.env.GIT_ASKPASS).toBe('ambient-askpass-kept-for-an-ordinary-fetch');
				// Exactly one `core.hooksPath`: the hardening's.
				expect(keys.filter((key) => key === 'core.hooksPath')).toHaveLength(1);
			}
			// The scoped-credential probe belongs to the scoped path only.
			expect(credentialProbes(invocations)).toHaveLength(0);
		} finally {
			if (previous === undefined) delete process.env.GIT_ASKPASS;
			else process.env.GIT_ASKPASS = previous;
		}
	});

	it('the scoped PUSH is untouched: still four entries, still an EMPTY hooks path', async () => {
		// The fetch credential reuses the push's environment builder with
		// one parameter added. This pins that the parameter's default is the
		// push's old value, so the push did not move.
		const handle = await new LocalWorkspacePlugin().provision(spec('fetch-push-pin', 'task/push-pin-8888'));
		writeFileSync(join(handle.path, 'work.txt'), 'work\n');
		// What the push itself reads back: `remote get-url` applies this
		// suite's rewrite, and the push credential must match it byte for byte.
		const pushRemote = git(handle.path, 'remote', 'get-url', 'origin');
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

		const result = await plugin.finalize(handle, {
			commitMessage: 'feat: pinned push',
			push: true,
			pushCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: pushRemote }
		});

		expect(result.pushed).toBe(true);
		const push = invocations.find((entry) => entry.args[0] === 'push');
		const [helper, askpass, hooks, header] = configPairs(push?.env ?? {}).slice(-4);
		expect(helper).toEqual(['credential.helper', '']);
		expect(askpass).toEqual(['core.askpass', '']);
		expect(hooks).toEqual(['core.hooksPath', '']);
		expect(header).toEqual([`http.${pushRemote}.extraheader`, `Authorization: Basic ${BASIC}`]);
		expect(Number(push?.env.GIT_CONFIG_COUNT)).toBe(gitConfigIndex + 1 + 4);
	});
});
