import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
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
	return {
		dir,
		baseDir: join(dir, 'workspaces'),
		harvest,
		/** Everything a planted program managed to read of the credential. */
		leaked: (): string => (existsSync(receipt) ? readFileSync(receipt, 'utf8') : ''),
		didRun: (): boolean => existsSync(ran)
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
