import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
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
 *
 * What a planted pool config can do to a credentialed child — the attacks —
 * is `credentialed-command.attacks.spec.ts`.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

type Invocation = { args: string[]; env: NodeJS.ProcessEnv };

const TOKEN = 'ghs_fetchScopedReadTokenSentinel0123456789';
const BASIC = Buffer.from(`x-access-token:${TOKEN}`, 'utf8').toString('base64');

let root: string;
let originDir: string;
/** A bare repository on disk stands in for the remote, as in the push spec. */
let originUrl: string;
let seedDir: string;
let baseDir: string;
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

const valueOf = (entry: Invocation, key: string): string | undefined =>
	configPairs(entry.env)
		.filter(([name]) => name === key)
		.map(([, value]) => value)
		.at(-1);
const carriesHeader = (entry: Invocation): boolean => configPairs(entry.env).some(([key]) => /extraheader$/i.test(key));
const fetchesOf = (invocations: Invocation[]): Invocation[] => invocations.filter((entry) => entry.args[0] === 'fetch');
/** The read of the repository's config that decides whether a credential may be used. */
const configChecks = (invocations: Invocation[]): Invocation[] =>
	invocations.filter((entry) => entry.args.includes('--show-scope') && entry.args.includes('--list'));

function spec(bindingKey: string, branch: string, extra: Partial<WorkspaceProvisionSpec> = {}): WorkspaceProvisionSpec {
	return {
		repoUrl: originUrl,
		baseRef: 'main',
		branch,
		bindingKey,
		settings: { baseDir, fetchDepth: 1 },
		...extra
	};
}

