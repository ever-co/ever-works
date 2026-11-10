import { describe, expect, it } from 'vitest';

import {
	FLEET_AGENT_AUTH_METHODS,
	FLEET_AGENT_FAILURE_FALLBACK_MS,
	FLEET_AGENT_READINESS_MAX_AGENTS,
	FLEET_AGENT_READINESS_MAX_REASON_LENGTH,
	FLEET_AGENT_READINESS_MAX_USAGE_WINDOWS,
	FLEET_AGENT_READINESS_STALE_AFTER_MS,
	FLEET_AGENT_READINESS_STATUSES,
	anyFleetAgentReady,
	classifyFleetAgentFailure,
	emptyFleetNodeRunStats,
	isFleetAgentReady,
	normalizeFleetAgentReadinessReport,
	redactFleetAgentText,
	resolveFleetNodeAgentReadiness,
	sanitizeFleetAgentAccount,
	sanitizeFleetAgentReason,
	type FleetAgentReadinessEntry
} from '../fleet-agent-readiness.types.js';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');

function entry(overrides: Partial<FleetAgentReadinessEntry> = {}): FleetAgentReadinessEntry {
	return {
		provider: 'claude-code',
		installed: true,
		version: '2.1.319',
		signedIn: true,
		authMethod: 'subscription',
		account: 'owner@example.com (Acme, max)',
		status: 'ready',
		reason: null,
		checkedAt: '2026-11-10T11:59:00.000Z',
		...overrides
	};
}

