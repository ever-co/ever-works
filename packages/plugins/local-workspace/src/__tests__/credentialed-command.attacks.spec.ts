import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { effectiveRemoteUrls, parseScopedConfigList } from '../credentialed-command.js';
import { LocalWorkspacePlugin } from '../local-workspace.plugin.js';
import type { WorkspaceHandle, WorkspaceProvisionSpec } from '@ever-works/plugin';

/**
 * A repository's own Git config against a credentialed child — every case
 * here is an ATTACK, run with real git, and judged by what a planted
 * program actually got to read.
 *
 * WHY THIS FILE EXISTS. The scoped fetch credential first judged the pool's
 * config with a denylist. An independent review planted two keys that are
 * on no denylist — `remote.<url>.url` (a local path) and
 * `remote.<url>.uploadpack` (a harvester) — and read the token out of the
 * transport's environment; the merged scoped PUSH had the same hole through
 * `remote.<url>.receivepack`, with a `contents: write` token. Both are the
 * first cases below.
 *
 * HOW A CASE IS JUDGED. Each planted program appends every environment line
 * mentioning `Authorization` to a RECEIPT file and a line to a RAN file. So
 * "the token did not leak" is read off the receipt (absent or empty), never
 * off a verdict the code under test produced, and "the program did not even
 * run" is a separate, stronger fact.
 *
 * Every vector is run three ways:
 *
 *  - **control** — plain `git`, with the header in its environment and none
 *    of this provider's protections: the program runs and the receipt holds
 *    the header. Without this a case could pass because the plant was inert
 *    on this machine's git.
 *  - **planted before the run** — the allowlist sees it. A fetch withholds
 *    its credential (and runs as it always did); a push refuses.
 *  - **planted between the check and the command** — what a concurrent job
 *    on the same pool can do. The allowlist saw a clean config, the
 *    credential IS used, and only the exec-time layer stands: the program
 *    must not run at all.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

type Invocation = { args: string[]; env: NodeJS.ProcessEnv };

const TOKEN = 'ghs_attackSpecTokenSentinel0123456789abcdef';
const BASIC = Buffer.from(`x-access-token:${TOKEN}`, 'utf8').toString('base64');
const HEADER = `Authorization: Basic ${BASIC}`;
/**
 * What the fleet really sends: an https URL. Nothing listens there — port 1
 * on loopback refuses at once — so a command that correctly ignores a
 * planted redirect fails fast instead of reaching a network.
 */
const HTTPS_REMOTE = 'https://127.0.0.1:1/ever-works/credentialed-command-fixture.git';

let root: string;
let originDir: string;
let originUrl: string;
let decoyDir: string;
let originHead: string;
let decoyHead: string;
let caseCounter = 0;

const slash = (path: string): string => path.replace(/\\/g, '/');

/** A fresh, isolated place for one case: its own pool, receipt and marker. */
function scene() {
	caseCounter += 1;
	const dir = mkdtempSync(join(root, `case-${caseCounter}-`));
	const receipt = slash(join(dir, 'receipt.txt'));
	const ran = slash(join(dir, 'ran.txt'));
	/** Shell that records what it can see of the credential, then that it ran. */
	const harvest = `env | grep -F Authorization >> '${receipt}'; echo ran >> '${ran}';`;
	let programs = 0;
	return {
		dir,
		baseDir: join(dir, 'workspaces'),
		harvest,
		/**
		 * The same harvester as a PROGRAM FILE that records `tag` — for config
		 * keys Git executes directly rather than through a shell (a signing
		 * program), and so a case that plants many can say which one ran.
		 */
		program: (tag: string): string => {
			programs += 1;
			const file = join(dir, `harvest-${programs}.sh`);
			writeFileSync(
				file,
				`#!/bin/sh\nenv | grep -F Authorization >> '${receipt}'\necho '${tag}' >> '${ran}'\nexit 1\n`,
				{ mode: 0o755 }
			);
			return slash(file);
		},
		/** Everything a planted program managed to read of the credential. */
		leaked: (): string => (existsSync(receipt) ? readFileSync(receipt, 'utf8') : ''),
		didRun: (): boolean => existsSync(ran),
		/** The tags of the programs that ran, one per line. */
		ranBy: (): string => (existsSync(ran) ? readFileSync(ran, 'utf8') : '')
	};
}
type Scene = ReturnType<typeof scene>;

/** Real `execFile`, every invocation recorded; `afterConfigCheck` fires once the allowlist read has returned. */
function recordingGit(invocations: Invocation[], afterConfigCheck?: () => void): typeof execFile {
	let fired = false;
	return ((
		command: string,
		args: string[],
		options: { env?: NodeJS.ProcessEnv },
		callback: (error: Error | null, stdout: string, stderr: string) => void
	) => {
		invocations.push({ args: [...args], env: { ...(options.env ?? {}) } });
		const isConfigCheck = args.includes('--show-scope') && args.includes('--list');
		const done =
			isConfigCheck && afterConfigCheck && !fired
				? (error: Error | null, stdout: string, stderr: string): void => {
						// The config has been READ and judged clean. What is
						// written now is what a concurrent job can write.
						fired = true;
						afterConfigCheck();
						callback(error, stdout, stderr);
					}
				: callback;
		return (execFile as unknown as (...rest: unknown[]) => unknown)(command, args, options, done) as never;
	}) as never;
}

const carriesHeader = (entry: Invocation): boolean => JSON.stringify(entry.env).includes(BASIC);

const provisionSpec = (
	baseDir: string,
	repoUrl: string,
	bindingKey: string,
	extra: Partial<WorkspaceProvisionSpec> = {}
): WorkspaceProvisionSpec => ({
	repoUrl,
	baseRef: 'main',
	branch: `task/${bindingKey}`,
	bindingKey,
	hardenRepoHooks: true,
	settings: { baseDir, fetchDepth: 1 },
	...extra
});

/** The one bare pool a scene's provisions share. */
function poolOf(baseDir: string): string {
	const repos = join(baseDir, 'repos');
	const [only] = readdirSync(repos);
	return join(repos, only);
}

/** Create the pool (uncredentialed, nothing planted yet) and return it. */
async function seedPool(baseDir: string, repoUrl: string): Promise<string> {
	await new LocalWorkspacePlugin().provision(provisionSpec(baseDir, repoUrl, 'seed'));
	return poolOf(baseDir);
}

/**
 * The CONTROL: what git does with a planted pool when it is handed a
 * credential the way the first version of this code handed it over — by
 * URL, with the header in the environment, and nothing else.
 */
function controlFetch(pool: string, remoteUrl: string): void {
	try {
		execFileSync('git', ['fetch', '--depth', '1', remoteUrl, '+refs/heads/main:refs/remotes/origin/control'], {
			cwd: pool,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: '0',
				GIT_CONFIG_COUNT: '1',
				GIT_CONFIG_KEY_0: `http.${remoteUrl}.extraheader`,
				GIT_CONFIG_VALUE_0: HEADER
			}
		});
	} catch {
		// Most plants break the transfer itself; the receipt is the verdict.
	}
}

/** A scratch bare repository to run a control in, so the provider's own pool stays untouched. */
function scratchPool(dir: string, remoteUrl: string): string {
	const pool = join(dir, 'control.git');
	mkdirSync(pool, { recursive: true });
	git(pool, 'init', '--bare');
	git(pool, 'remote', 'add', 'origin', remoteUrl);
	return pool;
}

