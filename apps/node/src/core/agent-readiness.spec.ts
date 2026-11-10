import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	FLEET_AGENT_FAILURE_FALLBACK_MS,
	FLEET_AGENT_VERDICT_MAX_AGE_MS,
	describeFleetAgentReason
} from '@ever-works/contracts';
import {
	AGENT_AUTH_PROBE_TIMEOUT_MS,
	AGENT_SUCCESS_TRUST_MS,
	AgentProbeEnvironments,
	AgentRunHistory,
	agentAuthFingerprint,
	agentRunHistoryPath,
	buildAgentReadinessReport,
	detectUnsupportedAgentClis,
	parseAgentRunHistoryRecord,
	probeAgentAuth,
	quoteProbeExecutable,
	readClaudeAuthStatus,
	readClaudeRateLimitWindows,
	readCodexLoginStatus,
	readCodexRateLimitLine,
	readNewestCodexRateLimits,
	resolveAgentStatus,
	type AgentAuthProbe,
	type AgentAuthReading,
	type AgentRecordFs,
	type AgentRunFailure,
	type AgentRunHistoryEntry,
	type AgentRunHistoryRecord
} from './agent-readiness';
import type { CommandRunOptions, CommandRunner } from './capabilities';
import { buildNodeCheckEnv } from './executors/acceptance-checks';
import { createCommandRunner } from '../node-io';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/**
 * Credential-SHAPED fixtures for the masking cases. Assembled at runtime from
 * plainly fake parts, so no line of this file holds anything a secret scanner
 * (or a reader) could take for a real key. None of them is a credential.
 */
const FAKE_API_KEY = ['sk', 'ant', 'api03', 'FAKE'.repeat(8)].join('-');
const FAKE_TOKEN = ['sk', 'ant', 'oat01', 'FAKE'.repeat(4)].join('-');
/** What `codex login status` prints beside "API key configured": a MASKED key. */
const MASKED_KEY = ['sk', 'proj', '***ABCDE'].join('-');
const ISO = '2026-11-10T12:00:00.000Z';

/** The two sentences the production node actually failed with. */
const ORG_DISABLED =
	'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';
const SESSION_EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';

const SIGNED_IN: AgentAuthReading = {
	signedIn: true,
	method: 'subscription',
	account: 'owner@example.com (Acme, max)'
};
const SIGNED_OUT: AgentAuthReading = { signedIn: false, method: 'none', account: null };
const answered = (reading: AgentAuthReading): AgentAuthProbe => ({ state: 'answered', reading });

/** What the two CLIs print for the status command's parent, and what a CLI without it prints instead. */
const CLAUDE_AUTH_HELP = [
	'Usage: claude auth [options] [command]',
	'',
	'Manage authentication',
	'',
	'Commands:',
	'  login [options]   Sign in to your Anthropic account',
	'  logout            Log out from your Anthropic account',
	'  status [options]  Show authentication status'
].join('\n');
const CLAUDE_ROOT_HELP = [
	'Usage: claude [options] [command] [prompt]',
	'',
	'Claude Code - starts an interactive session by default, use -p/--print for non-interactive output',
	'',
	'Commands:',
	'  mcp     Configure and manage MCP servers',
	'  update  Check for updates and install if available'
].join('\n');
const CODEX_LOGIN_HELP = [
	'Manage login',
	'',
	'Usage: codex login [OPTIONS] [COMMAND]',
	'',
	'Commands:',
	'  status  Show login status',
	'  help    Print this message or the help of the given subcommand(s)'
].join('\n');
const CODEX_ROOT_HELP = [
	'Codex CLI',
	'',
	'Usage: codex [OPTIONS] [PROMPT]',
	'       codex [OPTIONS] <COMMAND> [ARGS]'
].join('\n');

function emptyEntry(overrides: Partial<AgentRunHistoryEntry> = {}): AgentRunHistoryEntry {
	return { lastSuccessAt: null, failure: null, usage: [], usageObservedAt: null, ...overrides };
}

function failure(overrides: Partial<AgentRunFailure> = {}): AgentRunFailure {
	return {
		kind: 'access_denied',
		code: 'org_access_disabled',
		window: null,
		resetsAt: null,
		until: null,
		usageLimit: false,
		at: ISO,
		authFingerprint: null,
		...overrides
	};
}

type Answer = { code?: number | null; stdout?: string; stderr?: string; timedOut?: boolean; spawnError?: string };

/** A runner that answers from a table keyed by `"<command> <args>"`, recording every call and its options. */
function tableRunner(table: Record<string, Answer | Error>) {
	const calls: string[] = [];
	const options: Array<CommandRunOptions | undefined> = [];
	const runner: CommandRunner = {
		run: async (command, args, runOptions) => {
			const key = `${command} ${args.join(' ')}`;
			calls.push(key);
			options.push(runOptions);
			const answer = table[key];
			if (answer instanceof Error) throw answer;
			if (!answer) return { code: 127, stdout: '', stderr: 'not found' };
			return {
				code: answer.code ?? 0,
				stdout: answer.stdout ?? '',
				stderr: answer.stderr ?? '',
				...(answer.timedOut ? { timedOut: true } : {}),
				...(answer.spawnError ? { spawnError: answer.spawnError } : {})
			};
		}
	};
	return { runner, calls, options };
}

const POSIX_PROBE = { platform: 'linux' };

describe('readClaudeAuthStatus (`claude auth status --json`)', () => {
	it('reads a subscription login with its account label', () => {
		expect(
			readClaudeAuthStatus(
				JSON.stringify({
					loggedIn: true,
					authMethod: 'claude.ai',
					apiProvider: 'firstParty',
					email: 'owner@example.com',
					orgId: 'org-1',
					orgName: 'Acme',
					subscriptionType: 'max'
				})
			)
		).toEqual({ signedIn: true, method: 'subscription', account: 'owner@example.com (Acme, max)' });
	});

	it.each([
		['claude.ai', 'subscription'],
		['oauth_token', 'subscription'],
		['api_key', 'api_key'],
		['api_key_helper', 'api_key'],
		['third_party', 'cloud_provider'],
		['something-new', 'unknown']
	])('maps authMethod %s to %s', (authMethod, method) => {
		expect(readClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod }))?.method).toBe(method);
	});

	it('reads the signed-out document (what a machine with no login prints, exit 1)', () => {
		expect(
			readClaudeAuthStatus(
				JSON.stringify({
					loggedIn: false,
					authMethod: 'none',
					apiProvider: 'firstParty',
					configDirectory: '/home/u/.claude'
				})
			)
		).toEqual(SIGNED_OUT);
	});

	it('falls back to authMethod when a version prints no loggedIn', () => {
		expect(readClaudeAuthStatus(JSON.stringify({ authMethod: 'none' }))).toEqual(SIGNED_OUT);
		expect(readClaudeAuthStatus(JSON.stringify({ authMethod: 'api_key' }))?.signedIn).toBe(true);
	});

	it('never forwards a field it does not name', () => {
		const reading = readClaudeAuthStatus(
			JSON.stringify({
				loggedIn: true,
				authMethod: 'oauth_token',
				email: 'owner@example.com',
				accessToken: FAKE_TOKEN,
				configDirectory: '/home/owner/.claude'
			})
		);
		expect(JSON.stringify(reading)).not.toContain('FAKE');
		expect(JSON.stringify(reading)).not.toContain('/home/owner');
	});

	it('answers null for anything that is not the document', () => {
		for (const stdout of ['', 'error: unknown command auth', '[]', '"ok"', '{"version":"2.1.3"}']) {
			expect(readClaudeAuthStatus(stdout)).toBeNull();
		}
	});
});

describe('readCodexLoginStatus (`codex login status`)', () => {
	it.each([
		['Logged in using ChatGPT', true, 'subscription'],
		[`API key configured - ${MASKED_KEY}`, true, 'api_key'],
		[`Logged in using an API key - ${MASKED_KEY}`, true, 'api_key'],
		['Logged in using access token', true, 'access_token'],
		['Logged in using personal access token', true, 'access_token'],
		['Logged in using workload identity', true, 'access_token'],
		['Logged in using Amazon Bedrock API key', true, 'cloud_provider'],
		['Logged in using Amazon Bedrock AWS access keys', true, 'cloud_provider'],
		['Not logged in', false, 'none']
	])('%s', (line, signedIn, method) => {
		expect(readCodexLoginStatus(line)).toEqual({ signedIn, method, account: null });
	});

	it('keeps nothing of the line itself — it carries a masked key', () => {
		expect(JSON.stringify(readCodexLoginStatus(`API key configured - ${MASKED_KEY}`))).not.toContain('sk-proj');
	});

	it('answers null when the output says neither', () => {
		expect(readCodexLoginStatus('')).toBeNull();
		expect(readCodexLoginStatus('error: unrecognized subcommand')).toBeNull();
	});
});

