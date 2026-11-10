import { execFile, execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON, type FleetJobFetchCredentialResponse } from '@ever-works/contracts';
import { LocalWorkspacePlugin } from '@ever-works/local-workspace-plugin';
import type { WorkspaceProvisionSpec } from '@ever-works/plugin';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FleetClientError } from '../fleet-client';
import { createLogger, type LogEntry } from '../logger';
import { FetchCredentialError, FetchCredentialSession, type FetchCredentialProvider } from './fetch-credential';
import { FleetTaskWorkspaceProvisioner, type FleetWorkspacePlugin } from './fleet-task-workspace';

/**
 * Scoped FETCH credentials at the PROVISIONER boundary — the read twin of
 * `fleet-task-workspace.push-credential.spec.ts`.
 *
 * Real git throughout: the provisioner, the real local-workspace provider
 * and real `git` children, with every child the provider spawns recorded on
 * the way through. So the claims that matter are read off what actually ran:
 *
 *  - the token is in the ENVIRONMENT of the `git fetch` children of the
 *    repository it was scoped to, and in nothing else — no argv, no other
 *    child, no file, no remote URL, no Git config;
 *  - every hardening control of a fleet provision is still on;
 *  - and the one rule the push twin does not have: with no credential for a
 *    repository the fetch is EXACTLY what it was. Only a refused claim or a
 *    stale lease fails the provision.
 */

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();

const temporaryRoot = (prefix: string): string =>
	realpathSync.native(mkdtempSync(join(realpathSync.native(process.env.RUNNER_TEMP ?? tmpdir()), prefix)));

type Invocation = { args: string[]; env: NodeJS.ProcessEnv };

const JOB_ID = '33333333-3333-4333-8333-333333333333';
const PRIMARY_ID = 'ever-works/fleet-fetch-primary';
const MOUNT_ID = 'ever-works/fleet-fetch-mount';
const PRIMARY_URL = `https://github.com/${PRIMARY_ID}.git`;
const MOUNT_URL = `https://github.com/${MOUNT_ID}.git`;
const PRIMARY_TOKEN = 'ghs_primaryFetchTokenSentinel0123456789abc';
const MOUNT_TOKEN = 'ghs_mountFetchTokenSentinel0123456789abcde';
const basic = (token: string): string => Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');

/** The provider call's keys before scoped fetch credentials existed. Pinned: "no credential" must add none. */
const LEGACY_PROVISION_KEYS = [
	'baseRef',
	'bindingKey',
	'branch',
	'hardenRepoHooks',
	'repoUrl',
	'repositoryId',
	'settings'
];

function configPairs(env: NodeJS.ProcessEnv): Array<[string, string]> {
	const count = Number(env.GIT_CONFIG_COUNT ?? '0');
	const pairs: Array<[string, string]> = [];
	for (let index = 0; index < count; index += 1) {
		pairs.push([String(env[`GIT_CONFIG_KEY_${index}`]), String(env[`GIT_CONFIG_VALUE_${index}`])]);
	}
	return pairs;
}

const headerOf = (entry: Invocation): [string, string] | undefined =>
	configPairs(entry.env).find(([key]) => /extraheader$/i.test(key));
/**
 * The URL a fetch goes to. A plain fetch names it; a CREDENTIALED fetch
 * names a private remote instead, whose only definition is a
 * `remote.<name>.url` entry in that child's own environment.
 */
const fetchRemote = (entry: Invocation): string | undefined => {
	const target = entry.args.at(-2) as string;
	return configPairs(entry.env).find(([key]) => key === `remote.${target}.url`)?.[1] ?? target;
};
const fetchesOf = (invocations: Invocation[], remoteUrl?: string): Invocation[] =>
	invocations.filter(
		(entry) => entry.args[0] === 'fetch' && (remoteUrl === undefined || fetchRemote(entry) === remoteUrl)
	);

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