interface FetchVector {
	readonly name: string;
	/** Write the attack into `pool`'s config, for a command addressed to `remoteUrl`. */
	plant(pool: string, remoteUrl: string, at: Scene): void;
	/** `section.variable` names the allowlist must report for it. */
	readonly reported: readonly string[];
	/**
	 * What the credentialed fetch does when the plant lands AFTER the check.
	 * `ignored` (the default): the plant has no say and the fetch succeeds
	 * against the real remote. `refused`: the plant moves the request onto a
	 * transport the child is not allowed to speak, and the fetch fails closed.
	 */
	readonly raced?: 'ignored' | 'refused';
}

/** `ext::` splits its command on spaces; `% ` is a literal one. */
const extEscape = (text: string): string => text.replace(/%/g, '%%').replace(/ /g, '% ');

const fetchVectors: FetchVector[] = [
	{
		// The review's finding, key for key.
		name: 'remote.<url>.url → a local path, with remote.<url>.uploadpack → a harvester',
		plant: (pool, remoteUrl, at) => {
			git(pool, 'config', `remote.${remoteUrl}.url`, slash(originDir));
			git(pool, 'config', `remote.${remoteUrl}.uploadpack`, `${at.harvest} git-upload-pack`);
		},
		reported: ['remote.<…>.url', 'remote.<…>.uploadpack']
	},
	{
		name: 'remote.<url>.uploadpack alone',
		plant: (pool, remoteUrl, at) => {
			git(pool, 'config', `remote.${remoteUrl}.uploadpack`, `${at.harvest} git-upload-pack`);
		},
		reported: ['remote.<…>.uploadpack']
	},
	{
		name: 'remote.<url>.vcs → a remote helper that runs a command',
		plant: (pool, remoteUrl, at) => {
			git(pool, 'config', `remote.${remoteUrl}.vcs`, 'ext');
			git(pool, 'config', `remote.${remoteUrl}.url`, `sh -c ${extEscape(`${at.harvest} :`)}`);
			git(pool, 'config', 'protocol.ext.allow', 'always');
		},
		reported: ['remote.<…>.vcs', 'remote.<…>.url', 'protocol.<…>.allow']
	},
	{
		name: 'core.sshCommand, with remote.<url>.url → an ssh URL',
		plant: (pool, remoteUrl, at) => {
			git(pool, 'config', `remote.${remoteUrl}.url`, 'ssh://nowhere.invalid/x/y');
			git(pool, 'config', 'core.sshCommand', `${at.harvest} false`);
		},
		reported: ['remote.<…>.url', 'core.sshcommand']
	},
	{
		name: 'include.path → a file that holds the uploadpack attack',
		plant: (pool, remoteUrl, at) => {
			const included = join(at.dir, 'planted.gitconfig');
			writeFileSync(
				included,
				`[remote "${remoteUrl}"]\n\turl = ${slash(originDir)}\n\tuploadpack = "${at.harvest} git-upload-pack"\n`
			);
			git(pool, 'config', 'include.path', slash(included));
		},
		reported: ['include.path', 'remote.<…>.url', 'remote.<…>.uploadpack']
	},
	{
		name: 'core.alternateRefsCommand, with an alternates file',
		plant: (pool, _remoteUrl, at) => {
			mkdirSync(join(pool, 'objects', 'info'), { recursive: true });
			writeFileSync(join(pool, 'objects', 'info', 'alternates'), `${slash(join(originDir, 'objects'))}\n`);
			git(pool, 'config', 'core.alternateRefsCommand', `${at.harvest} :`);
		},
		reported: ['core.alternaterefscommand']
	},
	{
		// Not a `remote.<url>.*` key, so the private remote name does not
		// cover it: a URL rewrite applies to that remote's URL too. Only the
		// transport pin stands between this and `core.sshCommand`.
		name: 'url.<base>.insteadOf → an ssh URL, with core.sshCommand',
		plant: (pool, remoteUrl, at) => {
			git(pool, 'config', 'url.ssh://nowhere.invalid/x/.insteadOf', remoteUrl);
			git(pool, 'config', 'core.sshCommand', `${at.harvest} false`);
		},
		reported: ['url.<…>.insteadof', 'core.sshcommand'],
		raced: 'refused'
	},
	{
		// A GRANDCHILD, and one that names a remote the config does describe.
		// With a promisor remote configured, an object that is missing makes
		// the fetch start `git fetch <that remote>` to go and get it — so the
		// private remote name is no help here, and only what the credentialed
		// child's ENVIRONMENT carries reaches the process that runs the
		// program. The keys of a partial clone are allowed (Git writes them
		// itself); this is what stands behind that decision.
		name: 'a promisor remote → ssh with core.sshCommand, and a ref whose object is missing',
		plant: (pool, _remoteUrl, at) => {
			git(pool, 'config', 'extensions.partialclone', 'ew-planted');
			git(pool, 'config', 'remote.ew-planted.promisor', 'true');
			git(pool, 'config', 'remote.ew-planted.url', 'ssh://nowhere.invalid/x/y');
			git(pool, 'config', 'core.sshCommand', `${at.harvest} false`);
			// What sends Git looking: the refs the fetch is about to move point
			// at an object that is not there.
			const tracking = join(pool, 'refs', 'remotes', 'origin');
			mkdirSync(tracking, { recursive: true });
			for (const ref of ['main', 'control']) writeFileSync(join(tracking, ref), `${'1'.repeat(40)}\n`);
		},
		reported: ['core.sshcommand']
	}
];

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'ew-lw-attack-'));
	originDir = join(root, 'origin.git');
	decoyDir = join(root, 'decoy.git');
	const seedDir = join(root, 'seed');
	for (const dir of [originDir, decoyDir, seedDir]) mkdirSync(dir, { recursive: true });
	git(originDir, 'init', '--bare', '--initial-branch', 'main');
	git(decoyDir, 'init', '--bare', '--initial-branch', 'main');
	git(seedDir, 'init', '--initial-branch', 'main');
	const commit = (message: string): void => {
		writeFileSync(join(seedDir, 'README.md'), `${message}\n`);
		git(seedDir, 'add', '-A');
		git(seedDir, '-c', 'user.name=Seed', '-c', 'user.email=seed@test.local', 'commit', '-m', message);
	};
	commit('the real repository');
	git(seedDir, 'push', pathToFileURL(originDir).toString(), 'HEAD:refs/heads/main');
	originHead = git(seedDir, 'rev-parse', 'HEAD');
	// Somewhere a redirect could land instead: different content, same branch.
	commit('a decoy');
	git(seedDir, 'push', pathToFileURL(decoyDir).toString(), 'HEAD:refs/heads/main');
	decoyHead = git(seedDir, 'rev-parse', 'HEAD');
	originUrl = pathToFileURL(originDir).toString();
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('scoped FETCH credential — a planted pool config cannot read it', () => {
	describe.each(fetchVectors)('$name', (vector) => {
		it('CONTROL: without this provider’s protections the planted program reads the header', () => {
			const at = scene();
			const pool = scratchPool(at.dir, originUrl);
			vector.plant(pool, originUrl, at);

			controlFetch(pool, originUrl);

			expect(at.didRun()).toBe(true);
			expect(at.leaked()).toContain(BASIC);
		});

		it('planted BEFORE the run: the credential is withheld, and nothing reads it', async () => {
			const at = scene();
			const pool = await seedPool(at.baseDir, originUrl);
			vector.plant(pool, originUrl, at);
			const invocations: Invocation[] = [];
			const reasons: string[] = [];
			const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

			// What the uncredentialed fetch then does with this pool is what it
			// always did — some of these plants break it — so only the
			// credential is judged here.
			await plugin
				.provision(
					provisionSpec(at.baseDir, originUrl, 'withheld', {
						fetchCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: originUrl },
						onFetchCredentialWithheld: (reason) => reasons.push(reason)
					})
				)
				.catch(() => undefined);

			expect(reasons).toHaveLength(1);
			for (const name of vector.reported) expect(reasons[0]).toContain(name);
			// Named for an operator, never quoted: no subsection, no value.
			expect(reasons[0]).not.toContain(slash(originDir));
			expect(reasons[0]).not.toContain('Authorization');
			// And with the way out, for the repository it was found in.
			expect(reasons[0]).toMatch(/To clear it on this machine: git -C "[^"]+" config /);
			// Git never held the token, in any child…
			expect(invocations.some(carriesHeader)).toBe(false);
			// …so whatever ran, it read nothing.
			expect(at.leaked()).toBe('');
		});

		it('planted BETWEEN the check and the fetch: the credential is used, and the program never runs', async () => {
			const at = scene();
			const pool = await seedPool(at.baseDir, originUrl);
			const invocations: Invocation[] = [];
			const reasons: string[] = [];
			const plugin = new LocalWorkspacePlugin({
				execFile: recordingGit(invocations, () => vector.plant(pool, originUrl, at))
			});

			const outcome = await plugin
				.provision(
					provisionSpec(at.baseDir, originUrl, 'raced', {
						fetchCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: originUrl },
						onFetchCredentialWithheld: (reason) => reasons.push(reason)
					})
				)
				.then(
					(handle) => ({ handle, error: null as Error | null }),
					(error: Error) => ({ handle: null, error })
				);

			// The allowlist saw a clean pool, so the credential WAS handed to
			// git — this is the case the allowlist cannot help with.
			expect(reasons).toEqual([]);
			const fetches = invocations.filter((entry) => entry.args[0] === 'fetch');
			expect(fetches.length).toBeGreaterThan(0);
			expect(fetches.every(carriesHeader)).toBe(true);
			// And the planted program did not run, let alone read it.
			expect(at.didRun()).toBe(false);
			expect(at.leaked()).toBe('');
			if (vector.raced === 'refused') {
				// The plant put the request on a transport this child may not
				// speak. It fails closed, and says nothing of the credential.
				expect(outcome.error?.message).toMatch(/fetch of base ref 'main' failed.*not allowed/s);
				expect(outcome.error?.message).not.toContain(TOKEN);
				expect(outcome.error?.message).not.toContain(BASIC);
			} else {
				// The fetch went to the REAL remote, redirect or not.
				expect(outcome.error).toBeNull();
				expect(fetches).toHaveLength(2);
				expect(outcome.handle?.baseSha).toBe(originHead);
			}
		});
	});

	describe('remote.<url>.url → a local path alone', () => {
		// No program is planted, so there is no receipt to read: on its own a
		// `url` runs nothing. What it does is MOVE the fetch — the run would
		// be built on whatever repository the plant names, with the
		// credential in the environment of a transport it was not issued
		// for. Judged by which repository the base commit came from.
		const plant = (pool: string): void => {
			git(pool, 'config', `remote.${originUrl}.url`, slash(decoyDir));
		};

		it('CONTROL: a fetch by URL lands on the planted repository', () => {
			const at = scene();
			const pool = scratchPool(at.dir, originUrl);
			plant(pool);

			controlFetch(pool, originUrl);

			expect(git(pool, 'rev-parse', 'refs/remotes/origin/control')).toBe(decoyHead);
		});

		it('planted BEFORE the run: the credential is withheld', async () => {
			const at = scene();
			const pool = await seedPool(at.baseDir, originUrl);
			plant(pool);
			const invocations: Invocation[] = [];
			const reasons: string[] = [];
			const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

			await plugin
				.provision(
					provisionSpec(at.baseDir, originUrl, 'withheld', {
						fetchCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: originUrl },
						onFetchCredentialWithheld: (reason) => reasons.push(reason)
					})
				)
				.catch(() => undefined);

			expect(reasons).toHaveLength(1);
			expect(reasons[0]).toContain('remote.<…>.url');
			expect(reasons[0]).not.toContain(slash(decoyDir));
			expect(invocations.some(carriesHeader)).toBe(false);
		});

		it('planted BETWEEN the check and the fetch: the credentialed fetch is not moved', async () => {
			const at = scene();
			const pool = await seedPool(at.baseDir, originUrl);
			const invocations: Invocation[] = [];
			const reasons: string[] = [];
			const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations, () => plant(pool)) });

			const handle = await plugin.provision(
				provisionSpec(at.baseDir, originUrl, 'raced', {
					fetchCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: originUrl },
					onFetchCredentialWithheld: (reason) => reasons.push(reason)
				})
			);

			expect(reasons).toEqual([]);
			const fetches = invocations.filter((entry) => entry.args[0] === 'fetch');
			expect(fetches).toHaveLength(2);
			expect(fetches.every(carriesHeader)).toBe(true);
			// The real repository, not the one the plant names.
			expect(handle.baseSha).toBe(originHead);
			expect(handle.baseSha).not.toBe(decoyHead);
		});
	});

	describe('the review’s reproduction, against an https remote as the fleet sends it', () => {
		const plant = (pool: string, at: Scene): void => {
			git(pool, 'config', `remote.${HTTPS_REMOTE}.url`, slash(originDir));
			git(pool, 'config', `remote.${HTTPS_REMOTE}.uploadpack`, `${at.harvest} git-upload-pack`);
			// What an attacker who had read this fix would add: re-allow the
			// file transport, and (Git for Windows) strip the variable that
			// forbids it from git's children.
			git(pool, 'config', 'protocol.file.allow', 'always');
			git(pool, 'config', 'protocol.allow', 'always');
			git(pool, 'config', 'core.unsetenvvars', 'PERL5LIB,GIT_ALLOW_PROTOCOL');
		};

		it('CONTROL: the planted uploadpack reads the header', () => {
			const at = scene();
			const pool = scratchPool(at.dir, HTTPS_REMOTE);
			plant(pool, at);

			controlFetch(pool, HTTPS_REMOTE);

			expect(at.didRun()).toBe(true);
			expect(at.leaked()).toContain(BASIC);
		});

		it('planted BEFORE the run: withheld — the old fetch still follows the redirect, and reads nothing', async () => {
			const at = scene();
			const httpsBase = join(at.dir, 'https-workspaces');
			// First contact creates the pool and then fails to reach the
			// remote (nothing listens there) — which is all this needs.
			await new LocalWorkspacePlugin()
				.provision(provisionSpec(httpsBase, HTTPS_REMOTE, 'seed'))
				.catch(() => undefined);
			const httpsPool = poolOf(httpsBase);
			plant(httpsPool, at);
			const invocations: Invocation[] = [];
			const reasons: string[] = [];
			const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

			const handle = await plugin.provision(
				provisionSpec(httpsBase, HTTPS_REMOTE, 'withheld', {
					fetchCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: HTTPS_REMOTE },
					onFetchCredentialWithheld: (reason) => reasons.push(reason)
				})
			);

			expect(reasons).toHaveLength(1);
			expect(reasons[0]).toContain('remote.<…>.uploadpack');
			expect(reasons[0]).toContain('core.unsetenvvars');
			expect(invocations.some(carriesHeader)).toBe(false);
			// The uncredentialed fetch is the one this provider always ran: it
			// follows the planted redirect and runs the planted program…
			expect(handle.baseSha).toBe(originHead);
			expect(at.didRun()).toBe(true);
			// …which finds no credential to read.
			expect(at.leaked()).toBe('');
		});

		it('planted BETWEEN the check and the fetch: https only — the redirect is refused and the program never runs', async () => {
			const at = scene();
			const httpsBase = join(at.dir, 'https-workspaces');
			await new LocalWorkspacePlugin()
				.provision(provisionSpec(httpsBase, HTTPS_REMOTE, 'seed'))
				.catch(() => undefined);
			const httpsPool = poolOf(httpsBase);
			const invocations: Invocation[] = [];
			const plugin = new LocalWorkspacePlugin({
				execFile: recordingGit(invocations, () => plant(httpsPool, at))
			});

			const error = await plugin
				.provision(
					provisionSpec(httpsBase, HTTPS_REMOTE, 'raced', {
						fetchCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: HTTPS_REMOTE }
					})
				)
				.then(
					() => null,
					(caught: Error) => caught
				);

			// The credentialed fetch ran, bound to https and to its own remote…
			const fetch = invocations.find((entry) => entry.args[0] === 'fetch');
			expect(fetch && carriesHeader(fetch)).toBe(true);
			expect(fetch?.env.GIT_ALLOW_PROTOCOL).toBe('https');
			expect(fetch?.args).not.toContain(HTTPS_REMOTE);
			// …so it went to the https remote (where nothing listens) instead of
			// the planted local path, and failed there, closed.
			expect(error?.message).toMatch(/fetch of base ref 'main' failed/);
			expect(at.didRun()).toBe(false);
			expect(at.leaked()).toBe('');
			expect(error?.message).not.toContain(TOKEN);
			expect(error?.message).not.toContain(BASIC);
		});
	});

	it('a pool that ordinary tooling has written to still gets its credential', async () => {
		// The other half of an allowlist: every key here is one real tools
		// write into a checkout's shared config — husky, git-lfs, `git
		// submodule init`, the GitHub CLI, an agent setting its identity. If
		// any of them withheld the credential, the first `pnpm install` in a
		// worktree would switch scoped fetches off for that repository.
		const at = scene();
		const pool = await seedPool(at.baseDir, originUrl);
		for (const [key, value] of [
			['user.name', 'Refactor Bot'],
			['user.email', 'bot@agents.ever.works'],
			['core.hooksPath', '.husky/_'],
			['core.autocrlf', 'input'],
			['core.longpaths', 'true'],
			['commit.gpgsign', 'false'],
			['pull.rebase', 'true'],
			['push.autoSetupRemote', 'true'],
			['fetch.prune', 'true'],
			['gc.auto', '0'],
			['http.postBuffer', '524288000'],
			['lfs.repositoryformatversion', '0'],
			['filter.lfs.clean', 'git-lfs clean -- %f'],
			['filter.lfs.smudge', 'git-lfs smudge -- %f'],
			['filter.lfs.process', 'git-lfs filter-process'],
			['filter.lfs.required', 'true'],
			['submodule.vendor/lib.url', 'https://github.com/ever-works/lib.git'],
			['submodule.vendor/lib.active', 'true'],
			['remote.upstream.url', 'https://github.com/ever-works/upstream.git'],
			['remote.upstream.fetch', '+refs/heads/*:refs/remotes/upstream/*'],
			['remote.origin.gh-resolved', 'base'],
			['branch.main.gh-merge-base', 'main'],
			['merge.conflictstyle', 'zdiff3']
		] as const) {
			git(pool, 'config', key, value);
		}
		const invocations: Invocation[] = [];
		const reasons: string[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

		const handle = await plugin.provision(
			provisionSpec(at.baseDir, originUrl, 'tooling', {
				fetchCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: originUrl },
				onFetchCredentialWithheld: (reason) => reasons.push(reason)
			})
		);

		expect(reasons).toEqual([]);
		expect(invocations.filter((entry) => entry.args[0] === 'fetch').every(carriesHeader)).toBe(true);
		expect(handle.baseSha).toBe(originHead);
	});
});