describe('probeAgentAuth', () => {
	it('asks the pinned binary for its help, then its own free status command — never a model', async () => {
		const { runner, calls } = tableRunner({
			'/opt/claude auth --help': { stdout: CLAUDE_AUTH_HELP },
			'/opt/claude auth status --json': { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) },
			'/opt/codex login --help': { stdout: CODEX_LOGIN_HELP },
			// Codex prints to stderr and exits 1 when signed out.
			'/opt/codex login status': { code: 1, stderr: 'Not logged in\n' }
		});
		expect(await probeAgentAuth(runner, 'claude-code', '/opt/claude', POSIX_PROBE)).toEqual(
			answered({ signedIn: true, method: 'subscription', account: null })
		);
		expect(await probeAgentAuth(runner, 'codex', '/opt/codex', POSIX_PROBE)).toEqual(answered(SIGNED_OUT));
		expect(calls).toEqual([
			'/opt/claude auth --help',
			'/opt/claude auth status --json',
			'/opt/codex login --help',
			'/opt/codex login status'
		]);
		// No prompt flag ever reaches a CLI from here.
		expect(calls.join(' ')).not.toMatch(/(^| )(-p|--print|exec)( |$)/);
	});

	it('runs every command with stdin closed, under the 15 s deadline, in the environment it was given', async () => {
		const env = { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'granted-to-runs' };
		const { runner, options } = tableRunner({
			'/opt/claude auth --help': { stdout: CLAUDE_AUTH_HELP },
			'/opt/claude auth status --json': { stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }) }
		});
		await probeAgentAuth(runner, 'claude-code', '/opt/claude', { platform: 'linux', env });
		expect(AGENT_AUTH_PROBE_TIMEOUT_MS).toBe(15_000);
		expect(options).toHaveLength(2);
		for (const used of options) {
			expect(used).toEqual({ timeoutMs: 15_000, closeStdin: true, env });
		}
	});

	it('reads a signed-out Claude document even though the command exits 1', async () => {
		const { runner } = tableRunner({
			'claude auth --help': { stdout: CLAUDE_AUTH_HELP },
			'claude auth status --json': { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }) }
		});
		expect(await probeAgentAuth(runner, 'claude-code', 'claude', POSIX_PROBE)).toEqual(answered(SIGNED_OUT));
	});

	it('an OLD Claude Code without `auth` answers its root help: the status command is never run', async () => {
		// `claude auth status --json` on such a CLI would be read as the PROMPT
		// "auth status" — an interactive session, or a model call. The help
		// request is parsed before any command runs, so it cannot start either.
		const { runner, calls } = tableRunner({
			'claude auth --help': { stdout: CLAUDE_ROOT_HELP },
			'claude auth status --json': { stdout: 'A model wrote this.' }
		});
		expect(await probeAgentAuth(runner, 'claude-code', 'claude', POSIX_PROBE)).toEqual({ state: 'unavailable' });
		expect(calls).toEqual(['claude auth --help']);
	});

	it('an OLD Codex without `login status` is not asked either', async () => {
		const rootHelp = tableRunner({ 'codex login --help': { stdout: CODEX_ROOT_HELP } });
		expect(await probeAgentAuth(rootHelp.runner, 'codex', 'codex', POSIX_PROBE)).toEqual({ state: 'unavailable' });
		expect(rootHelp.calls).toEqual(['codex login --help']);
		// `login` exists but has no `status`: `codex login status` could start a browser sign-in.
		const noStatus = tableRunner({ 'codex login --help': { stdout: 'Usage: codex login [OPTIONS]\n' } });
		expect(await probeAgentAuth(noStatus.runner, 'codex', 'codex', POSIX_PROBE)).toEqual({ state: 'unavailable' });
		expect(noStatus.calls).toEqual(['codex login --help']);
	});

	it('answers "unanswered" — could not tell — when a command fails, times out, says nothing or is not a known CLI', async () => {
		const throws = tableRunner({ 'claude auth --help': new Error('spawn ENOENT') });
		expect(await probeAgentAuth(throws.runner, 'claude-code', 'claude', POSIX_PROBE)).toEqual({
			state: 'unanswered'
		});
		expect(await probeAgentAuth(throws.runner, 'gemini', 'gemini', POSIX_PROBE)).toEqual({ state: 'unanswered' });

		const helpTimedOut = tableRunner({ 'codex login --help': { code: null, timedOut: true } });
		expect(await probeAgentAuth(helpTimedOut.runner, 'codex', 'codex', POSIX_PROBE)).toEqual({
			state: 'unanswered'
		});
		expect(helpTimedOut.calls).toEqual(['codex login --help']);

		const silentHelp = tableRunner({ 'claude auth --help': { stdout: '' } });
		expect(await probeAgentAuth(silentHelp.runner, 'claude-code', 'claude', POSIX_PROBE)).toEqual({
			state: 'unanswered'
		});

		// What cmd.exe answers for a command it cannot find: exit 1 and a sentence, no help page.
		const notRecognized = tableRunner({
			'codex login --help': { code: 1, stderr: "'codex' is not recognized as an internal or external command" }
		});
		expect(await probeAgentAuth(notRecognized.runner, 'codex', 'codex', POSIX_PROBE)).toEqual({
			state: 'unanswered'
		});
		expect(notRecognized.calls).toEqual(['codex login --help']);

		const notInstalled = tableRunner({ 'claude auth --help': { code: 1, spawnError: 'ENOENT' } });
		expect(await probeAgentAuth(notInstalled.runner, 'claude-code', 'claude', POSIX_PROBE)).toEqual({
			state: 'unanswered'
		});

		const statusTimedOut = tableRunner({
			'claude auth --help': { stdout: CLAUDE_AUTH_HELP },
			'claude auth status --json': { code: null, timedOut: true, stdout: '{"loggedIn":tr' }
		});
		expect(await probeAgentAuth(statusTimedOut.runner, 'claude-code', 'claude', POSIX_PROBE)).toEqual({
			state: 'unanswered'
		});

		const garbage = tableRunner({
			'claude auth --help': { stdout: CLAUDE_AUTH_HELP },
			'claude auth status --json': { stdout: 'Welcome to Claude Code!' }
		});
		expect(await probeAgentAuth(garbage.runner, 'claude-code', 'claude', POSIX_PROBE)).toEqual({
			state: 'unanswered'
		});
	});

	describe('a Windows path with a space', () => {
		const spaced = 'C:\\Program Files\\Claude Code\\claude.cmd';

		it('is quoted for cmd.exe, exactly once, and left alone elsewhere', () => {
			expect(quoteProbeExecutable(spaced, 'win32')).toBe(`"${spaced}"`);
			expect(quoteProbeExecutable(`"${spaced}"`, 'win32')).toBe(`"${spaced}"`);
			expect(quoteProbeExecutable('C:\\Tools\\claude.cmd', 'win32')).toBe('C:\\Tools\\claude.cmd');
			// No shell on POSIX: the path is one argv entry and quotes would become part of the name.
			expect(quoteProbeExecutable('/opt/claude code/claude', 'linux')).toBe('/opt/claude code/claude');
		});

		it('reaches the runner quoted, for the help and for the status command', async () => {
			const { runner, calls } = tableRunner({
				[`"${spaced}" auth --help`]: { stdout: CLAUDE_AUTH_HELP },
				[`"${spaced}" auth status --json`]: {
					stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })
				}
			});
			expect(await probeAgentAuth(runner, 'claude-code', spaced, { platform: 'win32' })).toEqual(
				answered({ signedIn: true, method: 'subscription', account: null })
			);
			expect(calls).toEqual([`"${spaced}" auth --help`, `"${spaced}" auth status --json`]);
		});
	});
});

/**
 * The same probe against REAL processes, through the daemon's real command
 * runner: stub CLIs written into a temporary directory whose name has a
 * space in it. Runs on every OS (a `.cmd` shim on Windows, a shell script
 * elsewhere).
 */