describe(
	'FleetTaskWorkspaceProvisioner.provision — scoped fetch credentials (real Git)',
	{ timeout: 60_000, concurrent: false },
	() => {
		let ownedRoot: string;
		let workspaceRoot: string;
		let configIndex: number;
		let taskCounter = 0;

		const seed = (dir: string, origin: string, file: string): void => {
			mkdirSync(dir, { recursive: true });
			mkdirSync(origin, { recursive: true });
			git(origin, 'init', '--bare', '--initial-branch', 'main');
			git(dir, 'init', '--initial-branch', 'main');
			writeFileSync(join(dir, file), `${file}\n`);
			git(dir, 'add', file);
			git(dir, '-c', 'user.name=Fleet Test', '-c', 'user.email=fleet@test.invalid', 'commit', '-m', 'seed');
			git(dir, 'push', pathToFileURL(origin).toString(), 'HEAD:refs/heads/main');
		};

		/** A fresh Task per case: its own worktree and branch, over the shared pools. */
		const nextTask = (): { taskId: string; branch: string } => {
			taskCounter += 1;
			return {
				taskId: `task-fetch-${String(taskCounter).padStart(4, '0')}`,
				branch: `task/fetch-${taskCounter}`
			};
		};

		const single = (branch: string) => ({
			repositoryId: PRIMARY_ID,
			repoUrl: PRIMARY_URL,
			baseRef: 'main',
			branch
		});
		const withMount = (branch: string, writable = false) => ({
			...single(branch),
			mounts: [
				{ repositoryId: MOUNT_ID, repoUrl: MOUNT_URL, baseRef: 'main', branch, mountDir: 'template', writable }
			]
		});

		/**
		 * The real provider, with every git child it spawns recorded, and every
		 * `provision` spec it is handed recorded too.
		 */
		function harness(options: { failFetchWith?: string } = {}) {
			const invocations: Invocation[] = [];
			const specs: WorkspaceProvisionSpec[] = [];
			const recording = ((
				command: string,
				args: string[],
				execOptions: { env?: NodeJS.ProcessEnv },
				callback: (error: Error | null, stdout: string, stderr: string) => void
			) => {
				invocations.push({ args: [...args], env: { ...(execOptions.env ?? {}) } });
				if (options.failFetchWith !== undefined && args[0] === 'fetch') {
					setImmediate(() =>
						callback(
							Object.assign(new Error('fetch failed'), { code: 128 }),
							'',
							options.failFetchWith as string
						)
					);
					return { pid: 1 } as never;
				}
				// THE HARNESS PLAYS GITHUB. A credentialed child is bound to the
				// https transport (`GIT_ALLOW_PROTOCOL=https`) — recorded above,
				// exactly as the provider produced it, and asserted on below.
				// This suite's "GitHub" is a bare repository on disk that the
				// https URL is rewritten to, so for the real git underneath the
				// stand-in's transport is let through as well. Nothing else of
				// the child's environment is touched; what that binding STOPS is
				// proven, unassisted, in the provider's own
				// `credentialed-command.attacks.spec.ts`.
				const env =
					execOptions.env?.GIT_ALLOW_PROTOCOL === 'https'
						? { ...execOptions.env, GIT_ALLOW_PROTOCOL: 'https:file' }
						: execOptions.env;
				return (execFile as unknown as (...rest: unknown[]) => unknown)(
					command,
					args,
					{ ...execOptions, env },
					callback
				) as never;
			}) as never;
			const real = new LocalWorkspacePlugin({ execFile: recording });
			const plugin: FleetWorkspacePlugin = {
				provision: (spec) => {
					specs.push(spec);
					return real.provision(spec);
				}
			};
			const provisioner = new FleetTaskWorkspaceProvisioner({ rootPath: workspaceRoot, plugin });
			return { invocations, specs, provisioner };
		}

		function session(mint: () => Promise<FleetJobFetchCredentialResponse>) {
			const entries: LogEntry[] = [];
			const logger = createLogger({ sink: (entry) => entries.push(entry) });
			const client = { mintFetchCredential: vi.fn(mint) };
			const provider = new FetchCredentialSession({
				jobId: JOB_ID,
				client,
				logger,
				fetchFn: async () => ({ ok: true, status: 204 })
			});
			return { provider, client, entries };
		}

		const covering = (...repositories: Array<[string, string]>): FleetJobFetchCredentialResponse => ({
			credentials: repositories.map(([repository, token]) => ({
				token,
				username: 'x-access-token',
				expiresAt: '2026-11-10T20:00:00.000Z',
				repositories: [repository]
			})),
			uncovered: []
		});

		/** The bare pool the provider keeps for one remote, found by what its config says. */
		const poolFor = (remoteUrl: string): string => {
			const repositories = join(workspaceRoot, 'repositories');
			for (const cache of readdirSync(repositories)) {
				const repos = join(repositories, cache, 'repos');
				if (!existsSync(repos)) continue;
				for (const pool of readdirSync(repos)) {
					const candidate = join(repos, pool);
					try {
						if (git(candidate, 'config', '--get', 'remote.origin.url') === remoteUrl) return candidate;
					} catch {
						// Not a pool, or not this one.
					}
				}
			}
			throw new Error(`no pool for ${remoteUrl}`);
		};

		beforeAll(() => {
			ownedRoot = temporaryRoot('ew-fleet-fetch-credential-');
			workspaceRoot = join(ownedRoot, 'fleet-root');
			const primaryOrigin = join(ownedRoot, 'primary.git');
			const mountOrigin = join(ownedRoot, 'mount.git');
			seed(join(ownedRoot, 'seed-primary'), primaryOrigin, 'PRIMARY.md');
			seed(join(ownedRoot, 'seed-mount'), mountOrigin, 'MOUNT.md');

			// The production https validator and real Git, with no network: the
			// GitHub URLs a fleet job really carries are rewritten to test-owned
			// bare repositories for child processes only (the same technique
			// `fleet-task-workspace.spec.ts` uses). The credential is keyed to the
			// https URL; git reads from disk.
			configIndex = Number(process.env.GIT_CONFIG_COUNT ?? '0');
			process.env.GIT_CONFIG_COUNT = String(configIndex + 2);
			process.env[`GIT_CONFIG_KEY_${configIndex}`] = `url.${pathToFileURL(primaryOrigin).toString()}.insteadOf`;
			process.env[`GIT_CONFIG_VALUE_${configIndex}`] = PRIMARY_URL;
			process.env[`GIT_CONFIG_KEY_${configIndex + 1}`] = `url.${pathToFileURL(mountOrigin).toString()}.insteadOf`;
			process.env[`GIT_CONFIG_VALUE_${configIndex + 1}`] = MOUNT_URL;
		});

		afterAll(async () => {
			for (const offset of [0, 1]) {
				delete process.env[`GIT_CONFIG_KEY_${configIndex + offset}`];
				delete process.env[`GIT_CONFIG_VALUE_${configIndex + offset}`];
			}
			if (configIndex === 0) delete process.env.GIT_CONFIG_COUNT;
			else process.env.GIT_CONFIG_COUNT = String(configIndex);
			await fs.rm(ownedRoot, { recursive: true, force: true, maxRetries: 3 });
		});

		describe('a repository the platform covers', () => {
			it('is fetched with the scoped credential — in the fetch children’s environment and NOWHERE else', async () => {
				const { invocations, specs, provisioner } = harness();
				const { provider } = session(async () => covering([PRIMARY_ID, PRIMARY_TOKEN]));
				const { taskId, branch } = nextTask();

				const descriptor = await provisioner.provision(taskId, single(branch), undefined, {
					fetchCredentials: provider
				});

				expect(existsSync(join(descriptor.path, 'PRIMARY.md'))).toBe(true);
				// What the provider was handed: the credential, keyed to the very
				// URL it is about to fetch, with the hardening still asked for.
				expect(specs).toHaveLength(1);
				expect(specs[0].fetchCredential).toEqual({
					username: 'x-access-token',
					token: PRIMARY_TOKEN,
					remoteUrl: PRIMARY_URL
				});
				expect(specs[0].hardenRepoHooks).toBe(true);

				// IN the environment of exactly the fetches, as a URL-scoped header…
				const fetches = fetchesOf(invocations);
				expect(fetches).toHaveLength(2);
				for (const fetch of fetches) {
					expect(headerOf(fetch)).toEqual([
						`http.${PRIMARY_URL}.extraheader`,
						`Authorization: Basic ${basic(PRIMARY_TOKEN)}`
					]);
					// …with every other credential source off, exactly as for the push.
					const pairs = configPairs(fetch.env);
					expect(pairs).toContainEqual(['credential.helper', '']);
					expect(pairs).toContainEqual(['core.askpass', '']);
					expect(fetch.env.GIT_TERMINAL_PROMPT).toBe('0');
				}

				// …in NO argv, and with the remote still the token-free URL…
				for (const entry of invocations) {
					expect(entry.args.join('\u0000')).not.toContain(PRIMARY_TOKEN);
					expect(entry.args.join('\u0000')).not.toContain(basic(PRIMARY_TOKEN));
				}
				for (const fetch of fetches) {
					// Bound to https and to a remote no config file can describe:
					// the URL is not even in argv, only in this child's environment.
					expect(fetch.env.GIT_ALLOW_PROTOCOL).toBe('https');
					expect(fetch.args.at(-2)).toMatch(/^ew-credentialed-[0-9a-f-]{36}$/);
					expect(fetch.args).not.toContain(PRIMARY_URL);
					expect(fetchRemote(fetch)).toBe(PRIMARY_URL);
				}

				// …and in the environment of NO other child the provider spawned:
				// not `init`, not `remote add`, not `worktree add`.
				const others = invocations.filter((entry) => entry.args[0] !== 'fetch');
				expect(others.some((entry) => entry.args[0] === 'worktree' && entry.args[1] === 'add')).toBe(true);
				for (const entry of others) {
					expect(headerOf(entry)).toBeUndefined();
					expect(JSON.stringify(entry.env)).not.toContain(PRIMARY_TOKEN);
					expect(JSON.stringify(entry.env)).not.toContain(basic(PRIMARY_TOKEN));
				}

				// Never written to disk: not in the checkout, not in the pool, not
				// in a lease/usage/stamp file — nowhere under the fleet root.
				expect(filesContaining(workspaceRoot, [PRIMARY_TOKEN, basic(PRIMARY_TOKEN)])).toEqual([]);
				// Never in a remote URL or a Git config file.
				const pool = poolFor(PRIMARY_URL);
				expect(git(pool, 'config', '--get', 'remote.origin.url')).toBe(PRIMARY_URL);
				const poolConfig = git(pool, 'config', '--local', '--list').toLowerCase();
				expect(poolConfig).not.toContain('extraheader');
				expect(poolConfig).not.toContain('credential.');
				expect(git(descriptor.path, 'config', '--get', 'remote.origin.url')).toBe(PRIMARY_URL);
				// And the descriptor the executor (and the model step) receives
				// carries nothing of it.
				expect(JSON.stringify(descriptor)).not.toContain(PRIMARY_TOKEN);
			});

			it('keeps every hardening control of a fleet provision on', async () => {
				const { invocations, provisioner } = harness();
				const { provider } = session(async () => covering([PRIMARY_ID, PRIMARY_TOKEN]));
				const { taskId, branch } = nextTask();

				await provisioner.provision(taskId, single(branch), undefined, { fetchCredentials: provider });

				// Every git command the provider ran once the hardening scope was
				// up — the credentialed fetches included — still has no hooks, no
				// fsmonitor, no `ext::` transport, no submodule recursion and no
				// filter driver.
				const hardened = invocations.filter(
					(entry) => entry.args[0] === 'fetch' || entry.args[0] === 'worktree'
				);
				expect(hardened.length).toBeGreaterThanOrEqual(3);
				for (const entry of hardened) {
					const pairs = configPairs(entry.env);
					const hooksPaths = pairs.filter(([key]) => key === 'core.hooksPath').map(([, value]) => value);
					expect(hooksPaths.length).toBeGreaterThanOrEqual(1);
					// The LAST word on hooks is an empty directory, never `''`.
					expect(hooksPaths.at(-1)).not.toBe('');
					expect(readdirSync(hooksPaths.at(-1) as string)).toEqual([]);
					expect(pairs).toContainEqual(['core.fsmonitor', 'false']);
					expect(pairs).toContainEqual(['protocol.ext.allow', 'never']);
					expect(pairs).toContainEqual(['submodule.recurse', 'false']);
					expect(pairs).toContainEqual(['filter.lfs.smudge', '']);
					expect(entry.env.GIT_LFS_SKIP_SMUDGE).toBe('1');
				}
			});
		});

		describe('no credential — the fetch is exactly what it was', () => {
			it('with NO provider wired, nothing is added to the provider call or to any child', async () => {
				const { invocations, specs, provisioner } = harness();
				const { taskId, branch } = nextTask();

				const descriptor = await provisioner.provision(taskId, single(branch));

				expect(existsSync(join(descriptor.path, 'PRIMARY.md'))).toBe(true);
				expect(Object.keys(specs[0]).sort()).toEqual(LEGACY_PROVISION_KEYS);
				expect(fetchesOf(invocations)).toHaveLength(2);
				for (const entry of invocations) {
					expect(headerOf(entry)).toBeUndefined();
					// The machine's own Git configuration answers: the helper list
					// and askpass are NOT reset.
					expect(configPairs(entry.env).map(([key]) => key)).not.toContain('credential.helper');
					expect(configPairs(entry.env).map(([key]) => key)).not.toContain('core.askpass');
				}
			});

			it.each([
				[
					'the platform has no installation covering the repository',
					async (): Promise<FleetJobFetchCredentialResponse> => ({
						credentials: [],
						uncovered: [{ repository: PRIMARY_ID, reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON }]
					})
				],
				[
					'the API predates the endpoint (404)',
					async (): Promise<FleetJobFetchCredentialResponse> => {
						throw new FleetClientError('invalid-request', 'Request rejected by the API (HTTP 404)', 404);
					}
				],
				[
					'the platform cannot be reached',
					async (): Promise<FleetJobFetchCredentialResponse> => {
						throw new FleetClientError('network', 'Could not reach https://api.ever.works');
					}
				]
			])(
				'when %s the run is NOT failed and the provider call is byte-for-byte the old one',
				async (_label, mint) => {
					const { invocations, specs, provisioner } = harness();
					const { provider, client } = session(mint);
					const { taskId, branch } = nextTask();

					const descriptor = await provisioner.provision(taskId, single(branch), undefined, {
						fetchCredentials: provider
					});

					expect(existsSync(join(descriptor.path, 'PRIMARY.md'))).toBe(true);
					expect(client.mintFetchCredential).toHaveBeenCalledTimes(1);
					// Not a credential-shaped blank, not an empty callback: the keys
					// are exactly the keys a node without this feature sends.
					expect(Object.keys(specs[0]).sort()).toEqual(LEGACY_PROVISION_KEYS);
					expect(fetchesOf(invocations)).toHaveLength(2);
					for (const entry of invocations) {
						expect(headerOf(entry)).toBeUndefined();
						expect(configPairs(entry.env).map(([key]) => key)).not.toContain('credential.helper');
					}
				}
			);
		});

		describe('several repositories — each on its own', () => {
			it('covers the repository that can be covered and falls back for the one that cannot', async () => {
				const { invocations, specs, provisioner } = harness();
				const { provider, client } = session(async () => ({
					...covering([PRIMARY_ID, PRIMARY_TOKEN]),
					uncovered: [{ repository: MOUNT_ID, reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON }]
				}));
				const { taskId, branch } = nextTask();

				const descriptor = await provisioner.provision(taskId, withMount(branch), undefined, {
					fetchCredentials: provider
				});

				// Both repositories were provisioned: one uncoverable mount did not
				// take the credential away from the primary, nor fail the run.
				expect(existsSync(join(descriptor.path, 'PRIMARY.md'))).toBe(true);
				expect(existsSync(join(descriptor.mounts?.[0].path ?? '', 'MOUNT.md'))).toBe(true);
				// One question to the platform for the whole workspace.
				expect(client.mintFetchCredential).toHaveBeenCalledTimes(1);

				expect(specs.map((spec) => spec.repoUrl)).toEqual([PRIMARY_URL, MOUNT_URL]);
				expect(specs[0].fetchCredential?.token).toBe(PRIMARY_TOKEN);
				expect(Object.keys(specs[1]).sort()).toEqual(LEGACY_PROVISION_KEYS);

				for (const fetch of fetchesOf(invocations, PRIMARY_URL)) {
					expect(headerOf(fetch)?.[0]).toBe(`http.${PRIMARY_URL}.extraheader`);
				}
				const mountFetches = fetchesOf(invocations, MOUNT_URL);
				expect(mountFetches).toHaveLength(2);
				for (const fetch of mountFetches) {
					// The mount is fetched as it always was — and the PRIMARY's
					// token is nowhere near it.
					expect(headerOf(fetch)).toBeUndefined();
					expect(JSON.stringify(fetch.env)).not.toContain(PRIMARY_TOKEN);
					expect(JSON.stringify(fetch.env)).not.toContain(basic(PRIMARY_TOKEN));
				}
			});

			it('gives each repository ITS OWN token and never another repository’s', async () => {
				const { invocations, provisioner } = harness();
				const { provider } = session(async () =>
					covering([PRIMARY_ID, PRIMARY_TOKEN], [MOUNT_ID, MOUNT_TOKEN])
				);
				const { taskId, branch } = nextTask();

				await provisioner.provision(taskId, withMount(branch), undefined, { fetchCredentials: provider });

				const primaryFetches = fetchesOf(invocations, PRIMARY_URL);
				const mountFetches = fetchesOf(invocations, MOUNT_URL);
				expect(primaryFetches).toHaveLength(2);
				expect(mountFetches).toHaveLength(2);
				for (const fetch of primaryFetches) {
					expect(headerOf(fetch)).toEqual([
						`http.${PRIMARY_URL}.extraheader`,
						`Authorization: Basic ${basic(PRIMARY_TOKEN)}`
					]);
					expect(JSON.stringify(fetch.env)).not.toContain(basic(MOUNT_TOKEN));
				}
				for (const fetch of mountFetches) {
					expect(headerOf(fetch)).toEqual([
						`http.${MOUNT_URL}.extraheader`,
						`Authorization: Basic ${basic(MOUNT_TOKEN)}`
					]);
					expect(JSON.stringify(fetch.env)).not.toContain(basic(PRIMARY_TOKEN));
				}
				expect(filesContaining(workspaceRoot, [PRIMARY_TOKEN, MOUNT_TOKEN])).toEqual([]);
			});
		});

		describe('a refusal about the REQUEST fails the run — it does not fall back', () => {
			it('fails with `fetch-credential` and the reason when the platform refuses the claim (401)', async () => {
				const { invocations, specs, provisioner } = harness();
				const { provider } = session(async () => {
					throw new FleetClientError('unauthorized', 'The platform refused this job', 401);
				});
				const { taskId, branch } = nextTask();

				const error = await provisioner
					.provision(taskId, single(branch), undefined, { fetchCredentials: provider })
					.catch((caught: unknown) => caught);

				expect(error).toMatchObject({ name: 'FleetTaskWorkspaceError', code: 'fetch-credential' });
				expect((error as Error).message).toBe(
					`Refusing to fetch repository '${PRIMARY_ID}': the platform refused this node’s claim on the job when it ` +
						'asked for a scoped read credential (the job is not assigned to this node, or it is no longer active)'
				);
				// NOTHING was fetched: the provider was never reached, so no `git
				// fetch` ran with whatever this machine's own helper would answer.
				expect(specs).toEqual([]);
				expect(fetchesOf(invocations)).toEqual([]);
				// And the failed provision holds no job.
				expect(provisioner.activeBindingKeys().size).toBe(0);
			});

			it('lets a stale lease (409) reach the worker with its identity intact', async () => {
				const stale = new FleetClientError('stale-lease', 'The platform holds a newer lease on this job', 409);
				const { specs, provisioner } = harness();
				const { provider } = session(async () => {
					throw stale;
				});
				const { taskId, branch } = nextTask();

				await expect(
					provisioner.provision(taskId, single(branch), undefined, { fetchCredentials: provider })
				).rejects.toBe(stale);
				expect(specs).toEqual([]);
			});

			it('names the MOUNT when it is a mount the refusal is about', async () => {
				const { provisioner } = harness();
				const provider: FetchCredentialProvider = {
					credentialFor: async (remoteUrl) => {
						if (remoteUrl === MOUNT_URL) throw new FetchCredentialError('refused for the mount');
						return { credential: null, unavailable: 'none for the primary' };
					}
				};
				const { taskId, branch } = nextTask();

				const error = await provisioner
					.provision(taskId, withMount(branch), undefined, { fetchCredentials: provider })
					.catch((caught: unknown) => caught);

				expect(error).toMatchObject({ code: 'fetch-credential' });
				expect((error as Error).message).toBe(
					`mount 'template' (${MOUNT_ID}): Refusing to fetch repository '${MOUNT_ID}': refused for the mount`
				);
			});
		});

		describe('a fetch that fails says how it tried', () => {
			const gitEcho = `fatal: could not read Username for 'https://github.com': terminal prompts disabled (${PRIMARY_TOKEN} ${basic(PRIMARY_TOKEN)})`;

			it('is the OLD message, character for character, when no provider is wired', async () => {
				const { provisioner } = harness({ failFetchWith: gitEcho });
				const { taskId, branch } = nextTask();

				await expect(provisioner.provision(taskId, single(branch))).rejects.toMatchObject({
					code: 'provision-failed',
					message: `Git fetch or workspace provisioning failed for repository '${PRIMARY_ID}' at 'main'`
				});
			});

			it('names the missing installation when the repository had no credential', async () => {
				// The case this feature exists for, seen from a node it cannot
				// help: a private repository the App is not installed on. "Git
				// fetch failed" alone sends an operator hunting a network fault.
				const { provisioner } = harness({ failFetchWith: gitEcho });
				const { provider } = session(async () => ({
					credentials: [],
					uncovered: [{ repository: PRIMARY_ID, reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON }]
				}));
				const { taskId, branch } = nextTask();

				const error = await provisioner
					.provision(taskId, single(branch), undefined, { fetchCredentials: provider })
					.catch((caught: unknown) => caught);

				expect(error).toMatchObject({ code: 'provision-failed' });
				expect((error as Error).message).toContain(
					`Git fetch or workspace provisioning failed for repository '${PRIMARY_ID}' at 'main' (no scoped read credential: ` +
						'no GitHub App installation this owner controls covers this repository'
				);
				expect((error as Error).message).toContain('the fetch used this machine’s own Git configuration');
			});

			it('says the scoped credential was used — and never echoes it, whatever Git printed', async () => {
				const { provisioner } = harness({ failFetchWith: gitEcho });
				const { provider } = session(async () => covering([PRIMARY_ID, PRIMARY_TOKEN]));
				const { taskId, branch } = nextTask();

				const error = await provisioner
					.provision(taskId, single(branch), undefined, { fetchCredentials: provider })
					.catch((caught: unknown) => caught);

				expect(error).toMatchObject({ code: 'provision-failed' });
				expect((error as Error).message).toBe(
					`Git fetch or workspace provisioning failed for repository '${PRIMARY_ID}' at 'main' ` +
						'(fetched with the scoped read credential the platform issued for this repository)'
				);
				// This text becomes the job's failure reason, stored in
				// `fleet_jobs.result` and rendered on the Task page.
				expect((error as Error).message).not.toContain(PRIMARY_TOKEN);
				expect((error as Error).message).not.toContain(basic(PRIMARY_TOKEN));
			});
		});

		describe('a pool that could redirect or intercept the request', () => {
			it('never sees the credential: it is withheld, the fetch runs as before, and the operator is told', async () => {
				const pool = poolFor(PRIMARY_URL);
				// What a previous run's model could leave behind through its
				// worktree's `.git` pointer: TLS verification off and a proxy.
				git(pool, 'config', '--local', 'http.sslVerify', 'false');
				git(pool, 'config', '--local', 'http.proxy', 'http://127.0.0.1:9');
				try {
					const { invocations, provisioner } = harness();
					const { provider, entries } = session(async () => covering([PRIMARY_ID, PRIMARY_TOKEN]));
					const { taskId, branch } = nextTask();

					const descriptor = await provisioner.provision(taskId, single(branch), undefined, {
						fetchCredentials: provider
					});

					// Not a failure — the fallback…
					expect(existsSync(join(descriptor.path, 'PRIMARY.md'))).toBe(true);
					// …and Git never held the token, in any child, in any form.
					expect(fetchesOf(invocations)).toHaveLength(2);
					for (const entry of invocations) {
						expect(headerOf(entry)).toBeUndefined();
						expect(JSON.stringify(entry.env)).not.toContain(PRIMARY_TOKEN);
						expect(JSON.stringify(entry.env)).not.toContain(basic(PRIMARY_TOKEN));
					}
					const warnings = entries.filter((entry) => entry.level === 'warn').map((entry) => entry.message);
					expect(warnings).toHaveLength(1);
					expect(warnings[0]).toContain('was not handed to Git');
					expect(warnings[0]).toContain('http.sslverify');
					expect(warnings[0]).toContain('http.proxy');
					expect(warnings[0]).toContain(`https://github.com/${PRIMARY_ID}.git`);
					// Key names only: no planted value reaches a log line.
					expect(warnings[0]).not.toContain('127.0.0.1');
				} finally {
					git(pool, 'config', '--local', '--unset-all', 'http.sslVerify');
					git(pool, 'config', '--local', '--unset-all', 'http.proxy');
				}
			});
		});
	}
);