describe('scoped PUSH credential — the merged path had the same hole', () => {
	interface PushVector {
		readonly name: string;
		plant(worktree: string, remoteUrl: string, at: Scene): void;
		readonly reported: readonly string[];
	}

	// Planted from the WORKTREE with plain `git config`, which is all a run
	// needs: in a linked worktree that lands in the shared pool config.
	const pushVectors: PushVector[] = [
		{
			name: 'remote.<url>.receivepack → a harvester, with remote.<url>.pushurl → a decoy',
			plant: (worktree, remoteUrl, at) => {
				git(worktree, 'config', `remote.${remoteUrl}.receivepack`, `${at.harvest} git-receive-pack`);
				git(worktree, 'config', `remote.${remoteUrl}.pushurl`, slash(decoyDir));
			},
			reported: ['remote.<…>.receivepack', 'remote.<…>.pushurl']
		},
		{
			name: 'core.sshCommand, with remote.<url>.pushurl → an ssh URL',
			plant: (worktree, remoteUrl, at) => {
				git(worktree, 'config', `remote.${remoteUrl}.pushurl`, 'ssh://nowhere.invalid/x/y');
				git(worktree, 'config', 'core.sshCommand', `${at.harvest} false`);
			},
			reported: ['remote.<…>.pushurl', 'core.sshcommand']
		},
		{
			name: 'include.path → a file that holds the receivepack attack',
			plant: (worktree, remoteUrl, at) => {
				const included = join(at.dir, 'planted.gitconfig');
				writeFileSync(
					included,
					`[remote "${remoteUrl}"]\n\treceivepack = "${at.harvest} git-receive-pack"\n\tpushurl = ${slash(decoyDir)}\n`
				);
				git(worktree, 'config', 'include.path', slash(included));
			},
			reported: ['include.path', 'remote.<…>.receivepack']
		},
		{
			// The push names its private remote — and with negotiation on, it
			// first runs `git fetch --negotiate-only … <URL>`: BY URL, so the
			// `[remote "<url>"]` section applies to that grandchild after all.
			name: 'push.negotiate, with remote.<url>.uploadpack → a harvester',
			plant: (worktree, remoteUrl, at) => {
				git(worktree, 'config', 'push.negotiate', 'true');
				git(worktree, 'config', `remote.${remoteUrl}.uploadpack`, `${at.harvest} git-upload-pack`);
			},
			reported: ['remote.<…>.uploadpack']
		}
	];

	const credential = (): { username: string; token: string; remoteUrl: string } => ({
		username: 'x-access-token',
		token: TOKEN,
		remoteUrl: originUrl
	});

	async function worktreeWithWork(at: Scene, bindingKey: string): Promise<WorkspaceHandle> {
		const handle = await new LocalWorkspacePlugin().provision(provisionSpec(at.baseDir, originUrl, bindingKey));
		writeFileSync(join(handle.path, 'work.txt'), `${bindingKey}\n`);
		return handle;
	}

	const onRemote = (repository: string, branch: string): string =>
		git(repository, 'for-each-ref', `refs/heads/${branch}`);

	describe.each(pushVectors)('$name', (vector) => {
		it('CONTROL: a push by URL with the header in its environment hands it to the planted program', async () => {
			// Exactly what `pushRef` ran before this change: `git push
			// --no-verify <url> HEAD:refs/heads/<branch>` with the four
			// credential entries in the environment.
			const at = scene();
			const handle = await worktreeWithWork(at, 'control');
			git(handle.path, 'add', '-A');
			git(handle.path, '-c', 'user.name=T', '-c', 'user.email=t@test.local', 'commit', '-m', 'work');
			vector.plant(handle.path, originUrl, at);

			try {
				execFileSync('git', ['push', '--no-verify', originUrl, `HEAD:refs/heads/${handle.branch}`], {
					cwd: handle.path,
					windowsHide: true,
					stdio: ['ignore', 'pipe', 'pipe'],
					env: {
						...process.env,
						GIT_TERMINAL_PROMPT: '0',
						GIT_CONFIG_COUNT: '4',
						GIT_CONFIG_KEY_0: 'credential.helper',
						GIT_CONFIG_VALUE_0: '',
						GIT_CONFIG_KEY_1: 'core.askpass',
						GIT_CONFIG_VALUE_1: '',
						GIT_CONFIG_KEY_2: 'core.hooksPath',
						GIT_CONFIG_VALUE_2: '',
						GIT_CONFIG_KEY_3: `http.${originUrl}.extraheader`,
						GIT_CONFIG_VALUE_3: HEADER
					}
				});
			} catch {
				// The receipt is the verdict.
			}

			expect(at.didRun()).toBe(true);
			expect(at.leaked()).toContain(BASIC);
		});

		it('planted BEFORE the publish: the push is REFUSED, and nothing runs', async () => {
			const at = scene();
			const handle = await worktreeWithWork(at, 'refused');
			vector.plant(handle.path, originUrl, at);
			const invocations: Invocation[] = [];
			const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

			const error = await plugin
				.finalize(handle, { commitMessage: 'feat: work', push: true, pushCredential: credential() })
				.then(
					() => null,
					(caught: Error) => caught
				);

			// Fail closed, as a publish always has: refused, not pushed some
			// other way.
			expect(error?.message).toMatch(/^refusing to publish: this repository's Git config carries settings/);
			for (const name of vector.reported) expect(error?.message).toContain(name);
			expect(error?.message).toMatch(/To clear it on this machine: git -C "[^"]+" config /);
			expect(error?.message).not.toContain(slash(decoyDir));
			expect(invocations.some((entry) => entry.args[0] === 'push')).toBe(false);
			expect(invocations.some(carriesHeader)).toBe(false);
			expect(at.didRun()).toBe(false);
			expect(at.leaked()).toBe('');
			expect(onRemote(originDir, handle.branch)).toBe('');
			expect(onRemote(decoyDir, handle.branch)).toBe('');
		});

		it('planted BETWEEN the check and the push: the push reaches the REAL remote, and the program never runs', async () => {
			const at = scene();
			const handle = await worktreeWithWork(at, 'raced');
			const invocations: Invocation[] = [];
			const plugin = new LocalWorkspacePlugin({
				execFile: recordingGit(invocations, () => vector.plant(handle.path, originUrl, at))
			});

			const result = await plugin
				.finalize(handle, { commitMessage: 'feat: work', push: true, pushCredential: credential() })
				.then(
					(value) => ({ value, error: null as Error | null }),
					(error: Error) => ({ value: null, error })
				);

			// The credentialed push ran — the allowlist had passed…
			const push = invocations.find((entry) => entry.args[0] === 'push');
			expect(push && carriesHeader(push)).toBe(true);
			expect(push?.args).not.toContain(originUrl);
			// …and neither the planted program nor the planted destination was
			// ever used: the branch is on the real remote, and only there.
			expect(at.didRun()).toBe(false);
			expect(at.leaked()).toBe('');
			expect(onRemote(originDir, handle.branch)).not.toBe('');
			expect(onRemote(decoyDir, handle.branch)).toBe('');
			// The existing post-push probe still reports a pool it finds
			// changed; what it must never do is hide that the push landed.
			if (result.error) expect(result.error.message).not.toContain(TOKEN);
			else expect(result.value?.pushed).toBe(true);
		});
	});

	it('a worktree whose shared config ordinary tooling has written to still publishes', async () => {
		// The same guard as for the fetch, and it matters more here: a push
		// has no fallback, so a key wrongly left off the allowlist is a
		// refused publish for every later run on that repository.
		const at = scene();
		const handle = await worktreeWithWork(at, 'tooling');
		for (const [key, value] of [
			['user.name', 'Refactor Bot'],
			['user.email', 'bot@agents.ever.works'],
			['core.hooksPath', '.husky/_'],
			['core.autocrlf', 'input'],
			['commit.gpgsign', 'false'],
			['push.autoSetupRemote', 'true'],
			['http.postBuffer', '524288000'],
			['lfs.repositoryformatversion', '0'],
			['filter.lfs.process', 'git-lfs filter-process'],
			['submodule.vendor/lib.url', 'https://github.com/ever-works/lib.git'],
			['remote.upstream.url', 'https://github.com/ever-works/upstream.git'],
			['branch.main.gh-merge-base', 'main']
		] as const) {
			git(handle.path, 'config', key, value);
		}
		const plugin = new LocalWorkspacePlugin();

		const result = await plugin.finalize(handle, {
			commitMessage: 'feat: work',
			push: true,
			pushCredential: credential()
		});

		expect(result.pushed).toBe(true);
		expect(onRemote(originDir, handle.branch)).not.toBe('');
	});

	it('REFUSES a credential whose remote no header can authenticate', async () => {
		// An HTTP header means nothing to ssh, and `http` would put it on the
		// wire in clear. Refused before the repository is even read.
		const at = scene();
		const handle = await worktreeWithWork(at, 'scheme');
		git(poolOf(at.baseDir), 'config', 'remote.origin.url', 'http://git.example.test/owner/repo.git');
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

		await expect(
			plugin.finalize(handle, {
				commitMessage: 'feat: work',
				push: true,
				pushCredential: { ...credential(), remoteUrl: 'http://git.example.test/owner/repo.git' }
			})
		).rejects.toThrow(
			/refusing to publish: a scoped credential is an HTTP header, and its remote is not an https URL/
		);
		expect(invocations.some((entry) => entry.args[0] === 'push')).toBe(false);
		expect(invocations.some(carriesHeader)).toBe(false);
	});
});

/** Run `body` with these variables in this process's environment — what every `git` child inherits. */
async function withEnvironment<T>(variables: Record<string, string>, body: () => Promise<T>): Promise<T> {
	const previous = new Map(Object.keys(variables).map((name) => [name, process.env[name]] as const));
	Object.assign(process.env, variables);
	try {
		return await body();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

/** Run `body` with `content` as the machine's GLOBAL Git config — the operator's own scope. */
function withGlobalConfig<T>(at: Scene, content: string, body: () => Promise<T>): Promise<T> {
	const file = join(at.dir, `global-${Math.random().toString(16).slice(2)}.gitconfig`);
	writeFileSync(file, content);
	return withEnvironment({ GIT_CONFIG_GLOBAL: slash(file) }, body);
}

const branchOn = (repository: string, branch: string): string =>
	git(repository, 'for-each-ref', `refs/heads/${branch}`);

describe('keys that name a program a fetch or a push never starts', () => {
	// The other half of an allowlist. These keys DO name programs, and a run
	// that sets one (`git config core.editor true` is an everyday thing for
	// an agent to do) must not cost the repository its fetch credential, or
	// every later publish. They are allowed because no fetch and no push can
	// reach the code that would start them — which is what this proves, with
	// every one of them planted at once and each program recording its key.

	/** Keys Git runs through a shell. */
	const shellKeys = [
		'core.editor',
		'core.pager',
		'sequence.editor',
		'pager.fetch',
		'pager.push',
		'diff.external',
		'diff.ewplanted.textconv',
		'diff.ewplanted.command',
		'merge.ewplanted.driver',
		'filter.ewplanted.clean',
		'filter.ewplanted.smudge',
		'filter.ewplanted.process',
		'mergetool.ewplanted.cmd',
		'difftool.ewplanted.cmd'
	];
	/** Keys Git executes directly. */
	const execKeys = ['gpg.program', 'gpg.ssh.program', 'gpg.x509.program', 'gpg.ssh.defaultKeyCommand'];
	/** An alias cannot take the place of a command that exists. */
	const aliasKeys = ['alias.fetch', 'alias.push', 'alias.maintenance'];

	function plantEveryProgram(repository: string, at: Scene): void {
		for (const key of shellKeys) git(repository, 'config', key, `'${at.program(key)}'`);
		for (const key of execKeys) git(repository, 'config', key, at.program(key));
		for (const key of aliasKeys) git(repository, 'config', key, `!'${at.program(key)}'`);
		// The settings that would make a push reach for two of them, were
		// they not overridden for the credentialed child.
		git(repository, 'config', 'push.gpgSign', 'true');
		git(repository, 'config', 'push.negotiate', 'true');
		git(repository, 'config', 'gpg.format', 'ssh');
		// And the ones that name nothing at all.
		git(repository, 'config', 'color.pager', 'true');
		git(repository, 'config', 'i18n.commitEncoding', 'UTF-8');
	}

	it('CONTROL: these are live programs — git starts each for the command it belongs to', () => {
		// Without this the case below could pass because a planted value was
		// one git cannot run at all. One of each kind: an alias, a program run
		// through a shell (the editor of a commit), one executed directly (the
		// signing program of a signed commit).
		const at = scene();
		const repository = join(at.dir, 'control');
		mkdirSync(repository, { recursive: true });
		git(repository, 'init', '--initial-branch', 'main');
		const env = { ...process.env };
		for (const name of ['GIT_EDITOR', 'VISUAL', 'EDITOR']) delete env[name];
		const attempt = (...args: string[]): void => {
			try {
				execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@test.local', ...args], {
					cwd: repository,
					env,
					windowsHide: true,
					stdio: ['ignore', 'pipe', 'pipe']
				});
			} catch {
				// Each program exits 1 on purpose; whether it RAN is the verdict.
			}
		};

		attempt('-c', `alias.ewcontrol=!'${at.program('alias')}'`, 'ewcontrol');
		attempt('-c', `core.editor='${at.program('core.editor')}'`, 'commit', '--allow-empty');
		attempt('-c', `gpg.program=${at.program('gpg.program')}`, 'commit', '--allow-empty', '-S', '-m', 'signed');

		expect(at.ranBy().split(/\r?\n/).filter(Boolean)).toEqual(['alias', 'core.editor', 'gpg.program']);
	});

	it('planted in the pool, all at once: the fetch keeps its credential, the push publishes, and none runs', async () => {
		const at = scene();
		const pool = await seedPool(at.baseDir, originUrl);
		plantEveryProgram(pool, at);
		const invocations: Invocation[] = [];
		const reasons: string[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

		const handle = await plugin.provision(
			provisionSpec(at.baseDir, originUrl, 'programs', {
				fetchCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: originUrl },
				onFetchCredentialWithheld: (reason) => reasons.push(reason)
			})
		);
		writeFileSync(join(handle.path, 'work.txt'), 'programs\n');
		const result = await plugin.finalize(handle, {
			commitMessage: 'feat: work',
			push: true,
			pushCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: originUrl }
		});

		// Neither credential was withheld or refused for any of it…
		expect(reasons).toEqual([]);
		const fetches = invocations.filter((entry) => entry.args[0] === 'fetch');
		expect(fetches).toHaveLength(2);
		expect(fetches.every(carriesHeader)).toBe(true);
		expect(handle.baseSha).toBe(originHead);
		const push = invocations.find((entry) => entry.args[0] === 'push');
		expect(push && carriesHeader(push)).toBe(true);
		expect(result.pushed).toBe(true);
		expect(branchOn(originDir, handle.branch)).not.toBe('');
		// …and not one of the planted programs ran, in any command of the
		// provision or the publish. `ranBy` would name it.
		expect(at.ranBy()).toBe('');
		expect(at.leaked()).toBe('');
	});
});