const credential = (): { username: string; token: string; remoteUrl: string } => ({
	username: 'x-access-token',
	token: TOKEN,
	remoteUrl: originUrl
});

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
	git(seedDir, 'push', originUrl, 'HEAD:refs/heads/main');
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
	originUrl = pathToFileURL(originDir).toString();
	git(seedDir, 'init', '--initial-branch', 'main');
	writeFileSync(join(seedDir, 'README.md'), 'hello\n');
	git(seedDir, 'add', '-A');
	git(seedDir, '-c', 'user.name=Seed', '-c', 'user.email=seed@test.local', 'commit', '-m', 'seed');
	git(seedDir, 'push', originUrl, 'HEAD:refs/heads/main');
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('scoped fetch credential — how it reaches git (real git, every child recorded)', () => {
	it('rides the ENVIRONMENT of the fetch children, and of no other child', async () => {
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

		const handle = await plugin.provision(
			spec('fetch-env', 'task/fetch-env-aaaa1111', { hardenRepoHooks: true, fetchCredential: credential() })
		);
		expect(existsSync(join(handle.path, 'README.md'))).toBe(true);

		const fetches = fetchesOf(invocations);
		// The base ref and the task branch: the only two network commands of
		// a provision, and the only two that carry the credential.
		expect(fetches).toHaveLength(2);
		for (const fetch of fetches) {
			const pairs = configPairs(fetch.env);
			// The four entries the scoped PUSH installs, in the same order,
			// after the operator's own entries and after the provision's
			// hardening overlay.
			const at = pairs.findIndex(([key]) => /extraheader$/i.test(key));
			const [helper, askpass, hooks, header] = pairs.slice(at - 3, at + 1);
			expect(helper).toEqual(['credential.helper', '']);
			expect(askpass).toEqual(['core.askpass', '']);
			expect(hooks[0]).toBe('core.hooksPath');
			expect(header).toEqual([`http.${originUrl}.extraheader`, `Authorization: Basic ${BASIC}`]);
			expect(fetch.env.GIT_TERMINAL_PROMPT).toBe('0');
			// The header is the ONLY entry that holds the credential.
			expect(pairs.filter(([, value]) => value.includes(BASIC) || value.includes(TOKEN))).toHaveLength(1);
		}

		// NOT in argv — of any command.
		for (const entry of invocations) {
			expect(entry.args.join('\u0000')).not.toContain(TOKEN);
			expect(entry.args.join('\u0000')).not.toContain(BASIC);
			expect(entry.args.join('\u0000')).not.toContain('x-access-token');
		}

		// And in the environment of NOTHING else: not `init`, not `remote
		// add`, not the ownership probes, not `worktree add` — the command
		// that runs with the repository's own files on disk — and not the
		// pool maintenance that follows the fetches.
		const others = invocations.filter((entry) => entry.args[0] !== 'fetch');
		expect(others.length).toBeGreaterThan(5);
		expect(others.some((entry) => entry.args[0] === 'worktree' && entry.args[1] === 'add')).toBe(true);
		for (const entry of others) {
			expect(JSON.stringify(entry.env)).not.toContain(TOKEN);
			expect(JSON.stringify(entry.env)).not.toContain(BASIC);
			expect(carriesHeader(entry)).toBe(false);
			expect(entry.env.GIT_ALLOW_PROTOCOL).toBeUndefined();
		}
	});

	it('binds the credentialed fetch to ONE transport and to a remote no config file can describe', async () => {
		// The exec-time half of `credentialed-command.ts`, as the child
		// actually received it. None of it depends on what the pool's config
		// says, which is the point: see the attack spec for what it stops.
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

		await plugin.provision(
			spec('fetch-bound', 'task/fetch-bound-1212aaaa', { hardenRepoHooks: true, fetchCredential: credential() })
		);

		const [base, branch] = fetchesOf(invocations);
		// The remote is a PRIVATE name minted per command, never the URL…
		const name = base.args.at(-2) as string;
		expect(name).toMatch(/^ew-credentialed-[0-9a-f-]{36}$/);
		expect(base.args).toEqual([
			'fetch',
			'--no-recurse-submodules',
			'--depth',
			'1',
			name,
			'+refs/heads/main:refs/remotes/origin/main'
		]);
		// …and its only definition is in this child's own environment.
		expect(valueOf(base, `remote.${name}.url`)).toBe(originUrl);
		expect(base.args).not.toContain(originUrl);
		// Each command gets its own.
		expect(branch.args.at(-2)).not.toBe(name);
		expect(valueOf(branch, `remote.${branch.args.at(-2)}.url`)).toBe(originUrl);

		for (const fetch of [base, branch]) {
			// The transport of the URL the credential was issued for — an
			// environment variable, so no `protocol.*.allow` can widen it.
			expect(fetch.env.GIT_ALLOW_PROTOCOL).toBe('file');
			// Nothing the fetch could be made to start.
			expect(valueOf(fetch, 'core.fsmonitor')).toBe('false');
			expect(valueOf(fetch, 'core.alternateRefsCommand')).toBe('');
			expect(valueOf(fetch, 'maintenance.auto')).toBe('false');
			expect(valueOf(fetch, 'gc.auto')).toBe('0');
			expect(valueOf(fetch, 'fetch.recurseSubmodules')).toBe('false');
			expect(valueOf(fetch, 'core.unsetenvvars')).toBeDefined();
		}

		// The pool is still maintained — by a child that carries nothing, and
		// that Git is asked to put in the background (see the maintenance
		// cases below).
		const maintenance = invocations.filter((entry) => entry.args[0] === 'maintenance');
		expect(maintenance.map((entry) => entry.args)).toEqual([
			['maintenance', 'run', '--auto', '--quiet', '--detach']
		]);
		expect(carriesHeader(maintenance[0])).toBe(false);
		expect(invocations.indexOf(maintenance[0])).toBeGreaterThan(invocations.indexOf(branch));
	});

	it('leaves the token in NO file, no Git config and no remote URL', async () => {
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

		const handle = await plugin.provision(
			spec('fetch-disk', 'task/fetch-disk-bbbb2222', { hardenRepoHooks: true, fetchCredential: credential() })
		);
		// It WAS used — otherwise the scan below proves nothing.
		expect(fetchesOf(invocations).every(carriesHeader)).toBe(true);

		// Nothing was ever written down, so there is nothing to clean up and
		// nothing for the model (which runs in this checkout next) to find.
		expect(filesContaining(baseDir, [TOKEN, BASIC])).toEqual([]);
		const poolConfig = git(poolDir(), 'config', '--local', '--list');
		expect(poolConfig.toLowerCase()).not.toContain('extraheader');
		expect(poolConfig.toLowerCase()).not.toContain('credential.');
		// The private remote was never written down either.
		expect(poolConfig).not.toContain('ew-credentialed-');
		// The persisted remote is the literal token-free URL.
		expect(git(poolDir(), 'config', '--get', 'remote.origin.url')).toBe(originUrl);
		expect(git(handle.path, 'config', '--get', 'remote.origin.url')).toBe(originUrl);
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
				fetchCredential: credential()
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
					fetchCredential: { ...credential(), token: 'ghs_hookHarvestSentinelToken0123456789' }
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
					fetchCredential: credential()
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
				`fatal: unable to access '${originUrl}/': header was 'Authorization: Basic ${BASIC}' (${TOKEN})`
			)
		});

		const error = await plugin
			.provision(spec('fetch-scrub', 'task/fetch-scrub-8888bbbb', { fetchCredential: credential() }))
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
				fetchCredential: credential(),
				onFetchCredentialWithheld: (reason) => reasons.push(reason),
				...extra
			})
		);
		return { invocations, reasons, handle };
	}

	/** A withheld credential leaves the two fetches byte-for-byte the plain ones. */
	function expectThePlainFetch(invocations: Invocation[]): void {
		const fetches = fetchesOf(invocations);
		expect(fetches.map((entry) => entry.args.slice(0, -1))).toEqual([
			['fetch', '--depth', '1', originUrl],
			['fetch', originUrl]
		]);
		for (const entry of invocations) {
			expect(carriesHeader(entry)).toBe(false);
			expect(JSON.stringify(entry.env)).not.toContain(TOKEN);
			expect(JSON.stringify(entry.env)).not.toContain(BASIC);
			expect(entry.args.join('\u0000')).not.toContain(TOKEN);
			expect(entry.env.GIT_ALLOW_PROTOCOL).toBeUndefined();
		}
		// No pool maintenance of this provider's own either: the plain fetch
		// runs git's, as it always did.
		expect(invocations.some((entry) => entry.args[0] === 'maintenance')).toBe(false);
	}

	// Each of these in the pool's OWN config could redirect, intercept or
	// answer for a credentialed request, and none is on the allowlist. The
	// pool is the scope a previous run's model can reach through its
	// worktree's `.git` pointer.
	it.each([
		['a persisted credential helper', 'credential.helper', 'store', 'credential.helper'],
		[
			'a second header',
			'http.https://github.com/.extraheader',
			'Authorization: Basic cGxhbnRlZA==',
			'http.<…>.extraheader'
		],
		['a proxy', 'http.proxy', 'http://127.0.0.1:9', 'http.proxy'],
		['TLS verification switched off', 'http.sslVerify', 'false', 'http.sslverify'],
		['a planted CA bundle', 'http.sslCAInfo', '/tmp/planted-ca.pem', 'http.sslcainfo'],
		['a pinned address', 'http.curloptResolve', 'github.com:443:127.0.0.1', 'http.curloptresolve'],
		['a URL rewrite', 'url.https://evil.tld/.insteadOf', 'https://github.com/', 'url.<…>.insteadof'],
		['a push-URL rewrite', 'url.https://evil.tld/.pushInsteadOf', 'https://github.com/', 'url.<…>.pushinsteadof'],
		[
			'a proxy on a remote NAMED by a URL',
			'remote.https://github.com/o/r.git.proxy',
			'http://127.0.0.1:9',
			'remote.<…>.proxy'
		],
		['a transport policy', 'protocol.file.allow', 'always', 'protocol.<…>.allow'],
		['a gc hook', 'gc.recentObjectsHook', 'echo', 'gc.recentobjectshook'],
		['a key nothing here knows', 'ewunknown.setting', 'x', 'ewunknown.setting']
	])('is withheld when the pool config carries %s', async (_label, key, value, reported) => {
		const slug = key
			.replace(/[^a-z0-9]/gi, '')
			.toLowerCase()
			.slice(0, 28);
		git(poolDir(), 'config', '--local', key, value);
		try {
			const { invocations, reasons, handle } = await provisionWithheld(
				`fetch-withheld-${slug}`,
				`task/withheld-${slug}-1111`
			);

			// The provision SUCCEEDED — this is the fallback, not a refusal…
			expect(existsSync(join(handle.path, 'README.md'))).toBe(true);
			// …and Git never saw the credential, in any form, in any child.
			expectThePlainFetch(invocations);
			// The caller is told once, with the key as `section.variable`: a
			// subsection is free text (`url.https://user:token@host/.insteadOf`)
			// and this sentence ends up in a job result.
			expect(reasons).toHaveLength(1);
			expect(reasons[0]).toContain(`(${reported})`);
			expect(reasons[0]).not.toContain('evil.tld');
			expect(reasons[0]).not.toContain('127.0.0.1');
			expect(reasons[0]).not.toContain('github.com');
		} finally {
			git(poolDir(), 'config', '--local', '--unset-all', key);
		}
	});

	it('is withheld when the setting arrives through an `include.path` the pool config names', async () => {
		// `git config --local` skips includes unless told otherwise, so a
		// read restricted that way sees a pool config that says only
		// `include.path = …` as clean while Git itself honours what it pulls in.
		const included = join(root, 'planted.gitconfig');
		writeFileSync(included, '[http]\n\tsslVerify = false\n');
		git(poolDir(), 'config', '--local', 'include.path', included.replace(/\\/g, '/'));
		try {
			const { invocations, reasons } = await provisionWithheld(
				'fetch-withheld-include',
				'task/withheld-include-2222'
			);
			expectThePlainFetch(invocations);
			expect(reasons).toHaveLength(1);
			expect(reasons[0]).toContain('include.path');
			expect(reasons[0]).toContain('http.sslverify');
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
				fetchCredential: { ...credential(), remoteUrl: 'https://github.com/someone-else/private-repo.git' }
			}
		);

		expect(existsSync(join(handle.path, 'README.md'))).toBe(true);
		expectThePlainFetch(invocations);
		expect(reasons).toEqual(['it was issued for a different remote than the one being fetched']);
		// Decided before the pool is even read.
		expect(configChecks(invocations)).toHaveLength(0);
	});

	it('is withheld when the provision already carries per-operation auth', async () => {
		// The cloud path's URL-userinfo form. Its fetch is stubbed to fail:
		// what is asserted is that the scoped credential stayed out of it.
		const invocations: Invocation[] = [];
		const reasons: string[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations, 'fatal: stubbed') });

		await expect(
			plugin.provision(
				spec('fetch-withheld-auth', 'task/withheld-auth-4444', {
					auth: { username: 'x-access-token', token: 'cloud-path-token-value' },
					fetchCredential: credential(),
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

	it('is withheld for a remote no header can authenticate', async () => {
		// `http` would carry the header in clear; for ssh it means nothing.
		// The repository is not even read.
		const invocations: Invocation[] = [];
		const reasons: string[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations, 'fatal: stubbed') });
		const remote = 'http://git.example.test/owner/repo.git';

		await plugin
			.provision({
				...spec('fetch-withheld-scheme', 'task/withheld-scheme-4545'),
				repoUrl: remote,
				settings: { baseDir: join(root, 'http-workspaces'), fetchDepth: 1 },
				fetchCredential: { ...credential(), remoteUrl: remote },
				onFetchCredentialWithheld: (reason) => reasons.push(reason)
			})
			.catch(() => undefined);

		expect(reasons).toEqual(['a scoped credential is an HTTP header, and its remote is not an https URL']);
		expect(configChecks(invocations)).toHaveLength(0);
		for (const entry of invocations) expect(carriesHeader(entry)).toBe(false);
	});

	it('a callback that throws never decides how a repository is fetched', async () => {
		git(poolDir(), 'config', '--local', 'credential.helper', 'store');
		try {
			const invocations: Invocation[] = [];
			const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });
			const handle = await plugin.provision(
				spec('fetch-withheld-throw', 'task/withheld-throw-5555', {
					fetchCredential: credential(),
					onFetchCredentialWithheld: () => {
						throw new Error('reporting is broken');
					}
				})
			);
			expect(existsSync(join(handle.path, 'README.md'))).toBe(true);
			for (const entry of invocations) expect(carriesHeader(entry)).toBe(false);
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
				fetchCredential: credential(),
				onFetchCredentialWithheld: (reason) => reasons.push(reason)
			})
		);

		expect(reasons).toEqual([]);
		expect(fetchesOf(invocations).every(carriesHeader)).toBe(true);
		// One read of the config serves the allowlist and the pins.
		expect(configChecks(invocations)).toHaveLength(1);
		expect(seeded.path).toBeTruthy();
	});
});

