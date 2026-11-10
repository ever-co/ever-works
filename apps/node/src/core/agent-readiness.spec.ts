import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	AGENT_SUCCESS_TRUST_MS,
	AgentRunHistory,
	agentAuthFingerprint,
	agentRunHistoryPath,
	buildAgentReadinessReport,
	detectUnsupportedAgentClis,
	parseAgentRunHistoryRecord,
	probeAgentAuth,
	readClaudeAuthStatus,
	readClaudeRateLimitWindows,
	readCodexLoginStatus,
	readCodexRateLimitLine,
	readNewestCodexRateLimits,
	resolveAgentStatus,
	type AgentAuthReading,
	type AgentRecordFs,
	type AgentRunHistoryEntry,
	type AgentRunHistoryRecord
} from './agent-readiness';
import type { CommandRunner } from './capabilities';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
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

function emptyEntry(overrides: Partial<AgentRunHistoryEntry> = {}): AgentRunHistoryEntry {
	return { lastSuccessAt: null, failure: null, usage: [], usageObservedAt: null, ...overrides };
}

/** A runner that answers from a table keyed by `"<command> <args>"`, recording every call. */
function tableRunner(table: Record<string, { code?: number | null; stdout?: string; stderr?: string } | Error>) {
	const calls: string[] = [];
	const runner: CommandRunner = {
		run: async (command, args) => {
			const key = `${command} ${args.join(' ')}`;
			calls.push(key);
			const answer = table[key];
			if (answer instanceof Error) throw answer;
			if (!answer) return { code: 127, stdout: '', stderr: 'not found' };
			return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
		}
	};
	return { runner, calls };
}

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
				accessToken: 'sk-ant-oat01-must-never-leave',
				configDirectory: '/home/owner/.claude'
			})
		);
		expect(JSON.stringify(reading)).not.toContain('must-never-leave');
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
		['API key configured - sk-proj-***ABCDE', true, 'api_key'],
		['Logged in using an API key - sk-proj-***ABCDE', true, 'api_key'],
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
		expect(JSON.stringify(readCodexLoginStatus('API key configured - sk-proj-***ABCDE'))).not.toContain('sk-proj');
	});

	it('answers null when the output says neither', () => {
		expect(readCodexLoginStatus('')).toBeNull();
		expect(readCodexLoginStatus('error: unrecognized subcommand')).toBeNull();
	});
});

describe('probeAgentAuth', () => {
	it('asks the pinned binary its own free status command, never a model', async () => {
		const { runner, calls } = tableRunner({
			'/opt/claude auth status --json': { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) },
			// Codex prints to stderr and exits 1 when signed out.
			'/opt/codex login status': { code: 1, stderr: 'Not logged in\n' }
		});
		expect(await probeAgentAuth(runner, 'claude-code', '/opt/claude')).toEqual({
			signedIn: true,
			method: 'subscription',
			account: null
		});
		expect(await probeAgentAuth(runner, 'codex', '/opt/codex')).toEqual(SIGNED_OUT);
		expect(calls).toEqual(['/opt/claude auth status --json', '/opt/codex login status']);
		// No prompt flag ever reaches a CLI from here.
		expect(calls.join(' ')).not.toMatch(/(^| )(-p|--print|exec)( |$)/);
	});

	it('reads a signed-out Claude document even though the command exits 1', async () => {
		const { runner } = tableRunner({
			'claude auth status --json': { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }) }
		});
		expect(await probeAgentAuth(runner, 'claude-code', 'claude')).toEqual(SIGNED_OUT);
	});

	it('answers null — "could not tell" — when the command fails, times out or is not a known CLI', async () => {
		const { runner } = tableRunner({ 'claude auth status --json': new Error('spawn ENOENT') });
		expect(await probeAgentAuth(runner, 'claude-code', 'claude')).toBeNull();
		expect(await probeAgentAuth(runner, 'gemini', 'gemini')).toBeNull();
		const timedOut: CommandRunner = { run: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }) };
		expect(await probeAgentAuth(timedOut, 'codex', 'codex')).toBeNull();
	});
});

describe('detectUnsupportedAgentClis', () => {
	it('lists the CLIs that answer --version and skips the rest', async () => {
		const { runner } = tableRunner({
			'gemini --version': { stdout: '0.9.1\n' },
			'opencode --version': new Error('spawn ENOENT')
		});
		expect(await detectUnsupportedAgentClis(runner)).toEqual([{ provider: 'gemini', version: '0.9.1' }]);
	});
});