describe('a refusal says how to get out of it — and the commands work', () => {
	// The pool is shared by every Task of a repository on a machine and
	// nothing cleans its config, so a refusal lasts until someone removes the
	// key. The message is what that someone has: these cases run exactly what
	// it prints, and the credential works again.

	const UNSET = /git -C "([^"]+)" config --unset-all ([a-z0-9.-]+)/;
	const LISTING = /git -C "([^"]+)" config --show-origin --name-only --get-regexp "([^"]+)"/;

	/** Run the commands a refusal printed, as printed. */
	function followTheHint(message: string): void {
		const unset = UNSET.exec(message);
		if (unset) git(unset[1], 'config', '--unset-all', unset[2]);
		const listing = LISTING.exec(message);
		if (listing) {
			const names = git(listing[1], 'config', '--show-origin', '--name-only', '--get-regexp', listing[2])
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => line.slice(line.indexOf('\t') + 1));
			for (const name of names) git(listing[1], 'config', '--unset-all', name);
		}
	}

	it('fetch: the withheld reason clears a key with no subsection AND one whose subsection it never printed', async () => {
		const at = scene();
		const pool = await seedPool(at.baseDir, originUrl);
		git(pool, 'config', 'core.sshCommand', `${at.harvest} false`);
		// Off the list, has a subsection, and does nothing to a plain fetch
		// of a repository on disk — so that fetch still succeeds.
		git(pool, 'config', `remote.${originUrl}.proxy`, 'http://127.0.0.1:1');
		const reasons: string[] = [];
		const withhold = (reason: string): number => reasons.push(reason);

		await new LocalWorkspacePlugin().provision(
			provisionSpec(at.baseDir, originUrl, 'stuck', {
				fetchCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: originUrl },
				onFetchCredentialWithheld: withhold
			})
		);
		expect(reasons).toHaveLength(1);
		expect(reasons[0]).toContain('(core.sshcommand, remote.<…>.proxy)');
		expect(reasons[0]).toMatch(UNSET);
		expect(reasons[0]).toMatch(LISTING);
		// The subsection (a URL) is not in the message; the command finds it.
		expect(reasons[0]).not.toContain(originUrl);

		followTheHint(reasons[0]);

		const invocations: Invocation[] = [];
		await new LocalWorkspacePlugin({ execFile: recordingGit(invocations) }).provision(
			provisionSpec(at.baseDir, originUrl, 'recovered', {
				fetchCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: originUrl },
				onFetchCredentialWithheld: withhold
			})
		);
		expect(reasons).toHaveLength(1);
		expect(invocations.filter((entry) => entry.args[0] === 'fetch').every(carriesHeader)).toBe(true);
	});

	it('push: the refusal names the SHARED repository, not the worktree, and the publish then goes through', async () => {
		const at = scene();
		const plugin = new LocalWorkspacePlugin();
		const handle = await plugin.provision(provisionSpec(at.baseDir, originUrl, 'stuck-push'));
		writeFileSync(join(handle.path, 'work.txt'), 'one\n');
		// Set the way a run sets it: plain `git config`, inside its checkout.
		git(handle.path, 'config', 'core.sshCommand', `${at.harvest} false`);
		const credential = { username: 'x-access-token', token: TOKEN, remoteUrl: originUrl };

		const refused = await plugin
			.finalize(handle, { commitMessage: 'feat: one', push: true, pushCredential: credential })
			.then(
				() => null,
				(error: Error) => error
			);
		expect(refused?.message).toMatch(/^refusing to publish: this repository's Git config carries settings/);
		const unset = UNSET.exec(refused?.message ?? '');
		expect(unset?.[2]).toBe('core.sshcommand');
		// The pool: the worktree may be gone by the time anyone reads this,
		// and its config is the pool's.
		expect(unset?.[1]).toBe(git(handle.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
		expect(unset?.[1]).not.toBe(slash(handle.path));
		expect(branchOn(originDir, handle.branch)).toBe('');

		followTheHint(refused?.message ?? '');

		writeFileSync(join(handle.path, 'work.txt'), 'two\n');
		const result = await plugin.finalize(handle, {
			commitMessage: 'feat: two',
			push: true,
			pushCredential: credential
		});
		expect(result.pushed).toBe(true);
		expect(branchOn(originDir, handle.branch)).not.toBe('');
		expect(at.didRun()).toBe(false);
	});
});

describe('a URL rewrite in the OPERATOR’s own config', () => {
	// `url.<ssh>.insteadOf https://github.com/` in a machine's global config
	// is an ordinary setup. The gate trusts that scope — and used to arm the
	// credential over it, after which the command died: the rewritten URL is
	// off the one transport the child may speak. A job that cloned over the
	// machine's own key stopped cloning. Here the local origin stands in for
	// the endpoint the rewrite points at.

	const rewriteOf = (variable: 'insteadOf' | 'pushInsteadOf'): string =>
		`[url "${originUrl}"]\n\t${variable} = ${HTTPS_REMOTE}\n`;

	it('fetch: WITHHELD — and the fetch goes over the rewrite, exactly as it did before', async () => {
		const at = scene();
		const invocations: Invocation[] = [];
		const reasons: string[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

		const handle = await withGlobalConfig(at, rewriteOf('insteadOf'), () =>
			plugin.provision(
				provisionSpec(at.baseDir, HTTPS_REMOTE, 'rewritten', {
					fetchCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: HTTPS_REMOTE },
					onFetchCredentialWithheld: (reason) => reasons.push(reason)
				})
			)
		);

		expect(reasons).toEqual([
			"this machine's Git config rewrites this remote's URL (url.<…>.insteadof, global scope), and a scoped credential is used only for the URL it was issued for"
		]);
		// The scope and the key — not where it points.
		expect(reasons[0]).not.toContain(slash(originDir));
		expect(invocations.some(carriesHeader)).toBe(false);
		// The plain fetch: by URL, no transport pin, and it WORKS.
		const [base] = invocations.filter((entry) => entry.args[0] === 'fetch');
		expect(base.args).toContain(HTTPS_REMOTE);
		expect(base.env.GIT_ALLOW_PROTOCOL).toBeUndefined();
		expect(handle.baseSha).toBe(originHead);
	});

	it('push, with a pushInsteadOf only: REFUSED in one sentence that names the rewrite’s scope', async () => {
		const at = scene();
		// A checkout of the https remote has to come from somewhere: fetched
		// over an insteadOf, which is then taken away again.
		const handle = await withGlobalConfig(at, rewriteOf('insteadOf'), () =>
			new LocalWorkspacePlugin().provision(provisionSpec(at.baseDir, HTTPS_REMOTE, 'push-rewritten'))
		);
		writeFileSync(join(handle.path, 'work.txt'), 'rewritten\n');
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

		const error = await withGlobalConfig(at, rewriteOf('pushInsteadOf'), () =>
			plugin
				.finalize(handle, {
					commitMessage: 'feat: work',
					push: true,
					pushCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: HTTPS_REMOTE }
				})
				.then(
					() => null,
					(caught: Error) => caught
				)
		);

		// `git remote get-url origin` does not show a pushInsteadOf, so every
		// check before the gate passes. The gate is what says no — fail
		// closed, as a publish without its scoped credential always is.
		expect(error?.message).toBe(
			"refusing to publish: this machine's Git config rewrites this remote's push URL (url.<…>.pushinsteadof, global scope), and a scoped credential is used only for the URL it was issued for"
		);
		expect(invocations.some((entry) => entry.args[0] === 'push')).toBe(false);
		expect(invocations.some(carriesHeader)).toBe(false);
		expect(branchOn(originDir, handle.branch)).toBe('');
	});

	it.each([
		['nothing rewrites it', '', []],
		['insteadOf', `[url "ssh://git@host.invalid/"]\n\tinsteadOf = https://host.invalid/\n`, []],
		['pushInsteadOf only', `[url "ssh://git@host.invalid/"]\n\tpushInsteadOf = https://host.invalid/\n`, []],
		[
			'both, the push one on a longer prefix',
			`[url "ssh://git@host.invalid/"]\n\tinsteadOf = https://host.invalid/\n[url "ssh://other.invalid/"]\n\tpushInsteadOf = https://host.invalid/owner/\n`,
			[]
		],
		[
			'the longest prefix wins, across the global and the repository scope',
			`[url "ssh://short.invalid/"]\n\tinsteadOf = https://host.invalid/\n`,
			[['url.ssh://long.invalid/.insteadOf', 'https://host.invalid/owner/']]
		],
		[
			'a tie between two bases',
			`[url "ssh://first.invalid/"]\n\tinsteadOf = https://example.invalid/\n[url "ssh://second.invalid/"]\n\tinsteadOf = https://host.invalid/\n[url "ssh://first.invalid/"]\n\tinsteadOf = https://host.invalid/\n`,
			[]
		],
		['a prefix in another case', `[url "ssh://git@host.invalid/"]\n\tinsteadOf = https://HOST.invalid/\n`, []],
		['an empty prefix', `[url "ssh://git@host.invalid/"]\n\tinsteadOf =\n`, []]
	] as Array<[string, string, string[][]]>)(
		'the URL it works out is the one git itself uses: %s',
		(_label, globalConfig, repositoryConfig) => {
			// `effectiveRemoteUrls` is a second reading of Git's rewrite rule.
			// It is held to Git's own answer: `git remote -v`, for a remote
			// defined the way a credentialed command defines its own.
			const at = scene();
			const repository = join(at.dir, 'agree.git');
			mkdirSync(repository, { recursive: true });
			git(repository, 'init', '--bare');
			for (const [key, value] of repositoryConfig) git(repository, 'config', key, value);
			const globalFile = join(at.dir, 'agree.gitconfig');
			writeFileSync(globalFile, globalConfig);
			const url = 'https://host.invalid/owner/repo.git';
			const env = {
				...process.env,
				GIT_CONFIG_GLOBAL: slash(globalFile),
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_CONFIG_COUNT: '1',
				GIT_CONFIG_KEY_0: 'remote.ew-agree.url',
				GIT_CONFIG_VALUE_0: url
			};
			const run = (...args: string[]): string =>
				execFileSync('git', args, { cwd: repository, env, encoding: 'utf8', windowsHide: true });

			const remotes = run('remote', '-v').split(/\r?\n/);
			const gitsUrl = (kind: 'fetch' | 'push'): string | undefined =>
				remotes
					.find((line) => line.startsWith('ew-agree\t') && line.endsWith(` (${kind})`))
					?.slice('ew-agree\t'.length, -` (${kind})`.length);
			const entries = parseScopedConfigList(run('config', '--show-scope', '--list', '-z'));
			const ours = effectiveRemoteUrls(entries ?? [], url);

			expect(gitsUrl('fetch')).toBeDefined();
			expect(ours.fetch).toBe(gitsUrl('fetch'));
			expect(ours.push).toBe(gitsUrl('push'));
		}
	);
});