describe('no fetch credential — the provision is exactly what it was', () => {
	it('installs nothing, removes nothing and reads nothing', async () => {
		const previous = process.env.GIT_ASKPASS;
		process.env.GIT_ASKPASS = 'ambient-askpass-kept-for-an-ordinary-fetch';
		try {
			const invocations: Invocation[] = [];
			const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });
			await plugin.provision(spec('fetch-none', 'task/fetch-none-7777', { hardenRepoHooks: true }));

			const fetches = fetchesOf(invocations);
			// The exact two commands a provision has always run.
			expect(fetches.map((entry) => entry.args)).toEqual([
				['fetch', '--depth', '1', originUrl, '+refs/heads/main:refs/remotes/origin/main'],
				['fetch', originUrl, '+refs/heads/task/fetch-none-7777:refs/remotes/origin/task/fetch-none-7777']
			]);
			for (const fetch of fetches) {
				// The machine's own Git configuration answers, as it always
				// did: no helper reset, no askpass removal, no header, no
				// transport restriction.
				const keys = configPairs(fetch.env).map(([key]) => key);
				expect(keys).not.toContain('credential.helper');
				expect(keys).not.toContain('core.askpass');
				expect(keys).not.toContain('maintenance.auto');
				expect(keys.some((key) => /extraheader$/i.test(key))).toBe(false);
				expect(keys.some((key) => key.startsWith('remote.'))).toBe(false);
				expect(fetch.env.GIT_ASKPASS).toBe('ambient-askpass-kept-for-an-ordinary-fetch');
				expect(fetch.env.GIT_ALLOW_PROTOCOL).toBeUndefined();
				// Exactly one `core.hooksPath`: the hardening's.
				expect(keys.filter((key) => key === 'core.hooksPath')).toHaveLength(1);
			}
			// The config check and the provider's own maintenance belong to
			// the scoped path only.
			expect(configChecks(invocations)).toHaveLength(0);
			expect(invocations.some((entry) => entry.args[0] === 'maintenance')).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.GIT_ASKPASS;
			else process.env.GIT_ASKPASS = previous;
		}
	});

	it('the scoped PUSH keeps its four entries where they were, with an EMPTY hooks path', async () => {
		// The fetch credential reuses the push's environment builder. This
		// pins what the push keeps: the same four entries at the same
		// positions with the push's own `''` hooks path. What both gained —
		// the entries after them — is the exec-time safety config.
		const handle = await new LocalWorkspacePlugin().provision(spec('fetch-push-pin', 'task/push-pin-8888'));
		writeFileSync(join(handle.path, 'work.txt'), 'work\n');
		const inherited = Number(process.env.GIT_CONFIG_COUNT ?? '0');
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

		const result = await plugin.finalize(handle, {
			commitMessage: 'feat: pinned push',
			push: true,
			pushCredential: credential()
		});

		expect(result.pushed).toBe(true);
		const push = invocations.find((entry) => entry.args[0] === 'push') as Invocation;
		const [helper, askpass, hooks, header] = configPairs(push.env).slice(inherited, inherited + 4);
		expect(helper).toEqual(['credential.helper', '']);
		expect(askpass).toEqual(['core.askpass', '']);
		expect(hooks).toEqual(['core.hooksPath', '']);
		expect(header).toEqual([`http.${originUrl}.extraheader`, `Authorization: Basic ${BASIC}`]);
		// And the same binding the fetch gets.
		const name = push.args.at(-2) as string;
		expect(push.args).toEqual(['push', '--no-verify', name, `HEAD:refs/heads/${handle.branch}`]);
		expect(name).toMatch(/^ew-credentialed-[0-9a-f-]{36}$/);
		expect(valueOf(push, `remote.${name}.url`)).toBe(originUrl);
		expect(push.env.GIT_ALLOW_PROTOCOL).toBe('file');
		expect(valueOf(push, 'push.gpgSign')).toBe('false');
		expect(valueOf(push, 'push.recurseSubmodules')).toBe('no');
	});
});