describe('classifyFleetAgentFailure', () => {
	// The two sentences the production node actually failed with.
	it('reads the organization switch as access denied (prod, 2026-11)', () => {
		const failure = classifyFleetAgentFailure(
			'claude-code reported an error: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access',
			{ now: NOW }
		);
		expect(failure).toEqual({
			kind: 'access_denied',
			reason: 'claude-code reported an error: Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access',
			resetsAt: null,
			until: null,
			usageLimit: false
		});
	});

	it.each([
		['Failed to authenticate: OAuth session expired and could not be refreshed'],
		['Login expired · Please run /login'],
		['Not logged in · Please run /login'],
		['OAuth token revoked · Please run /login'],
		[
			'Please run /login · API Error: 401 OAuth token has expired. Please obtain a new token or refresh your existing token.'
		],
		['Please run /login · API Error: 401 Invalid authentication credentials'],
		['Invalid API key · Fix external API key'],
		['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
		// Codex.
		['Not logged in'],
		[
			'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.'
		],
		[
			'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.'
		],
		['unexpected status 401 Unauthorized: {"error":{"message":"Missing bearer"}}']
	])('reads %j as not signed in', (sentence) => {
		const failure = classifyFleetAgentFailure(sentence, { now: NOW, strict: true });
		expect(failure?.kind).toBe('not_signed_in');
		expect(failure?.until).toBeNull();
		expect(failure?.usageLimit).toBe(false);
	});

	it.each([
		[
			'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization."}}'
		],
		['unexpected status 403 Forbidden: {"detail":"Workspace is not allowed to use this model"}']
	])('reads %j as access denied', (sentence) => {
		expect(classifyFleetAgentFailure(sentence, { now: NOW, strict: true })?.kind).toBe('access_denied');
	});

	it('reads a usage limit with its reset, and marks it as the limit the worker throttles on', () => {
		const failure = classifyFleetAgentFailure("You've hit your weekly limit · resets Nov 12, 3am (Europe/Paris)", {
			now: NOW
		});
		expect(failure?.kind).toBe('limit_reached');
		expect(failure?.usageLimit).toBe(true);
		expect(failure?.resetsAt).toBe('2026-11-12T02:00:00.000Z');
		// The reset plus the contract's one-minute slack.
		expect(failure?.until).toBe('2026-11-12T02:01:00.000Z');
		expect(failure?.reason).toBe("You've hit your weekly limit · resets Nov 12, 3am (Europe/Paris)");
	});

	it('reads a Codex usage limit that names a relative reset', () => {
		const failure = classifyFleetAgentFailure(
			'You’ve hit your usage limit. Upgrade to Pro or try again in 2 days 3 hours.',
			{ provider: 'codex', now: NOW }
		);
		expect(failure?.kind).toBe('limit_reached');
		expect(failure?.resetsAt).toBe('2026-11-12T15:00:00.000Z');
	});

	it.each([['Credit balance is too low'], ['Quota exceeded. Check your plan and billing details.']])(
		'reads %j as a limit with no reset, trusted for the fallback hour',
		(sentence) => {
			const failure = classifyFleetAgentFailure(sentence, { now: NOW, strict: true });
			expect(failure).toEqual({
				kind: 'limit_reached',
				reason: sentence,
				resetsAt: null,
				until: new Date(NOW + FLEET_AGENT_FAILURE_FALLBACK_MS).toISOString(),
				usageLimit: false
			});
		}
	);

	it('prefers "not allowed" over "run /login" when a sentence says both', () => {
		expect(
			classifyFleetAgentFailure('Your organization has disabled Claude subscription access · Please run /login', {
				now: NOW
			})?.kind
		).toBe('access_denied');
	});

	it('quotes only the line that matched, on one line', () => {
		const failure = classifyFleetAgentFailure(
			['Starting…', 'Login expired · Please run /login', 'Stack: at main (cli.js:1:1)'].join('\n'),
			{ now: NOW }
		);
		expect(failure?.reason).toBe('Login expired · Please run /login');
	});

	it.each([
		[null],
		[undefined],
		[42],
		[''],
		['   '],
		['The build failed: 3 tests are red.'],
		['Error: max turns reached'],
		// A Task about sign-in pages is not the CLI being signed out.
		['I added the login page and a logout button; the session cookie is now cleared on sign out.']
	])('answers null for %j', (text) => {
		expect(classifyFleetAgentFailure(text, { now: NOW })).toBeNull();
	});

	it('keeps the loose phrases out of strict mode (a model can write them)', () => {
		const loose = 'The service account does not have access to the bucket.';
		expect(classifyFleetAgentFailure(loose, { now: NOW })?.kind).toBe('access_denied');
		expect(classifyFleetAgentFailure(loose, { now: NOW, strict: true })).toBeNull();
	});

	it('masks anything credential-shaped in the sentence it quotes', () => {
		const failure = classifyFleetAgentFailure(
			'Invalid API key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 · Fix external API key',
			{ now: NOW }
		);
		expect(failure?.kind).toBe('not_signed_in');
		expect(failure?.reason).toBe('Invalid API key [redacted] · Fix external API key');
		expect(JSON.stringify(failure)).not.toContain('AbCdEf');
	});

	it('is pure: the same text and clock give the same answer', () => {
		const text = '5-hour limit reached ∙ resets 3pm';
		expect(classifyFleetAgentFailure(text, { now: NOW, timeZone: 'UTC' })).toEqual(
			classifyFleetAgentFailure(text, { now: NOW, timeZone: 'UTC' })
		);
	});
});

describe('redaction', () => {
	it.each([
		['token sk-proj-1234567890abcdef rest', 'token [redacted] rest'],
		['Authorization: Bearer abc.def-ghi_jkl123456', 'Authorization: [redacted]'],
		['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl here', 'jwt [redacted] here'],
		['hex 0123456789abcdef0123456789abcdef0123 end', 'hex [redacted] end'],
		['owner@example.com (Acme, max)', 'owner@example.com (Acme, max)']
	])('redactFleetAgentText(%j)', (input, expected) => {
		expect(redactFleetAgentText(input)).toBe(expected);
	});

	it('cuts a reason to one bounded line', () => {
		const reason = sanitizeFleetAgentReason(`first\nsecond\t${'word '.repeat(200)}`);
		expect(reason).not.toContain('\n');
		expect(Array.from(reason ?? '').length).toBeLessThanOrEqual(FLEET_AGENT_READINESS_MAX_REASON_LENGTH);
		expect(reason?.endsWith('…')).toBe(true);
	});

	it('answers null for an empty or non-string value', () => {
		expect(sanitizeFleetAgentReason('  \n ')).toBeNull();
		expect(sanitizeFleetAgentReason(7)).toBeNull();
		expect(sanitizeFleetAgentAccount(null)).toBeNull();
	});
});

describe('normalizeFleetAgentReadinessReport', () => {
	it('answers null for anything that is not a report', () => {
		for (const raw of [null, undefined, 'x', 3, [], {}, { agents: 'none' }, { checkedAt: 'now' }]) {
			expect(normalizeFleetAgentReadinessReport(raw)).toBeNull();
		}
	});

	it('keeps an EMPTY agent list: "this machine has no agent CLI" is a real report', () => {
		expect(normalizeFleetAgentReadinessReport({ checkedAt: '2026-11-10T12:00:00Z', agents: [] })).toEqual({
			checkedAt: '2026-11-10T12:00:00.000Z',
			agents: []
		});
	});

	it('round-trips a full entry', () => {
		const full = entry({
			status: 'limit_reached',
			reason: "You've hit your weekly limit · resets Nov 12, 3am",
			limitResetsAt: '2026-11-12T02:00:00.000Z',
			usage: [
				{ window: 'five_hour', usedPercent: 42.5, resetsAt: '2026-11-10T15:00:00.000Z' },
				{ window: 'weekly', usedPercent: 100, resetsAt: '2026-11-12T02:00:00.000Z', limited: true }
			],
			usageObservedAt: '2026-11-10T11:30:00.000Z',
			lastSuccessAt: '2026-11-10T10:00:00.000Z',
			lastFailureAt: '2026-11-10T11:30:00.000Z'
		});
		expect(normalizeFleetAgentReadinessReport({ checkedAt: full.checkedAt, agents: [full] })).toEqual({
			checkedAt: full.checkedAt,
			agents: [full]
		});
	});

	it('drops what it does not know and bounds what it keeps', () => {
		const report = normalizeFleetAgentReadinessReport({
			checkedAt: '2026-11-10T12:00:00.000Z',
			somethingNew: true,
			agents: [
				{
					provider: 'claude-code',
					installed: 'yes',
					version: 2,
					signedIn: 'true',
					authMethod: 'carrier-pigeon',
					account: `owner@example.com\n${'x'.repeat(40)}`,
					status: 'levitating',
					reason: 'Bearer abcdefghijklmnop was refused',
					checkedAt: 'not a date',
					token: 'sk-ant-secret-secret-secret',
					limitResetsAt: 'tomorrow',
					usage: [
						{ window: 'five_hour', usedPercent: 250, resetsAt: 'soon' },
						{ window: 'weekly', usedPercent: 12.34 },
						{ window: 'has spaces', usedPercent: 1 },
						'junk'
					],
					usageObservedAt: '2026-11-10T11:00:00.000Z',
					lastSuccessAt: 'never'
				},
				{ provider: '' },
				{ provider: 'claude-code', installed: true, status: 'ready' },
				null
			]
		});
		expect(report).toEqual({
			checkedAt: '2026-11-10T12:00:00.000Z',
			agents: [
				{
					provider: 'claude-code',
					installed: false,
					version: null,
					signedIn: null,
					authMethod: 'unknown',
					account: 'owner@example.com [redacted]',
					status: 'unknown',
					reason: '[redacted] was refused',
					checkedAt: '2026-11-10T12:00:00.000Z',
					usage: [{ window: 'weekly', usedPercent: 12.3, resetsAt: null }],
					usageObservedAt: '2026-11-10T11:00:00.000Z'
				}
			]
		});
		expect(JSON.stringify(report)).not.toContain('sk-ant');
	});

	it('caps the agents and the windows', () => {
		const report = normalizeFleetAgentReadinessReport({
			checkedAt: '2026-11-10T12:00:00.000Z',
			agents: Array.from({ length: 20 }, (_, index) => ({
				provider: `cli-${index}`,
				installed: true,
				status: 'ready',
				usage: Array.from({ length: 20 }, (_w, slot) => ({ window: `w${slot}`, usedPercent: slot }))
			}))
		});
		expect(report?.agents).toHaveLength(FLEET_AGENT_READINESS_MAX_AGENTS);
		expect(report?.agents[0]?.usage).toHaveLength(FLEET_AGENT_READINESS_MAX_USAGE_WINDOWS);
	});

	it('falls back to the supplied instant when the report carries no usable one', () => {
		const report = normalizeFleetAgentReadinessReport(
			{ agents: [{ provider: 'codex', installed: true, status: 'ready' }] },
			'2026-11-10T12:00:05.000Z'
		);
		expect(report?.checkedAt).toBe('2026-11-10T12:00:05.000Z');
		expect(report?.agents[0]?.checkedAt).toBe('2026-11-10T12:00:05.000Z');
	});

	it('accepts every status and method it declares', () => {
		for (const status of FLEET_AGENT_READINESS_STATUSES) {
			for (const authMethod of FLEET_AGENT_AUTH_METHODS) {
				const report = normalizeFleetAgentReadinessReport({
					checkedAt: '2026-11-10T12:00:00.000Z',
					agents: [{ provider: 'codex', installed: true, status, authMethod }]
				});
				expect(report?.agents[0]).toMatchObject({ status, authMethod });
			}
		}
	});
});

describe('the node-level answer', () => {
	it('an agent is ready only when it is installed AND ready', () => {
		expect(isFleetAgentReady(entry())).toBe(true);
		expect(isFleetAgentReady(entry({ installed: false }))).toBe(false);
		for (const status of FLEET_AGENT_READINESS_STATUSES.filter((value) => value !== 'ready')) {
			expect(isFleetAgentReady(entry({ status }))).toBe(false);
		}
	});

	it('one ready agent is enough; none, or no agent at all, is not', () => {
		expect(anyFleetAgentReady([entry({ status: 'access_denied' }), entry({ provider: 'codex' })])).toBe(true);
		expect(anyFleetAgentReady([entry({ status: 'access_denied' }), entry({ status: 'not_signed_in' })])).toBe(
			false
		);
		expect(anyFleetAgentReady([])).toBe(false);
	});

	it('serves the stored report with the answer, stamped with the receipt time', () => {
		const view = resolveFleetNodeAgentReadiness({
			at: '2026-11-10T12:00:01.000Z',
			checkedAt: '2026-11-10T12:00:00.000Z',
			agents: [
				entry({ status: 'access_denied', reason: 'Your organization has disabled Claude subscription access' }),
				entry({ provider: 'codex', installed: false, status: 'not_installed', signedIn: null, account: null })
			]
		});
		expect(view?.at).toBe('2026-11-10T12:00:01.000Z');
		expect(view?.anyReady).toBe(false);
		expect(view?.agents.map((agent) => agent.status)).toEqual(['access_denied', 'not_installed']);
	});

	it('answers null for a row that holds no report, a junk one, or one with no receipt time', () => {
		expect(resolveFleetNodeAgentReadiness(null)).toBeNull();
		expect(resolveFleetNodeAgentReadiness('{}')).toBeNull();
		expect(resolveFleetNodeAgentReadiness({ at: '2026-11-10T12:00:00.000Z' })).toBeNull();
		expect(resolveFleetNodeAgentReadiness({ checkedAt: '2026-11-10T12:00:00.000Z', agents: [] })).toBeNull();
	});

	it('an agent the platform is throttling is not ready, whatever the node last said', () => {
		const stored = { at: '2026-11-10T12:00:01.000Z', checkedAt: '2026-11-10T12:00:00.000Z', agents: [entry()] };
		expect(resolveFleetNodeAgentReadiness(stored)?.anyReady).toBe(true);
		const view = resolveFleetNodeAgentReadiness(stored, {
			throttles: [
				{
					provider: 'claude-code',
					window: 'weekly',
					until: '2026-11-12T02:01:00.000Z',
					reason: "You've hit your weekly limit · resets Nov 12, 3am",
					since: '2026-11-10T11:59:30.000Z'
				}
			]
		});
		expect(view?.anyReady).toBe(false);
		expect(view?.agents[0]).toMatchObject({
			status: 'limit_reached',
			reason: "You've hit your weekly limit · resets Nov 12, 3am",
			limitResetsAt: '2026-11-12T02:01:00.000Z'
		});
	});

	it('a throttle on one CLI leaves another ready, and never overrides a worse status', () => {
		const view = resolveFleetNodeAgentReadiness(
			{
				at: '2026-11-10T12:00:01.000Z',
				checkedAt: '2026-11-10T12:00:00.000Z',
				agents: [
					entry({ status: 'not_signed_in', reason: 'Login expired · Please run /login' }),
					entry({ provider: 'codex' })
				]
			},
			{
				throttles: [
					{
						provider: 'claude-code',
						window: 'session',
						until: '2026-11-10T15:00:00.000Z',
						reason: '5-hour limit reached',
						since: '2026-11-10T11:00:00.000Z'
					}
				]
			}
		);
		expect(view?.agents[0]).toMatchObject({ status: 'not_signed_in', reason: 'Login expired · Please run /login' });
		expect(view?.anyReady).toBe(true);
	});

	it('a report the node stopped sending while it kept beating is not served — unknown, not last week`s ready', () => {
		const stored = { at: '2026-11-10T12:00:00.000Z', checkedAt: '2026-11-10T12:00:00.000Z', agents: [entry()] };
		const at = Date.parse(stored.at);
		// Refreshed on this very beat, or a few beats ago: served.
		expect(resolveFleetNodeAgentReadiness(stored, { lastHeartbeatAt: stored.at })?.anyReady).toBe(true);
		expect(
			resolveFleetNodeAgentReadiness(stored, {
				lastHeartbeatAt: new Date(at + FLEET_AGENT_READINESS_STALE_AFTER_MS)
			})?.anyReady
		).toBe(true);
		// The node has been beating for longer than that without a report.
		expect(
			resolveFleetNodeAgentReadiness(stored, {
				lastHeartbeatAt: new Date(at + FLEET_AGENT_READINESS_STALE_AFTER_MS + 1).toISOString()
			})
		).toBeNull();
		// An OFFLINE node's last report stays: its last beat is the one that carried it.
		expect(resolveFleetNodeAgentReadiness(stored, { lastHeartbeatAt: null })?.anyReady).toBe(true);
		expect(resolveFleetNodeAgentReadiness(stored, { lastHeartbeatAt: 'not a date' })?.anyReady).toBe(true);
	});

	it('emptyFleetNodeRunStats is a fresh zeroed pair of windows', () => {
		const stats = emptyFleetNodeRunStats();
		expect(stats).toEqual({
			last24h: { runs: 0, failed: 0, costCents: 0 },
			last7d: { runs: 0, failed: 0, costCents: 0 }
		});
		stats.last24h.runs = 3;
		expect(emptyFleetNodeRunStats().last24h.runs).toBe(0);
	});
});