describe('a traced daemon — git’s tracing variables do not reach a credentialed child', () => {
	// `GIT_TRACE_CURL=<file>` writes the request headers there (with
	// `GIT_TRACE_REDACT=0`, unredacted); `GIT_TRACE2_EVENT=<file>` with a
	// config pattern writes the command-scope config there. Either way the
	// `Authorization` header ends up on disk, where no scrub of this
	// process's output ever sees it. A daemon started with one of them set
	// would do that to every credentialed command.

	const TRACING = /^(GIT_TRACE|GIT_CURL_VERBOSE$)/i;
	const read = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');

	it('CONTROL: with GIT_TRACE2_EVENT and a config pattern, git writes the header into the trace file', () => {
		const at = scene();
		const pool = scratchPool(at.dir, originUrl);
		const trace = slash(join(at.dir, 'trace2.json'));

		execFileSync('git', ['fetch', '--depth', '1', originUrl, '+refs/heads/main:refs/remotes/origin/control'], {
			cwd: pool,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				GIT_TRACE2_EVENT: trace,
				GIT_TRACE2_CONFIG_PARAMS: 'http.*',
				GIT_CONFIG_COUNT: '1',
				GIT_CONFIG_KEY_0: `http.${originUrl}.extraheader`,
				GIT_CONFIG_VALUE_0: HEADER
			}
		});

		expect(read(trace)).toContain(BASIC);
	});

	it('a credentialed fetch and push put the header in no trace file, and the other children stay traced', async () => {
		const at = scene();
		const trace2 = slash(join(at.dir, 'trace2.json'));
		const trace = slash(join(at.dir, 'trace.txt'));
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

		await withEnvironment(
			{
				GIT_TRACE2_EVENT: trace2,
				GIT_TRACE2_CONFIG_PARAMS: 'http.*',
				GIT_TRACE: trace,
				GIT_TRACE_REDACT: '0',
				GIT_CURL_VERBOSE: '1'
			},
			async () => {
				const handle = await plugin.provision(
					provisionSpec(at.baseDir, originUrl, 'traced', {
						fetchCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: originUrl }
					})
				);
				writeFileSync(join(handle.path, 'work.txt'), 'traced\n');
				const result = await plugin.finalize(handle, {
					commitMessage: 'feat: work',
					push: true,
					pushCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: originUrl }
				});
				expect(result.pushed).toBe(true);
			}
		);

		// The two fetches and the push carried the credential, and not one
		// tracing variable.
		const credentialed = invocations.filter(carriesHeader);
		expect(credentialed.map((entry) => entry.args[0])).toEqual(['fetch', 'fetch', 'push']);
		for (const entry of credentialed) {
			expect(Object.keys(entry.env).filter((name) => TRACING.test(name))).toEqual([]);
		}
		// Every other child kept the operator's tracing — it is theirs, and
		// none of those commands holds a token.
		const others = invocations.filter((entry) => !carriesHeader(entry));
		expect(others.length).toBeGreaterThan(5);
		expect(others.every((entry) => entry.env.GIT_TRACE2_EVENT === trace2)).toBe(true);
		// So the files exist, were written to, and hold nothing of the header.
		for (const file of [trace2, trace]) {
			expect(read(file).length).toBeGreaterThan(0);
			expect(read(file)).not.toContain(BASIC);
			expect(read(file)).not.toContain(TOKEN);
			expect(read(file)).not.toContain('Authorization');
		}
	});

	it('GIT_TRACE_CURL=<file> with GIT_TRACE_REDACT=0: a credentialed https fetch writes nothing there', async () => {
		const at = scene();
		const httpsBase = join(at.dir, 'https-workspaces');
		// First contact creates the pool and then fails to reach the remote
		// (nothing listens there), untraced.
		await new LocalWorkspacePlugin()
			.provision(provisionSpec(httpsBase, HTTPS_REMOTE, 'seed'))
			.catch(() => undefined);
		const curlTrace = slash(join(at.dir, 'curl-trace.txt'));
		const invocations: Invocation[] = [];
		const plugin = new LocalWorkspacePlugin({ execFile: recordingGit(invocations) });

		const error = await withEnvironment({ GIT_TRACE_CURL: curlTrace, GIT_TRACE_REDACT: '0' }, () =>
			plugin
				.provision(
					provisionSpec(httpsBase, HTTPS_REMOTE, 'traced', {
						fetchCredential: { username: 'x-access-token', token: TOKEN, remoteUrl: HTTPS_REMOTE }
					})
				)
				.then(
					() => null,
					(caught: Error) => caught
				)
		);

		// The credentialed fetch ran (and failed to connect, as it must)…
		const fetch = invocations.find((entry) => entry.args[0] === 'fetch');
		expect(fetch && carriesHeader(fetch)).toBe(true);
		expect(error?.message).toMatch(/fetch of base ref 'main' failed/);
		// …without the variable, so curl traced nothing: a traced https
		// attempt writes its connection lines there even when nothing answers
		// (measured: five lines for this very URL).
		expect(fetch?.env.GIT_TRACE_CURL).toBeUndefined();
		expect(fetch?.env.GIT_TRACE_REDACT).toBeUndefined();
		expect(existsSync(curlTrace)).toBe(false);
		expect(read(curlTrace)).not.toContain('Authorization');
		expect(read(curlTrace)).not.toContain(BASIC);
	});
});