describe('pool maintenance after a credentialed fetch — it never holds the provision', () => {
	// A credentialed fetch starts no gc of its own (a gc can be made to run a
	// program the pool's config names, with the token in its environment), so
	// the provider runs the maintenance itself afterwards, without the
	// credential. A plain `git fetch` does not WAIT for that maintenance where
	// Git can fork; these cases keep it that way.

	type Answer = (args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void) => boolean;

	/** Real git, except that `git maintenance` is offered to `answer` first. */
	function maintenanceGit(invocations: Invocation[], answer: Answer): typeof execFile {
		return ((
			command: string,
			args: string[],
			options: { env?: NodeJS.ProcessEnv },
			callback: (error: Error | null, stdout: string, stderr: string) => void
		) => {
			invocations.push({ args: [...args], env: { ...(options.env ?? {}) } });
			if (args[0] === 'maintenance' && answer(args, callback)) return { pid: 1 } as never;
			return (execFile as unknown as (...rest: unknown[]) => unknown)(command, args, options, callback) as never;
		}) as never;
	}

	const maintenanceOf = (invocations: Invocation[]): string[][] =>
		invocations.filter((entry) => entry.args[0] === 'maintenance').map((entry) => entry.args);

	it('falls back to the plain command on a Git that has no --detach, where gc detaches itself', async () => {
		// Git before 2.47 answers `--detach` with a usage error (129). There
		// `maintenance run --auto` already goes to the background on its own.
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({
			execFile: maintenanceGit(invocations, (args, callback) => {
				if (!args.includes('--detach')) return false;
				setImmediate(() =>
					callback(Object.assign(new Error('usage'), { code: 129 }), '', "error: unknown option `detach'")
				);
				return true;
			})
		});

		const handle = await plugin.provision(
			spec('fetch-maint-old', 'task/fetch-maint-old-0101', { fetchCredential: credential() })
		);

		expect(handle.baseSha).toMatch(/^[0-9a-f]{40}$/);
		expect(maintenanceOf(invocations)).toEqual([
			['maintenance', 'run', '--auto', '--quiet', '--detach'],
			['maintenance', 'run', '--auto', '--quiet']
		]);
		for (const entry of invocations.filter((candidate) => candidate.args[0] === 'maintenance')) {
			expect(carriesHeader(entry)).toBe(false);
			expect(JSON.stringify(entry.env)).not.toContain(BASIC);
		}
	});

	it('stops waiting at the bound when the maintenance does not return, and the provision succeeds', async () => {
		// What Windows does: Git cannot detach there, so the command IS the gc.
		// Here it never returns at all.
		const invocations: Invocation[] = [];
		const terminated: unknown[] = [];
		const plugin = new LocalWorkspacePlugin({
			execFile: maintenanceGit(invocations, () => true),
			terminateProcessTree: async (child) => {
				terminated.push(child);
			},
			poolMaintenanceTimeoutMs: 200
		});
		const started = Date.now();

		const handle = await plugin.provision(
			spec('fetch-maint-hang', 'task/fetch-maint-hang-0202', { fetchCredential: credential() })
		);

		expect(handle.baseSha).toMatch(/^[0-9a-f]{40}$/);
		expect(existsSync(join(handle.path, 'README.md'))).toBe(true);
		// Bounded: far below the two minutes production allows, let alone "for
		// as long as a gc takes".
		expect(Date.now() - started).toBeLessThan(60_000);
		// The provision stopped WAITING; the maintenance was left to finish —
		// killing it would leave its lock behind (see the case below). And it
		// was tried once, not retried without `--detach`, which would only
		// wait again.
		expect(terminated).toEqual([]);
		expect(maintenanceOf(invocations)).toEqual([['maintenance', 'run', '--auto', '--quiet', '--detach']]);
	});

	it('CONTROL: why it is never killed — a lock a killed maintenance leaves silently disables every later one', () => {
		// What `taskkill /T /F` (or a SIGKILL) leaves of a running `git
		// maintenance`: its lock file, because the process gets no chance to
		// remove it (measured with a real kill on Git for Windows 2.52; made
		// here by hand, so the case does not race a gc). Every later run —
		// this provider's, and the one a plain `git fetch` starts — exits 0
		// and does nothing.
		const repository = mkdtempSync(join(root, 'maint-lock-'));
		git(repository, 'init', '--bare');
		const loose = (): number => Number(/^count: (\d+)$/m.exec(git(repository, 'count-objects', '-v'))?.[1]);
		for (const text of ['one', 'two', 'three']) {
			execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repository, input: `${text}\n` });
		}
		const lock = join(repository, 'objects', 'maintenance.lock');
		writeFileSync(lock, '');

		git(repository, 'maintenance', 'run', '--task=gc', '--quiet');
		expect(loose()).toBe(3);

		// The lock is the only thing in the way.
		rmSync(lock);
		git(repository, 'maintenance', 'run', '--task=gc', '--quiet');
		expect(loose()).toBe(0);
	});

	it('does not turn a failed maintenance into a failed provision', async () => {
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({
			execFile: maintenanceGit(invocations, (_args, callback) => {
				setImmediate(() =>
					callback(Object.assign(new Error('gc failed'), { code: 1 }), '', 'fatal: gc is already running')
				);
				return true;
			})
		});

		const handle = await plugin.provision(
			spec('fetch-maint-fail', 'task/fetch-maint-fail-0303', { fetchCredential: credential() })
		);

		expect(handle.baseSha).toMatch(/^[0-9a-f]{40}$/);
		expect(maintenanceOf(invocations)).toHaveLength(1);
	});

	it('still passes the CALLER’s cancellation on — to the provision, not to the maintenance', async () => {
		// The bound swallows its own timeout, never the caller's abort: the
		// provision stops at once. The maintenance is left to finish, for the
		// same reason it is not killed at the bound.
		const invocations: Invocation[] = [];
		const terminated: unknown[] = [];
		const controller = new AbortController();
		const plugin = new LocalWorkspacePlugin({
			execFile: maintenanceGit(invocations, () => {
				setImmediate(() => controller.abort());
				return true;
			}),
			terminateProcessTree: async (child) => {
				terminated.push(child);
			},
			poolMaintenanceTimeoutMs: 60_000
		});
		const started = Date.now();

		await expect(
			plugin.provision(
				spec('fetch-maint-abort', 'task/fetch-maint-abort-0404', {
					fetchCredential: credential(),
					signal: controller.signal
				})
			)
		).rejects.toThrow();
		expect(controller.signal.aborted).toBe(true);
		// At once, not at the bound.
		expect(Date.now() - started).toBeLessThan(30_000);
		// Nothing ran after the abort: no worktree was added for this Task.
		const after = invocations.slice(invocations.findIndex((entry) => entry.args[0] === 'maintenance') + 1);
		expect(after.some((entry) => entry.args[0] === 'worktree' && entry.args[1] === 'add')).toBe(false);
		expect(terminated).toEqual([]);
	});

	it('runs no maintenance of its own for a plain fetch — that fetch starts its own, as it always did', async () => {
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: maintenanceGit(invocations, () => false) });

		await plugin.provision(spec('fetch-maint-plain', 'task/fetch-maint-plain-0505'));

		expect(maintenanceOf(invocations)).toEqual([]);
	});
});