describe('probeAgentAuth through the real command runner', () => {
	const windows = process.platform === 'win32';
	const dirs: string[] = [];
	afterAll(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	function stubCli(script: { cmd: string[]; sh: string[] }): { executable: string; dir: string } {
		const dir = mkdtempSync(join(tmpdir(), 'ever works probe '));
		dirs.push(dir);
		const executable = join(dir, windows ? 'claude.cmd' : 'claude');
		writeFileSync(executable, windows ? `${script.cmd.join('\r\n')}\r\n` : `${script.sh.join('\n')}\n`);
		if (!windows) chmodSync(executable, 0o755);
		return { executable, dir };
	}

	const DOCUMENT = (org: string) =>
		`{"loggedIn":true,"authMethod":"claude.ai","email":"owner@example.com","orgName":"${org}","subscriptionType":"max"}`;

	it('a directory with a space, the allow-listed environment and a closed stdin', async () => {
		// The stub's status command first READS A LINE from stdin — with stdin
		// left open it would sit there until the deadline — and then names in
		// `orgName` whether a variable only the daemon has reached it.
		const { executable } = stubCli({
			cmd: [
				'@echo off',
				'if "%2"=="--help" (',
				'  echo Usage: claude auth [options] [command]',
				'  echo   status  Show authentication status',
				'  exit /b 0',
				')',
				'set /p LINE=',
				'if defined EVER_PROBE_DAEMON_ONLY (set ORG=leaked) else (set ORG=clean)',
				`echo ${DOCUMENT('%ORG%')}`
			],
			sh: [
				'#!/bin/sh',
				'if [ "$2" = "--help" ]; then',
				'  echo "Usage: claude auth [options] [command]"',
				'  echo "  status  Show authentication status"',
				'  exit 0',
				'fi',
				'read LINE',
				'ORG=clean',
				'if [ -n "$EVER_PROBE_DAEMON_ONLY" ]; then ORG=leaked; fi',
				`echo '${DOCUMENT('\'"$ORG"\'')}'`
			]
		});
		expect(executable).toMatch(/\s/);
		const daemonEnv = { ...process.env, EVER_PROBE_DAEMON_ONLY: 'only-the-daemon-has-this' };
		const env = buildNodeCheckEnv([], daemonEnv);
		expect(Object.keys(env)).not.toContain('EVER_PROBE_DAEMON_ONLY');

		const startedAt = Date.now();
		const probe = await probeAgentAuth(createCommandRunner(), 'claude-code', executable, {
			platform: process.platform,
			env
		});
		expect(probe).toEqual(
			answered({ signedIn: true, method: 'subscription', account: 'owner@example.com (clean, max)' })
		);
		// Answered on end-of-file, not at the 15 s deadline.
		expect(Date.now() - startedAt).toBeLessThan(10_000);
	}, 30_000);

	it('a CLI without the status subcommand is never started with it', async () => {
		// The stub records a marker file if it is ever run with `auth status`.
		const { executable, dir } = stubCli({
			cmd: [
				'@echo off',
				'if "%2"=="status" echo ran> "%~dp0status-was-run"',
				'echo Usage: claude [options] [command] [prompt]'
			],
			sh: [
				'#!/bin/sh',
				'if [ "$2" = "status" ]; then echo ran > "$(dirname "$0")/status-was-run"; fi',
				'echo "Usage: claude [options] [command] [prompt]"'
			]
		});
		const probe = await probeAgentAuth(createCommandRunner(), 'claude-code', executable, {
			platform: process.platform,
			env: buildNodeCheckEnv([], process.env)
		});
		expect(probe).toEqual({ state: 'unavailable' });
		expect(existsSync(join(dir, 'status-was-run'))).toBe(false);
	}, 30_000);
});

describe('AgentProbeEnvironments — the status command sees what a run sees (review item 7)', () => {
	// Plainly fake values: the point is which NAMES survive, never what they hold.
	const daemonEnv = {
		PATH: '/usr/bin',
		HOME: '/home/owner',
		CLAUDE_CODE_OAUTH_TOKEN: 'fake-subscription-token',
		ANTHROPIC_API_KEY: 'fake-console-key',
		OPENAI_API_KEY: 'fake-openai-key',
		DATABASE_URL: 'fake-daemon-only-value',
		EVER_WORKS_NODE_SECRET: 'fake-node-secret'
	};
	const DEFAULT_NAMES = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'];

	// `buildNodeCheckEnv` says which credential it chose on the console; not this suite's subject.
	beforeEach(() => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function environments() {
		const builds: string[][] = [];
		const probeEnvironments = new AgentProbeEnvironments({
			build: (names) => {
				builds.push([...names]);
				return buildNodeCheckEnv(names, daemonEnv);
			},
			defaultNames: DEFAULT_NAMES
		});
		return { probeEnvironments, builds };
	}

	it('before any run: the default names, one credential per CLI, and nothing else of the daemon`s', () => {
		const { probeEnvironments } = environments();
		const { env } = probeEnvironments.resolve('claude-code');
		// The same exclusive choice a run gets: the subscription token wins over the Console key.
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('fake-subscription-token');
		expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
		expect(env).not.toHaveProperty('DATABASE_URL');
		expect(env).not.toHaveProperty('EVER_WORKS_NODE_SECRET');
		expect(env.PATH).toBe('/usr/bin');
		// Headless, like a run.
		expect(env.CI).toBe('1');
	});

	it('after a run: the names THAT run was granted — the credential the next run will use', () => {
		const { probeEnvironments } = environments();
		const before = probeEnvironments.resolve('claude-code');
		probeEnvironments.noteRun('claude-code', ['ANTHROPIC_API_KEY']);
		const after = probeEnvironments.resolve('claude-code');
		expect(after.env.ANTHROPIC_API_KEY).toBe('fake-console-key');
		expect(after.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
		// A different key: a reading cached for the old environment is not reused.
		expect(after.key).not.toBe(before.key);
		// The other CLI is unaffected.
		expect(probeEnvironments.resolve('codex').key).toBe(before.key);
	});

	it('a run granted NO credential name means the CLI`s own login: the probe gets none either', () => {
		const { probeEnvironments } = environments();
		probeEnvironments.noteRun('claude-code', []);
		const { env } = probeEnvironments.resolve('claude-code');
		expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
		expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
		expect(env.HOME).toBe('/home/owner');
	});

	it('builds one environment per distinct list of names, and ignores a run that names none at all', () => {
		const { probeEnvironments, builds } = environments();
		probeEnvironments.resolve('claude-code');
		probeEnvironments.resolve('codex');
		probeEnvironments.noteRun('claude-code', undefined);
		probeEnvironments.noteRun('claude-code', null);
		probeEnvironments.resolve('claude-code');
		expect(builds).toEqual([DEFAULT_NAMES]);
		probeEnvironments.noteRun('codex', ['openai_api_key', 'OPENAI_API_KEY']);
		probeEnvironments.resolve('codex');
		probeEnvironments.resolve('codex');
		expect(builds).toHaveLength(2);
	});
});

describe('detectUnsupportedAgentClis', () => {
	it('lists the CLIs that answer --version and skips the rest', async () => {
		const { runner, options } = tableRunner({
			'gemini --version': { stdout: '0.9.1\n' },
			'opencode --version': new Error('spawn ENOENT')
		});
		expect(await detectUnsupportedAgentClis(runner)).toEqual([{ provider: 'gemini', version: '0.9.1' }]);
		expect(options[0]).toMatchObject({ closeStdin: true });
	});
});

describe('readClaudeRateLimitWindows (a real run`s own stream)', () => {
	const event = (info: Record<string, unknown>) =>
		JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'u', session_id: 's' });

	it('reads utilisation, reset and length per window, newest event per window', () => {
		const output = [
			JSON.stringify({ type: 'system', subtype: 'init' }),
			event({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1, resetsAt: 1_794_000_000 }),
			event({
				status: 'allowed_warning',
				rateLimitType: 'five_hour',
				utilization: 0.825,
				resetsAt: 1_794_000_000
			}),
			event({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.4, resetsAt: 1_794_400_000 }),
			JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
		].join('\n');
		expect(readClaudeRateLimitWindows(output)).toEqual([
			{
				window: 'five_hour',
				usedPercent: 82.5,
				resetsAt: new Date(1_794_000_000_000).toISOString(),
				windowMinutes: 300
			},
			{
				window: 'weekly',
				usedPercent: 40,
				resetsAt: new Date(1_794_400_000_000).toISOString(),
				windowMinutes: 10_080
			}
		]);
	});

	it('marks a rejected window as exhausted, and keeps a window that gave only its reset', () => {
		expect(
			readClaudeRateLimitWindows(
				[
					event({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 1_794_400_000 }),
					event({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1_794_000_000 })
				].join('\n')
			)
		).toEqual([
			{
				window: 'weekly_opus',
				usedPercent: null,
				resetsAt: new Date(1_794_400_000_000).toISOString(),
				limited: true,
				windowMinutes: 10_080
			},
			{
				window: 'five_hour',
				usedPercent: null,
				resetsAt: new Date(1_794_000_000_000).toISOString(),
				windowMinutes: 300
			}
		]);
	});

	it('ignores the same words inside a tool result — a repository cannot forge a reading', () => {
		const forged = JSON.stringify({
			type: 'user',
			message: {
				content: [
					{
						type: 'tool_result',
						content:
							'{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour"}}'
					}
				]
			}
		});
		expect(readClaudeRateLimitWindows(forged)).toEqual([]);
	});

	it('answers nothing for output with no such event, junk, or an event that says nothing', () => {
		expect(readClaudeRateLimitWindows(null)).toEqual([]);
		expect(readClaudeRateLimitWindows('plain text rate_limit_event not json')).toEqual([]);
		expect(readClaudeRateLimitWindows(event({ status: 'allowed' }))).toEqual([]);
		expect(readClaudeRateLimitWindows(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: 'x' }))).toEqual(
			[]
		);
	});
});