describe('readClaudeRateLimitWindows (a real run`s own stream)', () => {
	const event = (info: Record<string, unknown>) =>
		JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'u', session_id: 's' });

	it('reads utilisation and reset per window, newest event per window', () => {
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
			{ window: 'five_hour', usedPercent: 82.5, resetsAt: new Date(1_794_000_000_000).toISOString() },
			{ window: 'weekly', usedPercent: 40, resetsAt: new Date(1_794_400_000_000).toISOString() }
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
				limited: true
			},
			{ window: 'five_hour', usedPercent: null, resetsAt: new Date(1_794_000_000_000).toISOString() }
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
				{ window: 'five_hour', usedPercent: 12.3, resetsAt: new Date(1_794_000_000_000).toISOString() },
				{
					window: 'weekly',
					usedPercent: 100,
					resetsAt: new Date(1_794_400_000_000).toISOString(),
					limited: true
				}
			]
		});
	});

	it('names a window by its slot when its length is not one it knows', () => {
		expect(readCodexRateLimitLine(line({ primary: { used_percent: 10 } }))?.windows).toEqual([
			{ window: 'primary', usedPercent: 10, resetsAt: null }
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
		expect(reading?.windows).toEqual([{ window: 'five_hour', usedPercent: 71, resetsAt: null }]);
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
		runs.note({ provider: 'claude-code', status: 'succeeded', summary: 'Done.' });
		expect(runs.get('claude-code')).toEqual(emptyEntry({ lastSuccessAt: ISO }));
	});

	it('classifies the organization switch from the CLI`s final message (prod, 2026-11)', () => {
		const { runs } = history();
		runs.note({ provider: 'claude-code', status: 'failed', summary: ORG_DISABLED });
		expect(runs.get('claude-code').failure).toEqual({
			kind: 'access_denied',
			reason: ORG_DISABLED,
			resetsAt: null,
			until: null,
			usageLimit: false,
			at: ISO,
			authFingerprint: null
		});
	});

	it('classifies an expired session from the output tail when there is no final message', () => {
		const { runs } = history();
		runs.note({ provider: 'claude-code', status: 'error', summary: null, outputTail: `\n${SESSION_EXPIRED}\n` });
		expect(runs.get('claude-code').failure).toMatchObject({ kind: 'not_signed_in', reason: SESSION_EXPIRED });
	});

	it('reads the output tail strictly — the model`s own words never sign the CLI out', () => {
		const { runs } = history();
		runs.note({
			provider: 'claude-code',
			status: 'failed',
			summary: null,
			outputTail: 'The deploy user does not have access to the bucket, so the upload step failed.'
		});
		expect(runs.get('claude-code').failure).toBeNull();
	});

	it('a later success clears the failure; a timeout proves nothing either way', () => {
		const { runs, advance } = history();
		runs.note({ provider: 'claude-code', status: 'failed', summary: ORG_DISABLED });
		advance(60_000);
		runs.note({ provider: 'claude-code', status: 'timeout', summary: null });
		expect(runs.get('claude-code').failure?.kind).toBe('access_denied');
		runs.note({ provider: 'claude-code', status: 'succeeded', summary: 'Done.' });
		expect(runs.get('claude-code')).toEqual(emptyEntry({ lastSuccessAt: '2026-11-10T12:01:00.000Z' }));
	});

	it('an unclassified failure changes nothing — unless the run demonstrably reached the model', () => {
		const { runs } = history();
		runs.note({ provider: 'claude-code', status: 'failed', summary: SESSION_EXPIRED });
		runs.note({ provider: 'claude-code', status: 'failed', summary: 'Tests are red.', outputTokens: 0 });
		expect(runs.get('claude-code').failure?.kind).toBe('not_signed_in');
		runs.note({ provider: 'claude-code', status: 'failed', summary: 'Tests are red.', outputTokens: 812 });
		expect(runs.get('claude-code').failure).toBeNull();
		// Not a success: nothing is stamped.
		expect(runs.get('claude-code').lastSuccessAt).toBeNull();
	});

	it('records a usage limit with the instant it lifts', () => {
		const { runs } = history();
		runs.note({
			provider: 'claude-code',
			status: 'failed',
			summary: "You've hit your weekly limit · resets Nov 12, 3am"
		});
		expect(runs.get('claude-code').failure).toMatchObject({
			kind: 'limit_reached',
			usageLimit: true,
			resetsAt: '2026-11-12T03:00:00.000Z',
			until: '2026-11-12T03:01:00.000Z'
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
		runs.note({ provider: 'claude-code', status: 'failed', summary: ORG_DISABLED });
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
		runs.note({ provider: 'claude-code', status: 'failed', summary: SESSION_EXPIRED });
		runs.observeAuth('claude-code', SIGNED_OUT);
		expect(runs.get('claude-code').failure?.authFingerprint).toBe(agentAuthFingerprint(SIGNED_OUT));
		runs.observeAuth('claude-code', SIGNED_IN);
		expect(runs.get('claude-code').failure).toBeNull();
	});

	it('a sign-in change does not lift a usage limit', () => {
		const { runs } = history();
		runs.observeAuth('claude-code', SIGNED_IN);
		runs.note({ provider: 'claude-code', status: 'failed', summary: '5-hour limit reached ∙ resets 3pm' });
		runs.observeAuth('claude-code', { signedIn: true, method: 'api_key', account: null });
		expect(runs.get('claude-code').failure?.kind).toBe('limit_reached');
	});

	it('persists every change in order, and a restart restores it', async () => {
		const first = history();
		first.runs.note({ provider: 'claude-code', status: 'succeeded', summary: 'Done.' });
		first.advance(1000);
		first.runs.note({ provider: 'claude-code', status: 'failed', summary: ORG_DISABLED });
		await first.runs.settled();
		expect(first.saved).toHaveLength(2);
		const stored = parseAgentRunHistoryRecord(JSON.stringify(first.saved.at(-1)));
		expect(stored?.agents['claude-code']).toMatchObject({
			lastSuccessAt: ISO,
			failure: { kind: 'access_denied', reason: ORG_DISABLED }
		});

		const restarted = history(stored);
		expect(restarted.runs.get('claude-code').failure?.kind).toBe('access_denied');
		expect(restarted.runs.get('claude-code').lastSuccessAt).toBe(ISO);
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
		runs.note({ provider: 'codex', status: 'failed', summary: 'Not logged in' });
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
						failure: { kind: 'on_fire', reason: 'x', at: ISO },
						usage: [
							{ window: 'five_hour', usedPercent: 500 },
							{ window: 'weekly', usedPercent: 5 }
						],
						usageObservedAt: ISO,
						secret: 'sk-ant-nope'
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

	it('sits beside the config', () => {
		expect(agentRunHistoryPath('/etc/ever-works/node-config.json')).toBe(
			'/etc/ever-works/node-config.json.agent-readiness.json'
		);
	});
});

describe('resolveAgentStatus', () => {
	const base = { installed: true, auth: SIGNED_IN, history: emptyEntry(), nowMs: NOW };

	it('signed in and nothing against it → ready', () => {
		expect(resolveAgentStatus(base)).toEqual({ status: 'ready', reason: null });
	});

	it('not installed → not_installed; a startup lookup that timed out → unknown', () => {
		expect(resolveAgentStatus({ ...base, installed: false }).status).toBe('not_installed');
		expect(resolveAgentStatus({ ...base, installed: false, probeTimedOut: true }).status).toBe('unknown');
	});

	it('a binary this node cannot start → unsupported, naming what it lacks', () => {
		const verdict = resolveAgentStatus({ ...base, missingRequiredFlags: ['--output-format'] });
		expect(verdict.status).toBe('unsupported');
		expect(verdict.reason).toContain('--output-format');
	});

	it('"signed in" does not outrank what the last run proved (the production case)', () => {
		const failure = {
			kind: 'access_denied' as const,
			reason: ORG_DISABLED,
			resetsAt: null,
			until: null,
			usageLimit: false,
			at: ISO,
			authFingerprint: agentAuthFingerprint(SIGNED_IN)
		};
		expect(resolveAgentStatus({ ...base, history: emptyEntry({ failure }) })).toEqual({
			status: 'access_denied',
			reason: ORG_DISABLED
		});
	});

	it('the worker`s throttle → limit_reached until its instant', () => {
		expect(
			resolveAgentStatus({
				...base,
				throttle: { provider: 'claude-code', until: '2026-11-12T03:01:00.000Z', reason: 'weekly limit' },
				throttlesKnown: true
			})
		).toEqual({ status: 'limit_reached', reason: 'weekly limit', limitResetsAt: '2026-11-12T03:01:00.000Z' });
	});

	const usageLimit = {
		kind: 'limit_reached' as const,
		reason: "You've hit your weekly limit",
		resetsAt: '2026-11-12T03:00:00.000Z',
		until: '2026-11-12T03:01:00.000Z',
		usageLimit: true,
		at: ISO,
		authFingerprint: null
	};

	it('a usage limit stands until its instant on a node without a worker', () => {
		const history = emptyEntry({ failure: usageLimit });
		expect(resolveAgentStatus({ ...base, history })).toMatchObject({
			status: 'limit_reached',
			limitResetsAt: '2026-11-12T03:00:00.000Z'
		});
		expect(resolveAgentStatus({ ...base, history, nowMs: Date.parse('2026-11-12T03:02:00.000Z') }).status).toBe(
			'ready'
		);
	});

	it('a usage limit the worker no longer holds was lifted ("Clear limit now") → ready', () => {
		expect(
			resolveAgentStatus({
				...base,
				history: emptyEntry({ failure: usageLimit }),
				throttle: null,
				throttlesKnown: true
			})
		).toEqual({ status: 'ready', reason: null });
	});

	it('out of credit is not the worker`s throttle: it stands for its hour even with a worker', () => {
		const credit = {
			...usageLimit,
			usageLimit: false,
			resetsAt: null,
			until: '2026-11-10T13:00:00.000Z',
			reason: 'Credit balance is too low'
		};
		expect(
			resolveAgentStatus({
				...base,
				history: emptyEntry({ failure: credit }),
				throttle: null,
				throttlesKnown: true
			})
		).toEqual({
			status: 'limit_reached',
			reason: 'Credit balance is too low',
			limitResetsAt: '2026-11-10T13:00:00.000Z'
		});
	});

	it('signed out → not_signed_in, unless a run succeeded recently (a per-run credential)', () => {
		expect(resolveAgentStatus({ ...base, auth: SIGNED_OUT }).status).toBe('not_signed_in');
		const recent = emptyEntry({ lastSuccessAt: new Date(NOW - AGENT_SUCCESS_TRUST_MS + 1000).toISOString() });
		expect(resolveAgentStatus({ ...base, auth: SIGNED_OUT, history: recent }).status).toBe('ready');
		const stale = emptyEntry({ lastSuccessAt: new Date(NOW - AGENT_SUCCESS_TRUST_MS - 1000).toISOString() });
		expect(resolveAgentStatus({ ...base, auth: SIGNED_OUT, history: stale }).status).toBe('not_signed_in');
	});

	it('no status reading and no recent success → unknown, never ready', () => {
		expect(resolveAgentStatus({ ...base, auth: null }).status).toBe('unknown');
		expect(resolveAgentStatus({ ...base, auth: { signedIn: null, method: 'unknown', account: null } }).status).toBe(
			'unknown'
		);
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
			auth: async () => SIGNED_IN,
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
					reason: 'This node version cannot run agent work with this CLI.',
					checkedAt: ISO
				}
			]
		});
	});

	it('online, CLI installed, signed in — and not ready: the run that was refused decides', async () => {
		const runs = new AgentRunHistory({ now: () => NOW });
		runs.note({ provider: 'claude-code', status: 'failed', summary: ORG_DISABLED });
		const report = await buildAgentReadinessReport({
			drivable: () => drivable,
			auth: async () => SIGNED_IN,
			history: runs,
			throttles: () => [],
			now: () => NOW
		});
		expect(report.agents[0]).toMatchObject({
			installed: true,
			signedIn: true,
			status: 'access_denied',
			reason: ORG_DISABLED,
			lastFailureAt: ISO
		});
		expect(report.agents.some((agent) => agent.status === 'ready')).toBe(false);
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
			auth: async () => SIGNED_IN,
			history: runs,
			now: () => NOW
		});
		expect(report.agents[0]?.usage).toEqual([
			{ window: 'weekly', usedPercent: 20, resetsAt: '2026-11-14T00:00:00.000Z' }
		]);
	});

	it('carries no credential: the report is built from labels, statuses and timestamps only', async () => {
		const runs = new AgentRunHistory({ now: () => NOW });
		runs.note({
			provider: 'claude-code',
			status: 'failed',
			summary: 'Invalid API key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123 · Fix external API key'
		});
		const report = await buildAgentReadinessReport({
			drivable: () => drivable,
			auth: async () => ({ signedIn: true, method: 'api_key', account: null }),
			history: runs,
			now: () => NOW
		});
		expect(report.agents[0]?.status).toBe('not_signed_in');
		expect(JSON.stringify(report)).not.toContain('AbCdEf');
	});
});