describe('readCodexRateLimitLine (a session record`s token_count)', () => {
	const line = (rateLimits: unknown, timestamp = '2026-11-10T11:30:00.000Z') =>
		JSON.stringify({
			timestamp,
			type: 'event_msg',
			payload: {
				type: 'token_count',
				info: { total_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
				rate_limits: rateLimits
			}
		});

	it('reads the primary and secondary windows by their length', () => {
		expect(
			readCodexRateLimitLine(
				line({
					primary: { used_percent: 12.34, window_minutes: 300, resets_at: 1_794_000_000 },
					secondary: { used_percent: 100, window_minutes: 10_080, resets_at: 1_794_400_000 }
				})
			)
		).toEqual({
			at: '2026-11-10T11:30:00.000Z',
			windows: [
				{
					window: 'five_hour',
					usedPercent: 12.3,
					resetsAt: new Date(1_794_000_000_000).toISOString(),
					windowMinutes: 300
				},
				{
					window: 'weekly',
					usedPercent: 100,
					resetsAt: new Date(1_794_400_000_000).toISOString(),
					limited: true,
					windowMinutes: 10_080
				}
			]
		});
	});

	it('names a window by its slot when its length is not one it knows', () => {
		expect(readCodexRateLimitLine(line({ primary: { used_percent: 10 } }))?.windows).toEqual([
			{ window: 'primary', usedPercent: 10, resetsAt: null }
		]);
		expect(readCodexRateLimitLine(line({ primary: { used_percent: 10, window_minutes: 60 } }))?.windows).toEqual([
			{ window: 'primary', usedPercent: 10, resetsAt: null, windowMinutes: 60 }
		]);
	});

	it('answers null for every other line of a record', () => {
		expect(readCodexRateLimitLine(line(null))).toBeNull();
		expect(readCodexRateLimitLine(line({ primary: {} }))).toBeNull();
		expect(
			readCodexRateLimitLine(
				JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'message',
						content: [{ text: 'token_count rate_limits {"primary":{"used_percent":99}}' }]
					}
				})
			)
		).toBeNull();
		expect(readCodexRateLimitLine('token_count rate_limits not json')).toBeNull();
	});
});

describe('readNewestCodexRateLimits', () => {
	const tokenLine = (used: number) =>
		JSON.stringify({
			timestamp: '2026-11-10T11:30:00.000Z',
			type: 'event_msg',
			payload: {
				type: 'token_count',
				info: {},
				rate_limits: { primary: { used_percent: used, window_minutes: 300 } }
			}
		});

	function memoryFs(files: Record<string, string>, links: string[] = []) {
		const opened: string[] = [];
		const dirs = new Set<string>();
		for (const path of Object.keys(files)) {
			let dir = posix.dirname(path);
			while (dir !== '/' && dir !== '.') {
				dirs.add(dir);
				dir = posix.dirname(dir);
			}
		}
		const kind = (path: string) => ({
			isFile: () => path in files,
			isDirectory: () => dirs.has(path),
			isSymbolicLink: () => links.includes(path)
		});
		const fs: AgentRecordFs = {
			readdir: async (dir) => {
				if (!dirs.has(dir)) throw new Error('ENOENT');
				const names = new Set<string>();
				for (const path of [...Object.keys(files), ...dirs]) {
					if (posix.dirname(path) === dir) names.add(posix.basename(path));
				}
				return [...names].map((name) => ({ name, ...kind(posix.join(dir, name)) }));
			},
			lstat: async (path) => ({ size: Buffer.byteLength(files[path] ?? ''), ...kind(path) }),
			openRead: async (path) => {
				opened.push(path);
				const buffer = Buffer.from(files[path] ?? '');
				return {
					read: async (length, position) => buffer.subarray(position, position + length),
					close: async () => {}
				};
			}
		};
		return { fs, opened };
	}

	it('reads the last snapshot of the newest record, and only that record', async () => {
		const { fs, opened } = memoryFs({
			'/home/u/.codex/sessions/2026/10/31/rollout-2026-10-31T09-00-00-a.jsonl': tokenLine(5),
			'/home/u/.codex/sessions/2026/11/09/rollout-2026-11-09T09-00-00-b.jsonl': tokenLine(40),
			'/home/u/.codex/sessions/2026/11/10/rollout-2026-11-10T08-00-00-c.jsonl': tokenLine(60),
			'/home/u/.codex/sessions/2026/11/10/rollout-2026-11-10T11-00-00-d.jsonl': [
				JSON.stringify({ type: 'session_meta', payload: { id: 's' } }),
				tokenLine(70),
				JSON.stringify({
					type: 'response_item',
					payload: { type: 'message', content: [{ text: 'PROMPT-secret' }] }
				}),
				tokenLine(71)
			].join('\n')
		});
		const reading = await readNewestCodexRateLimits(fs, '/home/u/.codex/sessions', posix.join);
		expect(reading?.windows).toEqual([
			{ window: 'five_hour', usedPercent: 71, resetsAt: null, windowMinutes: 300 }
		]);
		expect(opened).toEqual(['/home/u/.codex/sessions/2026/11/10/rollout-2026-11-10T11-00-00-d.jsonl']);
		expect(JSON.stringify(reading)).not.toContain('PROMPT-secret');
	});

	it('falls back to an older record when the newest holds no snapshot, and never follows a link', async () => {
		const linked = '/home/u/.codex/sessions/2026/11/10/rollout-2026-11-10T12-00-00-link.jsonl';
		const { fs, opened } = memoryFs(
			{
				[linked]: tokenLine(99),
				'/home/u/.codex/sessions/2026/11/10/rollout-2026-11-10T11-00-00-d.jsonl': '{"type":"session_meta"}\n',
				'/home/u/.codex/sessions/2026/11/10/rollout-2026-11-10T08-00-00-c.jsonl': tokenLine(60)
			},
			[linked]
		);
		const reading = await readNewestCodexRateLimits(fs, '/home/u/.codex/sessions', posix.join);
		expect(reading?.windows[0]?.usedPercent).toBe(60);
		expect(opened).not.toContain(linked);
	});

	it('answers null for a missing or empty folder', async () => {
		const { fs } = memoryFs({});
		expect(await readNewestCodexRateLimits(fs, '/home/u/.codex/sessions', posix.join)).toBeNull();
	});
});

describe('AgentRunHistory (what real runs proved)', () => {
	function history(initial?: AgentRunHistoryRecord | null) {
		let clock = NOW;
		const saved: AgentRunHistoryRecord[] = [];
		const runs = new AgentRunHistory({
			now: () => clock,
			timeZone: () => 'UTC',
			initial: initial ?? null,
			persist: (record) => {
				saved.push(JSON.parse(JSON.stringify(record)) as AgentRunHistoryRecord);
			}
		});
		return { runs, saved, advance: (ms: number) => (clock += ms) };
	}

	it('a successful run stamps lastSuccessAt', () => {
		const { runs } = history();
		runs.note({ provider: 'claude-code', status: 'succeeded' });
		expect(runs.get('claude-code')).toEqual(emptyEntry({ lastSuccessAt: ISO }));
	});

	it('classifies the organization switch from the CLI`s own error (prod, 2026-11) — a code, no text', () => {
		const { runs } = history();
		runs.note({ provider: 'claude-code', status: 'failed', cliError: { text: ORG_DISABLED } });
		expect(runs.get('claude-code').failure).toEqual({
			kind: 'access_denied',
			code: 'org_access_disabled',
			window: null,
			resetsAt: null,
			until: null,
			usageLimit: false,
			at: ISO,
			authFingerprint: null
		});
		expect(JSON.stringify(runs.record())).not.toContain('organization');
	});

	it('classifies an expired session, and the API status when the CLI gave no sentence', () => {
		const { runs } = history();
		runs.note({ provider: 'claude-code', status: 'error', cliError: { text: SESSION_EXPIRED } });
		expect(runs.get('claude-code').failure).toMatchObject({ kind: 'not_signed_in', code: 'session_expired' });
		runs.note({ provider: 'codex', status: 'failed', cliError: { apiStatus: 403 } });
		expect(runs.get('codex').failure).toMatchObject({ kind: 'access_denied', code: 'permission_denied' });
	});

	it('a failure with nothing from the CLI`s own channels records no verdict (review S1)', () => {
		// The executor passes ONLY what the CLI authored. A failed run whose
		// assistant text talks about "401 when the user is not logged in", or a
		// Codex agent message about its sandbox, arrives here with no cliError.
		const { runs, saved } = history();
		runs.note({ provider: 'claude-code', status: 'failed', cliError: null, outputTokens: 5321 });
		runs.note({ provider: 'codex', status: 'failed', outputTokens: 900 });
		runs.note({ provider: 'codex', status: 'error', outputTokens: 10 });
		expect(runs.get('claude-code').failure).toBeNull();
		expect(runs.get('codex').failure).toBeNull();
		expect(saved).toEqual([]);
	});

	it('a run that produced model output can never create a sign-in or access verdict (review S1)', () => {
		// Even if such words DID arrive on a CLI channel: the CLI reached its
		// model, so it was signed in and allowed.
		const { runs } = history();
		for (const text of [
			'The handler now returns 401 when the user is not logged in, but two tests still fail.',
			'Not logged in · Please run /login',
			ORG_DISABLED,
			'API Error: 403 permission_error',
			'The test expects "Invalid API key" for a malformed header.',
			'Added a guard: if the session is missing we throw authentication_error.',
			'Failed to authenticate against the staging database, so the migration step failed.',
			'curl printed API Error: 401 from the mock server'
		]) {
			runs.note({ provider: 'claude-code', status: 'failed', cliError: { text }, outputTokens: 5321 });
			expect(runs.get('claude-code').failure).toBeNull();
		}
		runs.note({
			provider: 'codex',
			status: 'failed',
			cliError: {
				text: 'unexpected status 401 Unauthorized',
				apiStatus: 401,
				errorClass: 'authentication_failed'
			},
			outputTokens: 900
		});
		expect(runs.get('codex').failure).toBeNull();
	});

	it('a run that produced model output can still prove a limit — one is hit mid-run', () => {
		const { runs } = history();
		runs.note({
			provider: 'claude-code',
			status: 'failed',
			cliError: { text: "You've hit your weekly limit · resets Nov 12, 3am" },
			outputTokens: 5321
		});
		expect(runs.get('claude-code').failure).toMatchObject({ kind: 'limit_reached', code: 'usage_limit' });
	});

	it('a later success clears the failure; a timeout proves nothing either way', () => {
		const { runs, advance } = history();
		runs.note({ provider: 'claude-code', status: 'failed', cliError: { text: ORG_DISABLED } });
		advance(60_000);
		runs.note({ provider: 'claude-code', status: 'timeout', cliError: { text: 'Not logged in' } });
		expect(runs.get('claude-code').failure?.kind).toBe('access_denied');
		runs.note({ provider: 'claude-code', status: 'succeeded' });
		expect(runs.get('claude-code')).toEqual(emptyEntry({ lastSuccessAt: '2026-11-10T12:01:00.000Z' }));
	});

	it('an unclassified failure changes nothing — unless the run demonstrably reached the model', () => {
		const { runs } = history();
		runs.note({ provider: 'claude-code', status: 'failed', cliError: { text: SESSION_EXPIRED } });
		runs.note({ provider: 'claude-code', status: 'failed', cliError: { text: 'Tests are red.' }, outputTokens: 0 });
		runs.note({ provider: 'claude-code', status: 'failed', cliError: null });
		expect(runs.get('claude-code').failure?.kind).toBe('not_signed_in');
		runs.note({ provider: 'claude-code', status: 'failed', cliError: null, outputTokens: 812 });
		expect(runs.get('claude-code').failure).toBeNull();
		// Not a success: nothing is stamped.
		expect(runs.get('claude-code').lastSuccessAt).toBeNull();
	});

	it('records a usage limit with its window and the instant it lifts', () => {
		const { runs } = history();
		runs.note({
			provider: 'claude-code',
			status: 'failed',
			cliError: { text: "You've hit your weekly limit · resets Nov 12, 3am" }
		});
		expect(runs.get('claude-code').failure).toEqual({
			kind: 'limit_reached',
			code: 'usage_limit',
			window: 'weekly',
			usageLimit: true,
			resetsAt: '2026-11-12T03:00:00.000Z',
			until: '2026-11-12T03:01:00.000Z',
			at: ISO,
			authFingerprint: null
		});
	});

	it('records an empty credit balance as its own code, with no instant: no clock lifts it', () => {
		const { runs } = history();
		runs.note({ provider: 'claude-code', status: 'failed', cliError: { text: 'Credit balance is too low' } });
		expect(runs.get('claude-code').failure).toMatchObject({
			kind: 'limit_reached',
			code: 'out_of_credit',
			usageLimit: false,
			resetsAt: null,
			until: null
		});
	});

	it('keeps the usage windows a run carried, and never replaces a newer reading with an older record', () => {
		const { runs, advance } = history();
		runs.note({
			provider: 'codex',
			status: 'succeeded',
			usage: [{ window: 'five_hour', usedPercent: 30, resetsAt: null }]
		});
		runs.noteUsage('codex', [{ window: 'five_hour', usedPercent: 10, resetsAt: null }], '2026-11-10T11:00:00.000Z');
		expect(runs.get('codex').usage[0]?.usedPercent).toBe(30);
		advance(60_000);
		runs.noteUsage('codex', [{ window: 'five_hour', usedPercent: 55, resetsAt: null }], '2026-11-10T12:00:30.000Z');
		expect(runs.get('codex')).toMatchObject({
			usage: [{ window: 'five_hour', usedPercent: 55, resetsAt: null }],
			usageObservedAt: '2026-11-10T12:00:30.000Z'
		});
	});

	it('a sign-in that CHANGED since the refusal lifts it; the same sign-in does not', () => {
		const { runs } = history();
		runs.observeAuth('claude-code', SIGNED_IN);
		runs.note({ provider: 'claude-code', status: 'failed', cliError: { text: ORG_DISABLED } });
		expect(runs.get('claude-code').failure?.authFingerprint).toBe(agentAuthFingerprint(SIGNED_IN));
		runs.observeAuth('claude-code', SIGNED_IN);
		runs.observeAuth('claude-code', null);
		expect(runs.get('claude-code').failure?.kind).toBe('access_denied');
		// The owner followed the CLI's advice and switched to an API key.
		runs.observeAuth('claude-code', { signedIn: true, method: 'api_key', account: null });
		expect(runs.get('claude-code').failure).toBeNull();
	});

	it('a refusal recorded before any status reading adopts the first one, so a later change is noticed', () => {
		const { runs } = history();
		runs.note({ provider: 'claude-code', status: 'failed', cliError: { text: SESSION_EXPIRED } });
		runs.observeAuth('claude-code', SIGNED_OUT);
		expect(runs.get('claude-code').failure?.authFingerprint).toBe(agentAuthFingerprint(SIGNED_OUT));
		runs.observeAuth('claude-code', SIGNED_IN);
		expect(runs.get('claude-code').failure).toBeNull();
	});

	it('a sign-in change lifts an empty credit balance, and does not lift a usage limit', () => {
		const { runs } = history();
		runs.observeAuth('claude-code', { signedIn: true, method: 'api_key', account: null });
		runs.note({ provider: 'claude-code', status: 'failed', cliError: { text: 'Credit balance is too low' } });
		runs.observeAuth('claude-code', SIGNED_IN);
		expect(runs.get('claude-code').failure).toBeNull();

		runs.note({
			provider: 'claude-code',
			status: 'failed',
			cliError: { text: '5-hour limit reached ∙ resets 3pm' }
		});
		runs.observeAuth('claude-code', { signedIn: true, method: 'api_key', account: null });
		expect(runs.get('claude-code').failure).toMatchObject({ kind: 'limit_reached', window: 'session' });
	});

	describe('observeThrottle — the worker`s throttle and a recorded usage limit (review N3)', () => {
		const limited = () => {
			const made = history();
			made.runs.note({
				provider: 'claude-code',
				status: 'failed',
				cliError: { text: "You've hit your weekly limit · resets Nov 12, 3am" }
			});
			return made;
		};

		it('marks a limit the worker took over, once', async () => {
			const { runs, saved } = limited();
			runs.observeThrottle('claude-code', true, true);
			runs.observeThrottle('claude-code', true, true);
			await runs.settled();
			expect(runs.get('claude-code').failure).toMatchObject({ usageLimit: true, throttled: true });
			// The limit itself, then the mark: two writes, not three.
			expect(saved).toHaveLength(2);
		});

		it('drops a limit the worker HAD taken over as soon as it no longer holds it ("Clear limit now")', () => {
			const { runs } = limited();
			runs.observeThrottle('claude-code', true, true);
			runs.observeThrottle('claude-code', false, true);
			expect(runs.get('claude-code').failure).toBeNull();
		});

		it('leaves a limit the worker never throttled on, and one on a node without a worker', () => {
			const { runs } = limited();
			runs.observeThrottle('claude-code', false, true);
			runs.observeThrottle('claude-code', false, false);
			expect(runs.get('claude-code').failure).toMatchObject({ usageLimit: true });
			expect(runs.get('claude-code').failure).not.toHaveProperty('throttled');
		});

		it('never touches a refusal that is not a usage limit', () => {
			const { runs } = history();
			runs.note({ provider: 'claude-code', status: 'failed', cliError: { text: ORG_DISABLED } });
			runs.observeThrottle('claude-code', true, true);
			runs.observeThrottle('claude-code', false, true);
			expect(runs.get('claude-code').failure).toMatchObject({ kind: 'access_denied' });
			expect(runs.get('claude-code').failure).not.toHaveProperty('throttled');
		});

		it('survives a restart: the mark is persisted with the limit', () => {
			const { runs } = limited();
			runs.observeThrottle('claude-code', true, true);
			const restored = parseAgentRunHistoryRecord(JSON.stringify(runs.record()));
			expect(restored?.agents['claude-code']?.failure).toMatchObject({ usageLimit: true, throttled: true });
		});
	});

	it('persists every change in order, and a restart restores it', async () => {
		const first = history();
		first.runs.note({ provider: 'claude-code', status: 'succeeded' });
		first.advance(1000);
		first.runs.note({ provider: 'claude-code', status: 'failed', cliError: { text: ORG_DISABLED } });
		await first.runs.settled();
		expect(first.saved).toHaveLength(2);
		const stored = parseAgentRunHistoryRecord(JSON.stringify(first.saved.at(-1)));
		expect(stored?.agents['claude-code']).toMatchObject({
			lastSuccessAt: ISO,
			failure: { kind: 'access_denied', code: 'org_access_disabled' }
		});

		const restarted = history(stored);
		expect(restarted.runs.get('claude-code').failure?.kind).toBe('access_denied');
		expect(restarted.runs.get('claude-code').lastSuccessAt).toBe(ISO);
	});

	it('the persisted record holds no line of run output — a secret in an error never reaches the disk', async () => {
		const { runs, saved } = history();
		const dbUrl = `postgres://app:${'hunter2'}${'Sup3rS3cret'}@db.internal:5432/prod`;
		const basic = `Authorization: Basic ${Buffer.from('user:passw0rd-example').toString('base64')}`;
		runs.note({
			provider: 'claude-code',
			status: 'failed',
			cliError: { text: `Invalid API key ${FAKE_API_KEY} · Fix external API key\n${dbUrl}\n${basic}` }
		});
		await runs.settled();
		const written = JSON.stringify(saved);
		expect(runs.get('claude-code').failure).toMatchObject({ kind: 'not_signed_in', code: 'invalid_api_key' });
		for (const leaked of ['FAKE', 'hunter2', 'db.internal', 'Basic', 'Invalid API key', 'Fix external']) {
			expect(written).not.toContain(leaked);
		}
	});

	it('a failing persist is logged and never wedges the next write', async () => {
		const warnings: string[] = [];
		let calls = 0;
		const runs = new AgentRunHistory({
			now: () => NOW,
			persist: () => {
				calls += 1;
				if (calls === 1) throw new Error('disk full');
			},
			logger: { warn: (message: string) => void warnings.push(message) }
		});
		runs.note({ provider: 'codex', status: 'succeeded' });
		runs.note({ provider: 'codex', status: 'failed', cliError: { text: 'Not logged in' } });
		await runs.settled();
		expect(calls).toBe(2);
		expect(warnings).toEqual(['Could not record agent readiness: disk full']);
	});
});

describe('parseAgentRunHistoryRecord', () => {
	it('reads as "no record" anything that is not one', () => {
		for (const raw of [null, '', 'not json', '[]', '{"version":2,"agents":{}}', '{"version":1,"agents":[]}']) {
			expect(parseAgentRunHistoryRecord(raw)).toBeNull();
		}
	});

	it('keeps only what a fresh reading could hold — a hand-edited file cannot widen the wire', () => {
		const record = parseAgentRunHistoryRecord(
			JSON.stringify({
				version: 1,
				recordedAt: ISO,
				agents: {
					'claude-code': {
						lastSuccessAt: 'yesterday',
						failure: { kind: 'on_fire', code: 'org_access_disabled', at: ISO },
						usage: [
							{ window: 'five_hour', usedPercent: 500 },
							{ window: 'weekly', usedPercent: 5 }
						],
						usageObservedAt: ISO,
						secret: FAKE_TOKEN
					},
					'bad provider!': { lastSuccessAt: ISO }
				}
			})
		);
		expect(record?.agents).toEqual({
			'claude-code': {
				lastSuccessAt: null,
				failure: null,
				usage: [{ window: 'weekly', usedPercent: 5, resetsAt: null }],
				usageObservedAt: ISO
			}
		});
	});

	it('a failure is a kind, a KNOWN code and an instant — free text is never read back', () => {
		const parse = (stored: Record<string, unknown>) =>
			parseAgentRunHistoryRecord(
				JSON.stringify({ version: 1, recordedAt: ISO, agents: { 'claude-code': { failure: stored } } })
			)?.agents['claude-code']?.failure;

		expect(
			parse({
				kind: 'limit_reached',
				code: 'usage_limit',
				window: 'weekly',
				resetsAt: '2026-11-12T03:00:00.000Z',
				until: '2026-11-12T03:01:00.000Z',
				usageLimit: true,
				at: ISO,
				authFingerprint: 'in|subscription|',
				reason: 'a sentence somebody typed into the file'
			})
		).toEqual({
			kind: 'limit_reached',
			code: 'usage_limit',
			window: 'weekly',
			resetsAt: '2026-11-12T03:00:00.000Z',
			until: '2026-11-12T03:01:00.000Z',
			usageLimit: true,
			at: ISO,
			authFingerprint: 'in|subscription|'
		});
		// What the build before this one wrote: a sentence out of a run, and no code.
		expect(parse({ kind: 'access_denied', reason: ORG_DISABLED, at: ISO, usageLimit: false })).toBeNull();
		expect(parse({ kind: 'access_denied', code: 'made_up_code', at: ISO })).toBeNull();
		expect(parse({ kind: 'access_denied', code: 'org_access_disabled' })).toBeNull();
		expect(parse({ kind: 'access_denied', code: 'org_access_disabled', at: ISO, window: 'forever' })).toMatchObject(
			{ window: null }
		);
	});

	it('sits beside the config', () => {
		expect(agentRunHistoryPath('/etc/ever-works/node-config.json')).toBe(
			'/etc/ever-works/node-config.json.agent-readiness.json'
		);
	});
});

describe('resolveAgentStatus', () => {
	const base = { installed: true, auth: answered(SIGNED_IN), history: emptyEntry(), nowMs: NOW };

	it('signed in and nothing against it → ready', () => {
		expect(resolveAgentStatus(base)).toEqual({ status: 'ready', reasonCode: null });
	});

	it('not installed → not_installed; a startup lookup that timed out → unknown, with why', () => {
		expect(resolveAgentStatus({ ...base, installed: false })).toEqual({
			status: 'not_installed',
			reasonCode: null
		});
		expect(resolveAgentStatus({ ...base, installed: false, probeTimedOut: true })).toEqual({
			status: 'unknown',
			reasonCode: 'probe_timed_out'
		});
	});

	it('a binary this node cannot start → unsupported', () => {
		expect(resolveAgentStatus({ ...base, missingRequiredFlags: ['--output-format'] })).toEqual({
			status: 'unsupported',
			reasonCode: 'cli_too_old'
		});
	});

	it('"signed in" does not outrank what the last run proved (the production case)', () => {
		const refused = failure({ authFingerprint: agentAuthFingerprint(SIGNED_IN) });
		expect(resolveAgentStatus({ ...base, history: emptyEntry({ failure: refused }) })).toEqual({
			status: 'access_denied',
			reasonCode: 'org_access_disabled'
		});
	});

	it('a refusal a run proved stands for 24 h, then is unknown — not red for ever, never ready (review S2)', () => {
		expect(FLEET_AGENT_VERDICT_MAX_AGE_MS).toBe(DAY);
		// The owner signed in again with the SAME account: the fingerprint did
		// not change, so only a run — or time — can retire the verdict.
		const expired = failure({
			kind: 'not_signed_in',
			code: 'session_expired',
			authFingerprint: agentAuthFingerprint(SIGNED_IN)
		});
		const history = emptyEntry({ failure: expired });
		expect(resolveAgentStatus({ ...base, history, nowMs: NOW + DAY })).toEqual({
			status: 'not_signed_in',
			reasonCode: 'session_expired'
		});
		for (const later of [NOW + DAY + 1, NOW + 30 * DAY]) {
			expect(resolveAgentStatus({ ...base, history, nowMs: later, throttlesKnown: true })).toEqual({
				status: 'unknown',
				reasonCode: 'verdict_stale'
			});
		}
		// An old success does not outvote the refusal that came after it.
		const withOldSuccess = emptyEntry({ failure: expired, lastSuccessAt: '2026-11-10T11:00:00.000Z' });
		expect(resolveAgentStatus({ ...base, history: withOldSuccess, nowMs: NOW + 2 * DAY }).status).toBe('unknown');
	});

	it('an unreadable failure instant is not treated as fresh', () => {
		const history = emptyEntry({ failure: failure({ at: 'not a date' }) });
		expect(resolveAgentStatus({ ...base, history })).toEqual({ status: 'unknown', reasonCode: 'verdict_stale' });
	});

	it('the worker`s throttle → limit_reached until its instant, naming the window', () => {
		expect(
			resolveAgentStatus({
				...base,
				throttle: { provider: 'claude-code', until: '2026-11-12T03:01:00.000Z', window: 'weekly' },
				throttlesKnown: true
			})
		).toEqual({
			status: 'limit_reached',
			reasonCode: 'usage_limit',
			limitResetsAt: '2026-11-12T03:01:00.000Z',
			limitWindow: 'weekly'
		});
	});

	const usageLimit = failure({
		kind: 'limit_reached',
		code: 'usage_limit',
		window: 'weekly',
		resetsAt: '2026-11-12T03:00:00.000Z',
		until: '2026-11-12T03:01:00.000Z',
		usageLimit: true
	});

	it('a usage limit that named its reset stands until then on a node without a worker, then ready', () => {
		const history = emptyEntry({ failure: usageLimit });
		expect(resolveAgentStatus({ ...base, history })).toEqual({
			status: 'limit_reached',
			reasonCode: 'usage_limit',
			limitResetsAt: '2026-11-12T03:00:00.000Z',
			limitWindow: 'weekly'
		});
		// The reset the CLI named has passed: that IS the evidence.
		expect(resolveAgentStatus({ ...base, history, nowMs: Date.parse('2026-11-12T03:02:00.000Z') })).toEqual({
			status: 'ready',
			reasonCode: null
		});
	});

	it('a usage limit the worker took over and no longer holds was lifted ("Clear limit now") → ready at once', () => {
		expect(
			resolveAgentStatus({
				...base,
				history: emptyEntry({ failure: { ...usageLimit, throttled: true } }),
				throttle: null,
				throttlesKnown: true
			})
		).toEqual({ status: 'ready', reasonCode: null });
	});

	describe('a usage limit that named NO reset (a bare 429) — review N3', () => {
		const noReset = failure({
			kind: 'limit_reached',
			code: 'usage_limit',
			window: 'rate',
			resetsAt: null,
			until: new Date(NOW + FLEET_AGENT_FAILURE_FALLBACK_MS).toISOString(),
			usageLimit: true
		});
		const history = emptyEntry({ failure: noReset });
		const held = {
			status: 'limit_reached',
			reasonCode: 'usage_limit',
			limitResetsAt: noReset.until,
			limitWindow: 'rate'
		};

		it('reads limit_reached for the whole hold — with a worker that never throttled on it, too', () => {
			// It used to read `ready` here on a node with a worker: "no throttle"
			// was taken for "lifted", when the worker had simply never held one.
			for (const throttlesKnown of [false, true]) {
				for (const minutes of [0, 5, 59]) {
					expect(
						resolveAgentStatus({
							...base,
							history,
							throttle: null,
							throttlesKnown,
							nowMs: NOW + minutes * 60_000
						})
					).toEqual(held);
				}
			}
		});

		it('then goes back to what the sign-in says: a rate limit leaves no lasting negative', () => {
			// It used to read `unknown — the last run was refused` from minute 61
			// until a run succeeded.
			for (const throttlesKnown of [false, true]) {
				for (const later of [NOW + 61 * 60_000, NOW + 10 * DAY]) {
					const after = { ...base, history, throttle: null, throttlesKnown, nowMs: later };
					expect(resolveAgentStatus(after)).toEqual({ status: 'ready', reasonCode: null });
					expect(resolveAgentStatus({ ...after, auth: answered(SIGNED_OUT) })).toEqual({
						status: 'not_signed_in',
						reasonCode: 'status_signed_out'
					});
					expect(resolveAgentStatus({ ...after, auth: { state: 'unanswered' } })).toEqual({
						status: 'unknown',
						reasonCode: 'status_unanswered'
					});
				}
			}
		});

		it('"Clear limit now" ends it immediately, for a limit the worker had taken over', () => {
			expect(
				resolveAgentStatus({
					...base,
					history: emptyEntry({ failure: { ...noReset, throttled: true } }),
					throttle: null,
					throttlesKnown: true,
					nowMs: NOW + 5 * 60_000
				})
			).toEqual({ status: 'ready', reasonCode: null });
		});

		it('is what a 429 creates — also from a run that reached its model', () => {
			const runs = new AgentRunHistory({ now: () => NOW });
			runs.note({ provider: 'claude-code', status: 'failed', cliError: { apiStatus: 429 }, outputTokens: 812 });
			expect(runs.get('claude-code').failure).toMatchObject({
				kind: 'limit_reached',
				code: 'usage_limit',
				window: 'rate',
				resetsAt: null,
				until: noReset.until,
				usageLimit: true
			});
			runs.note({
				provider: 'codex',
				status: 'failed',
				cliError: { errorClass: 'rate_limit', text: 'API Error: 429 rate_limit_error' },
				outputTokens: 0
			});
			expect(runs.get('codex').failure).toMatchObject({ code: 'usage_limit', usageLimit: true });
		});
	});

	it('"credit balance too low" never flips back to ready by the clock: after its hour it is unknown (review 6a)', () => {
		expect(FLEET_AGENT_FAILURE_FALLBACK_MS).toBe(HOUR);
		const credit = failure({ kind: 'limit_reached', code: 'out_of_credit' });
		const history = emptyEntry({ failure: credit });
		// Not the worker's throttle: it stands with or without a worker.
		for (const throttlesKnown of [false, true]) {
			expect(resolveAgentStatus({ ...base, history, throttle: null, throttlesKnown, nowMs: NOW + HOUR })).toEqual(
				{
					status: 'limit_reached',
					reasonCode: 'out_of_credit'
				}
			);
			for (const later of [NOW + HOUR + 1, NOW + 3 * HOUR, NOW + 30 * DAY]) {
				expect(resolveAgentStatus({ ...base, history, throttle: null, throttlesKnown, nowMs: later })).toEqual({
					status: 'unknown',
					reasonCode: 'verdict_stale'
				});
			}
		}
	});

	it('signed out → not_signed_in, unless a run succeeded recently (a per-run credential)', () => {
		expect(resolveAgentStatus({ ...base, auth: answered(SIGNED_OUT) })).toEqual({
			status: 'not_signed_in',
			reasonCode: 'status_signed_out'
		});
		const recent = emptyEntry({ lastSuccessAt: new Date(NOW - AGENT_SUCCESS_TRUST_MS + 1000).toISOString() });
		expect(resolveAgentStatus({ ...base, auth: answered(SIGNED_OUT), history: recent }).status).toBe('ready');
		const stale = emptyEntry({ lastSuccessAt: new Date(NOW - AGENT_SUCCESS_TRUST_MS - 1000).toISOString() });
		expect(resolveAgentStatus({ ...base, auth: answered(SIGNED_OUT), history: stale }).status).toBe(
			'not_signed_in'
		);
	});

	it('no status reading and no recent success → unknown with why, never ready', () => {
		expect(resolveAgentStatus({ ...base, auth: null })).toEqual({
			status: 'unknown',
			reasonCode: 'status_unanswered'
		});
		expect(resolveAgentStatus({ ...base, auth: { state: 'unanswered' } })).toEqual({
			status: 'unknown',
			reasonCode: 'status_unanswered'
		});
		expect(resolveAgentStatus({ ...base, auth: { state: 'unavailable' } })).toEqual({
			status: 'unknown',
			reasonCode: 'status_unavailable'
		});
		expect(
			resolveAgentStatus({ ...base, auth: answered({ signedIn: null, method: 'unknown', account: null }) })
		).toEqual({ status: 'unknown', reasonCode: 'status_unanswered' });
		// A CLI that cannot report its sign-in but ran a Task an hour ago is ready.
		const recent = emptyEntry({ lastSuccessAt: new Date(NOW - HOUR).toISOString() });
		expect(resolveAgentStatus({ ...base, auth: { state: 'unavailable' }, history: recent }).status).toBe('ready');
	});
});

describe('buildAgentReadinessReport', () => {
	const drivable = [
		{ provider: 'claude-code', executable: '/opt/claude', version: '2.1.319' },
		{ provider: 'codex', executable: null, version: null }
	];

	it('lists every CLI the node can drive, installed or not, and the ones it only sees', async () => {
		const runs = new AgentRunHistory({ now: () => NOW });
		runs.note({
			provider: 'claude-code',
			status: 'succeeded',
			usage: [{ window: 'five_hour', usedPercent: 42, resetsAt: '2026-11-10T15:00:00.000Z' }]
		});
		const report = await buildAgentReadinessReport({
			drivable: () => drivable,
			auth: async () => answered(SIGNED_IN),
			unsupported: async () => [{ provider: 'gemini', version: '0.9.1' }],
			history: runs,
			now: () => NOW
		});
		expect(report).toEqual({
			checkedAt: ISO,
			agents: [
				{
					provider: 'claude-code',
					installed: true,
					version: '2.1.319',
					signedIn: true,
					authMethod: 'subscription',
					account: 'owner@example.com (Acme, max)',
					status: 'ready',
					reasonCode: null,
					reason: null,
					checkedAt: ISO,
					usage: [{ window: 'five_hour', usedPercent: 42, resetsAt: '2026-11-10T15:00:00.000Z' }],
					usageObservedAt: ISO,
					lastSuccessAt: ISO
				},
				{
					provider: 'codex',
					installed: false,
					version: null,
					signedIn: null,
					authMethod: 'unknown',
					account: null,
					status: 'not_installed',
					reasonCode: null,
					reason: null,
					checkedAt: ISO
				},
				{
					provider: 'gemini',
					installed: true,
					version: '0.9.1',
					signedIn: null,
					authMethod: 'unknown',
					account: null,
					status: 'unsupported',
					reasonCode: 'no_executor',
					reason: 'This node version cannot run agent work with this CLI.',
					checkedAt: ISO
				}
			]
		});
	});

	it('online, CLI installed, signed in — and not ready: the run that was refused decides', async () => {
		const runs = new AgentRunHistory({ now: () => NOW });
		runs.note({ provider: 'claude-code', status: 'failed', cliError: { text: ORG_DISABLED } });
		const report = await buildAgentReadinessReport({
			drivable: () => drivable,
			auth: async () => answered(SIGNED_IN),
			history: runs,
			throttles: () => [],
			now: () => NOW
		});
		expect(report.agents[0]).toMatchObject({
			installed: true,
			signedIn: true,
			status: 'access_denied',
			reasonCode: 'org_access_disabled',
			reason: describeFleetAgentReason('org_access_disabled'),
			lastFailureAt: ISO,
			lastFailureKind: 'access_denied',
			lastFailureCode: 'org_access_disabled'
		});
		expect(report.agents.some((agent) => agent.status === 'ready')).toBe(false);
	});

	it('the reason is a fixed sentence: no word of the run`s output is in the report (review item 2)', async () => {
		const runs = new AgentRunHistory({ now: () => NOW });
		const dbUrl = `postgres://app:${'hunter2'}${'Sup3rS3cret'}@db.internal:5432/prod`;
		runs.note({
			provider: 'claude-code',
			status: 'failed',
			cliError: { text: `Invalid API key ${FAKE_API_KEY} · Fix external API key (${dbUrl})` }
		});
		const report = await buildAgentReadinessReport({
			drivable: () => drivable,
			auth: async () => answered({ signedIn: true, method: 'api_key', account: null }),
			history: runs,
			now: () => NOW
		});
		expect(report.agents[0]).toMatchObject({
			status: 'not_signed_in',
			reasonCode: 'invalid_api_key',
			reason: 'The API key was rejected. Replace it on this computer.'
		});
		const wire = JSON.stringify(report);
		for (const leaked of ['FAKE', 'hunter2', 'db.internal', 'Fix external']) expect(wire).not.toContain(leaked);
	});

	it('a bare 429 on a node with a worker: limit reached for the hold, cleared by the owner, never a lasting negative (review N3)', async () => {
		const runs = new AgentRunHistory({ now: () => NOW });
		runs.note({ provider: 'claude-code', status: 'failed', cliError: { apiStatus: 429 }, outputTokens: 0 });
		let throttles: Array<{ provider: string; until: string; window?: 'rate' }> = [];
		const at = async (nowMs: number) =>
			(
				await buildAgentReadinessReport({
					drivable: () => drivable,
					auth: async () => answered(SIGNED_IN),
					history: runs,
					throttles: () => throttles,
					now: () => nowMs
				})
			).agents[0];

		// The worker holds no throttle for it (the executor did not park the job): still limit reached.
		expect(await at(NOW + 5 * 60_000)).toMatchObject({
			status: 'limit_reached',
			reasonCode: 'usage_limit',
			reason: 'The rate limit is reached.',
			limitWindow: 'rate'
		});
		// Past the hold: back to the sign-in, with nothing left behind.
		expect(await at(NOW + 61 * 60_000)).toMatchObject({ status: 'ready', reasonCode: null, reason: null });

		// The same limit, this time taken over by the worker, then cleared by the owner.
		runs.note({ provider: 'claude-code', status: 'failed', cliError: { apiStatus: 429 }, outputTokens: 0 });
		throttles = [{ provider: 'claude-code', until: new Date(NOW + HOUR).toISOString(), window: 'rate' }];
		expect((await at(NOW + 60_000))?.status).toBe('limit_reached');
		throttles = [];
		expect(await at(NOW + 2 * 60_000)).toMatchObject({ status: 'ready', reasonCode: null });
		expect(runs.get('claude-code').failure).toBeNull();
	});

	it('an aged refusal reads unknown and keeps the last failure beside it (review 6b)', async () => {
		const runs = new AgentRunHistory({ now: () => NOW });
		runs.observeAuth('claude-code', SIGNED_IN);
		runs.note({ provider: 'claude-code', status: 'failed', cliError: { text: SESSION_EXPIRED } });
		const report = await buildAgentReadinessReport({
			drivable: () => drivable,
			auth: async () => answered(SIGNED_IN),
			history: runs,
			now: () => NOW + 3 * DAY
		});
		expect(report.agents[0]).toMatchObject({
			status: 'unknown',
			reasonCode: 'verdict_stale',
			reason: 'The last run was refused and none has run since, so the current state is not known.',
			lastFailureAt: ISO,
			lastFailureKind: 'not_signed_in',
			lastFailureCode: 'session_expired'
		});
	});

	it('a startup lookup that timed out is unknown, not "not installed" (review S5)', async () => {
		const report = await buildAgentReadinessReport({
			drivable: () => [
				{ provider: 'claude-code', executable: null, version: null, probeTimedOut: true },
				{ provider: 'codex', executable: null, version: null, probeTimedOut: true }
			],
			auth: async () => ({ state: 'unanswered' }),
			history: new AgentRunHistory({ now: () => NOW }),
			now: () => NOW
		});
		expect(report.agents).toHaveLength(2);
		for (const agent of report.agents) {
			expect(agent).toMatchObject({
				installed: null,
				status: 'unknown',
				reasonCode: 'probe_timed_out',
				reason: describeFleetAgentReason('probe_timed_out')
			});
		}
	});

	it('a status command that did not answer, with the last success 3 days old, is unknown (review S5)', async () => {
		const report = await buildAgentReadinessReport({
			drivable: () => [{ provider: 'claude-code', executable: '/opt/claude', version: '2.0.1' }],
			auth: async () => ({ state: 'unanswered' }),
			history: new AgentRunHistory({
				now: () => NOW,
				initial: {
					version: 1,
					recordedAt: '2026-11-07T12:00:00.000Z',
					agents: {
						'claude-code': emptyEntry({ lastSuccessAt: '2026-11-07T12:00:00.000Z' })
					}
				}
			}),
			now: () => NOW
		});
		expect(report.agents[0]).toMatchObject({
			installed: true,
			signedIn: null,
			status: 'unknown',
			reasonCode: 'status_unanswered',
			lastSuccessAt: '2026-11-07T12:00:00.000Z'
		});
	});

	it('never asks a CLI that is not installed, and a status command that throws is that CLI`s unknown', async () => {
		const asked: string[] = [];
		const report = await buildAgentReadinessReport({
			drivable: () => drivable,
			auth: async (provider) => {
				asked.push(provider);
				throw new Error('spawn EPERM');
			},
			unsupported: async () => {
				throw new Error('probe bug');
			},
			history: new AgentRunHistory({ now: () => NOW }),
			now: () => NOW
		});
		expect(asked).toEqual(['claude-code']);
		expect(report.agents.map((agent) => agent.status)).toEqual(['unknown', 'not_installed']);
	});

	it('drops usage windows whose reset has passed', async () => {
		const runs = new AgentRunHistory({ now: () => NOW });
		runs.note({
			provider: 'claude-code',
			status: 'succeeded',
			usage: [
				{ window: 'five_hour', usedPercent: 90, resetsAt: '2026-11-10T11:00:00.000Z' },
				{ window: 'weekly', usedPercent: 20, resetsAt: '2026-11-14T00:00:00.000Z' }
			]
		});
		const report = await buildAgentReadinessReport({
			drivable: () => drivable,
			auth: async () => answered(SIGNED_IN),
			history: runs,
			now: () => NOW
		});
		expect(report.agents[0]?.usage).toEqual([
			{ window: 'weekly', usedPercent: 20, resetsAt: '2026-11-14T00:00:00.000Z' }
		]);
	});

	it('a window with no reset time expires after its own length (review item 8)', async () => {
		const runs = new AgentRunHistory({ now: () => NOW });
		runs.note({
			provider: 'claude-code',
			status: 'succeeded',
			usage: [
				{ window: 'five_hour', usedPercent: 90, resetsAt: null, windowMinutes: 300 },
				{ window: 'weekly', usedPercent: 20, resetsAt: null, windowMinutes: 10_080 }
			]
		});
		const at = async (nowMs: number) =>
			(
				await buildAgentReadinessReport({
					drivable: () => drivable,
					auth: async () => answered(SIGNED_IN),
					history: runs,
					now: () => nowMs
				})
			).agents[0];
		expect((await at(NOW + 4 * HOUR))?.usage?.map((window) => window.window)).toEqual(['five_hour', 'weekly']);
		const later = await at(NOW + 6 * HOUR);
		expect(later?.usage).toEqual([{ window: 'weekly', usedPercent: 20, resetsAt: null, windowMinutes: 10_080 }]);
		// The age the popup shows the bars with.
		expect(later?.usageObservedAt).toBe(ISO);
		const muchLater = await at(NOW + 8 * DAY);
		expect(muchLater?.usage).toBeUndefined();
		expect(muchLater?.usageObservedAt).toBeUndefined();
	});
});
