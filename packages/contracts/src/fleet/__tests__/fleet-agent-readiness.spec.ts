import { describe, expect, it } from 'vitest';

import {
	FLEET_AGENT_AUTH_METHODS,
	FLEET_AGENT_FAILURE_FALLBACK_MS,
	FLEET_AGENT_READINESS_MAX_AGENTS,
	FLEET_AGENT_READINESS_MAX_USAGE_WINDOWS,
	FLEET_AGENT_READINESS_STALE_AFTER_MS,
	FLEET_AGENT_READINESS_STATUSES,
	FLEET_AGENT_REASON_CODES,
	FLEET_AGENT_USAGE_DEFAULT_WINDOW_MINUTES,
	anyFleetAgentReady,
	classifyFleetAgentFailure,
	describeFleetAgentReason,
	emptyFleetNodeRunStats,
	isFleetAgentDefinitelyUnavailable,
	isFleetAgentReady,
	isFleetAgentReasonCode,
	isFleetAgentUsageWindowCurrent,
	normalizeFleetAgentReadinessReport,
	redactFleetAgentText,
	resolveFleetNodeAgentReadiness,
	sanitizeFleetAgentAccount,
	type FleetAgentReadinessEntry
} from '../fleet-agent-readiness.types.js';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');

/**
 * Credential-SHAPED fixtures for the masking cases. Assembled at runtime from
 * plainly fake parts, so no line of this file holds anything a secret scanner
 * (or a reader) could take for a real key. None of them is a credential.
 */
const FAKE_API_KEY = ['sk', 'ant', 'api03', 'FAKE'.repeat(8)].join('-');
const FAKE_PROJECT_KEY = ['sk', 'proj', 'FAKE'.repeat(4)].join('-');
const FAKE_BEARER = ['Bearer', 'fake'.repeat(5)].join(' ');
const FAKE_BASIC = ['Basic', 'ZmFrZQ'.repeat(4)].join(' ');
const FAKE_JWT = [`eyJ${'head'.repeat(3)}`, `eyJ${'body'.repeat(3)}`, 'sign'.repeat(3)].join('.');
const FAKE_HEX = 'ab12'.repeat(9);
const FAKE_DB_URL = ['postgres://app', 'fakefakepass@db.internal:5432/prod'].join(':');
const FAKE_SLASHED = ['fakeFAKEfake1', 'FAKEfak', 'fakeFAKEfakeFAKEfa'].join('/');

/** The two sentences the production node actually failed with. */
const ORG_DISABLED =
	'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';
const SESSION_EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';

function entry(overrides: Partial<FleetAgentReadinessEntry> = {}): FleetAgentReadinessEntry {
	return {
		provider: 'claude-code',
		installed: true,
		version: '2.1.319',
		signedIn: true,
		authMethod: 'subscription',
		account: 'owner@example.com (Acme, max)',
		status: 'ready',
		reasonCode: null,
		reason: null,
		checkedAt: '2026-11-10T11:59:00.000Z',
		...overrides
	};
}

describe('classifyFleetAgentFailure — what the CLI itself reported', () => {
	it('reads the organization switch as access denied (prod, 2026-11), as a CODE and nothing of the text', () => {
		const failure = classifyFleetAgentFailure(ORG_DISABLED, { now: NOW });
		expect(failure).toEqual({
			kind: 'access_denied',
			code: 'org_access_disabled',
			window: null,
			resetsAt: null,
			until: null,
			usageLimit: false
		});
	});

	it('reads the expired OAuth session as not signed in (prod, 2026-11)', () => {
		expect(classifyFleetAgentFailure(SESSION_EXPIRED, { now: NOW })).toMatchObject({
			kind: 'not_signed_in',
			code: 'session_expired'
		});
	});

	it.each([
		['Login expired · Please run /login', 'session_expired'],
		['OAuth token revoked · Please run /login', 'session_expired'],
		[
			'Please run /login · API Error: 401 OAuth token has expired. Please obtain a new token or refresh your existing token.',
			'session_expired'
		],
		['Not logged in · Please run /login', 'not_logged_in'],
		['Please run /login · API Error: 401 Invalid authentication credentials', 'not_logged_in'],
		['Invalid API key · Fix external API key', 'invalid_api_key'],
		[
			'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
			'unauthorized'
		],
		// Codex.
		['Not logged in', 'not_logged_in'],
		[
			'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
			'session_expired'
		],
		[
			'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
			'session_expired'
		],
		['unexpected status 401 Unauthorized: {"error":{"message":"Missing bearer"}}', 'unauthorized']
	])('reads %j as not signed in (%s)', (sentence, code) => {
		expect(classifyFleetAgentFailure(sentence, { now: NOW })).toEqual({
			kind: 'not_signed_in',
			code,
			window: null,
			resetsAt: null,
			until: null,
			usageLimit: false
		});
	});

	it.each([
		[
			'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization."}}'
		],
		['unexpected status 403 Forbidden: {"detail":"Workspace is not allowed to use this model"}']
	])('reads %j as access denied', (sentence) => {
		expect(classifyFleetAgentFailure(sentence, { now: NOW })).toMatchObject({
			kind: 'access_denied',
			code: 'permission_denied'
		});
	});

	it('reads the structured signals a CLI reports beside (or instead of) a sentence', () => {
		// Claude Code's `api_error_status` on an `is_error` result (CLI ≥ 2.1.110).
		expect(classifyFleetAgentFailure({ apiStatus: 401 }, { now: NOW })).toMatchObject({
			kind: 'not_signed_in',
			code: 'unauthorized'
		});
		expect(classifyFleetAgentFailure({ apiStatus: 403 }, { now: NOW })).toMatchObject({
			kind: 'access_denied',
			code: 'permission_denied'
		});
		expect(classifyFleetAgentFailure({ apiStatus: 429 }, { now: NOW })).toEqual({
			kind: 'limit_reached',
			code: 'usage_limit',
			window: 'rate',
			resetsAt: null,
			until: new Date(NOW + FLEET_AGENT_FAILURE_FALLBACK_MS).toISOString(),
			usageLimit: true
		});
		// The `error` class on a Claude Code assistant event.
		expect(classifyFleetAgentFailure({ errorClass: 'authentication_failed' }, { now: NOW })?.code).toBe(
			'unauthorized'
		);
		expect(classifyFleetAgentFailure({ errorClass: 'billing_error' }, { now: NOW })?.code).toBe('out_of_credit');
		expect(classifyFleetAgentFailure({ errorClass: 'rate_limit' }, { now: NOW })?.code).toBe('usage_limit');
		// A class that names none of the three conditions.
		expect(classifyFleetAgentFailure({ errorClass: 'server_error', apiStatus: 529 }, { now: NOW })).toBeNull();
		// The more specific sentence wins over the bare status.
		expect(classifyFleetAgentFailure({ text: ORG_DISABLED, apiStatus: 403 }, { now: NOW })?.code).toBe(
			'org_access_disabled'
		);
	});

	it('reads a usage limit with its window and reset, and marks it as the limit the worker throttles on', () => {
		expect(
			classifyFleetAgentFailure("You've hit your weekly limit · resets Nov 12, 3am (Europe/Paris)", { now: NOW })
		).toEqual({
			kind: 'limit_reached',
			code: 'usage_limit',
			window: 'weekly',
			resetsAt: '2026-11-12T02:00:00.000Z',
			// The reset plus the contract's one-minute slack.
			until: '2026-11-12T02:01:00.000Z',
			usageLimit: true
		});
	});

	it('reads a Codex usage limit that names a relative reset', () => {
		expect(
			classifyFleetAgentFailure('You’ve hit your usage limit. Upgrade to Pro or try again in 2 days 3 hours.', {
				provider: 'codex',
				now: NOW
			})
		).toMatchObject({ kind: 'limit_reached', code: 'usage_limit', resetsAt: '2026-11-12T15:00:00.000Z' });
	});

	it.each([['Credit balance is too low'], ['Quota exceeded. Check your plan and billing details.']])(
		'reads %j as out of credit: a limit no clock lifts (no reset, no hold-until)',
		(sentence) => {
			expect(classifyFleetAgentFailure(sentence, { now: NOW })).toEqual({
				kind: 'limit_reached',
				code: 'out_of_credit',
				window: null,
				resetsAt: null,
				until: null,
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

	describe('a run that reached its model (modelReached)', () => {
		it.each([
			[ORG_DISABLED],
			[SESSION_EXPIRED],
			['Not logged in · Please run /login'],
			['API Error: 403 forbidden']
		])('never answers a sign-in or access verdict for %j', (sentence) => {
			expect(classifyFleetAgentFailure(sentence, { now: NOW, modelReached: true })).toBeNull();
			expect(
				classifyFleetAgentFailure({ text: sentence, apiStatus: 401 }, { now: NOW, modelReached: true })
			).toBeNull();
		});

		it('can still prove a limit, which a run can hit in the middle', () => {
			expect(
				classifyFleetAgentFailure('5-hour limit reached ∙ resets 3pm', {
					now: NOW,
					timeZone: 'UTC',
					modelReached: true
				})?.code
			).toBe('usage_limit');
			expect(classifyFleetAgentFailure('Credit balance is too low', { now: NOW, modelReached: true })?.code).toBe(
				'out_of_credit'
			);
		});
	});

	it.each([
		[null],
		[undefined],
		[''],
		['   '],
		[{}],
		[{ text: null, apiStatus: null, errorClass: null }],
		['The build failed: 3 tests are red.'],
		['Error: max turns reached'],
		// The loose phrases the first version matched are gone: only the CLIs'
		// own sentences are read, whoever the caller is.
		['The service account does not have access to the bucket.'],
		['Network access is disabled in this sandbox, so I could not run npm install.'],
		['I do not have permission to write outside the workspace.'],
		['Please sign in again to continue.']
	])('answers null for %j', (input) => {
		expect(classifyFleetAgentFailure(input as never, { now: NOW })).toBeNull();
	});

	it('answers a code and structured facts only — never a character of the text it read', () => {
		const text = `Invalid API key ${FAKE_API_KEY} · Fix external API key (see ${FAKE_DB_URL})`;
		const failure = classifyFleetAgentFailure(text, { now: NOW });
		expect(failure?.code).toBe('invalid_api_key');
		const serialized = JSON.stringify(failure);
		expect(serialized).not.toContain('FAKE');
		expect(serialized).not.toContain('fakefakepass');
		expect(serialized).not.toContain('Fix external');
		expect(Object.keys(failure ?? {}).sort()).toEqual([
			'code',
			'kind',
			'resetsAt',
			'until',
			'usageLimit',
			'window'
		]);
	});

	it('is pure: the same input and clock give the same answer', () => {
		const text = '5-hour limit reached ∙ resets 3pm';
		expect(classifyFleetAgentFailure(text, { now: NOW, timeZone: 'UTC' })).toEqual(
			classifyFleetAgentFailure(text, { now: NOW, timeZone: 'UTC' })
		);
	});
});

describe('reasons are a fixed table', () => {
	it('has one sentence per code, and none for a code it does not know', () => {
		for (const code of FLEET_AGENT_REASON_CODES) {
			expect(isFleetAgentReasonCode(code)).toBe(true);
			const sentence = describeFleetAgentReason(code);
			expect(typeof sentence).toBe('string');
			expect(sentence?.length).toBeGreaterThan(10);
		}
		expect(new Set(FLEET_AGENT_REASON_CODES.map((code) => describeFleetAgentReason(code))).size).toBe(
			FLEET_AGENT_REASON_CODES.length
		);
		for (const unknown of ['made_up', '', null, undefined, 7, 'Your organization has disabled…']) {
			expect(isFleetAgentReasonCode(unknown)).toBe(false);
			expect(describeFleetAgentReason(unknown)).toBeNull();
		}
	});

	it('names the window of a usage limit, from a closed set', () => {
		expect(describeFleetAgentReason('usage_limit', { window: 'weekly' })).toBe('The weekly limit is reached.');
		expect(describeFleetAgentReason('usage_limit', { window: 'session' })).toBe('The 5-hour limit is reached.');
		expect(describeFleetAgentReason('usage_limit')).toBe('The usage limit is reached.');
		expect(describeFleetAgentReason('usage_limit', { window: 'whenever' as never })).toBe(
			'The usage limit is reached.'
		);
	});
});

describe('redaction (defence in depth for the labels that remain)', () => {
	it.each([
		[`token ${FAKE_PROJECT_KEY} rest`, 'token [redacted] rest'],
		[`Authorization: ${FAKE_BEARER}`, 'Authorization: [redacted]'],
		[`Authorization: ${FAKE_BASIC}`, 'Authorization: [redacted]'],
		[`jwt ${FAKE_JWT} here`, 'jwt [redacted] here'],
		[`hex ${FAKE_HEX} end`, 'hex [redacted] end'],
		[`connect ${FAKE_DB_URL} failed`, 'connect postgres://[redacted]@db.internal:5432/prod failed'],
		[`aws_secret_access_key=${FAKE_SLASHED} x`, 'aws_secret_access_key=[redacted] x'],
		[`token=${'a1B2c3D4e5'.repeat(3)}Z x`, 'token=[redacted] x'],
		[`key=${['fake1234fake1234', 'fake5678fake5678'].join('.')} x`, 'key=[redacted] x'],
		['owner@example.com (Acme, max)', 'owner@example.com (Acme, max)'],
		['2.1.319 (Claude Code)', '2.1.319 (Claude Code)']
	])('redactFleetAgentText(%j)', (input, expected) => {
		expect(redactFleetAgentText(input)).toBe(expected);
	});

	it('cuts an account label to one bounded line', () => {
		const label = sanitizeFleetAgentAccount(`owner@example.com\n(Acme,\tmax) ${'word '.repeat(100)}`);
		expect(label).not.toContain('\n');
		expect(Array.from(label ?? '').length).toBeLessThanOrEqual(200);
		expect(label?.endsWith('…')).toBe(true);
		expect(sanitizeFleetAgentAccount('  \n ')).toBeNull();
		expect(sanitizeFleetAgentAccount(7)).toBeNull();
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

	it('round-trips a full entry, rebuilding the sentence from the code', () => {
		const full = entry({
			status: 'limit_reached',
			reasonCode: 'usage_limit',
			reason: 'The weekly limit is reached.',
			limitResetsAt: '2026-11-12T02:00:00.000Z',
			limitWindow: 'weekly',
			usage: [
				{ window: 'five_hour', usedPercent: 42.5, resetsAt: '2026-11-10T15:00:00.000Z', windowMinutes: 300 },
				{ window: 'weekly', usedPercent: 100, resetsAt: '2026-11-12T02:00:00.000Z', limited: true }
			],
			usageObservedAt: '2026-11-10T11:30:00.000Z',
			lastSuccessAt: '2026-11-10T10:00:00.000Z',
			lastFailureAt: '2026-11-10T11:30:00.000Z',
			lastFailureKind: 'limit_reached',
			lastFailureCode: 'usage_limit',
			signInCheckedAt: '2026-11-10T11:57:00.000Z'
		});
		expect(normalizeFleetAgentReadinessReport({ checkedAt: full.checkedAt, agents: [full] })).toEqual({
			checkedAt: full.checkedAt,
			agents: [full]
		});
	});

	it('keeps the instant of the sign-in reading only beside a reading, and only when it is one', () => {
		const report = normalizeFleetAgentReadinessReport({
			checkedAt: '2026-11-10T12:00:00.000Z',
			agents: [
				entry({ signInCheckedAt: '2026-11-10T11:57:00Z' }),
				// No reading: nothing for the instant to date.
				entry({ provider: 'codex', signedIn: null, signInCheckedAt: '2026-11-10T11:57:00.000Z' }),
				entry({ provider: 'gemini', signInCheckedAt: 'a while ago' }),
				entry({ provider: 'opencode', signInCheckedAt: 'x'.repeat(1024 * 1024) })
			]
		});
		expect(report?.agents.map((agent) => agent.signInCheckedAt)).toEqual([
			'2026-11-10T11:57:00.000Z',
			undefined,
			undefined,
			undefined
		]);
	});

	it('NEVER keeps a sentence a node sent: the reason is looked up by its code, or absent', () => {
		const leak = `Run said: connect ${FAKE_DB_URL} failed, ${FAKE_BASIC}`;
		const report = normalizeFleetAgentReadinessReport({
			checkedAt: '2026-11-10T12:00:00.000Z',
			agents: [
				// A known code: the node's text is replaced by the table's.
				entry({ status: 'access_denied', reasonCode: 'org_access_disabled', reason: leak }),
				// A token that is not on the closed list — a newer node's new code,
				// or a secret that happens to look like one: dropped, not stored.
				entry({ provider: 'codex', status: 'unknown', reasonCode: 'something_new', reason: leak }),
				entry({
					provider: 'cursor',
					status: 'unknown',
					reasonCode: 'deadbeefcafe0123456789abcdef0123456789ab',
					lastFailureAt: '2026-11-10T11:00:00.000Z',
					lastFailureCode: 'deadbeefcafe0123456789abcdef0123456789ab'
				}),
				// No code at all: no sentence.
				entry({ provider: 'gemini', status: 'not_signed_in', reasonCode: null, reason: leak }),
				// Not a code: dropped.
				entry({ provider: 'opencode', status: 'unknown', reasonCode: leak, reason: leak })
			]
		});
		expect(report?.agents.map((agent) => [agent.reasonCode, agent.reason])).toEqual([
			['org_access_disabled', describeFleetAgentReason('org_access_disabled')],
			[null, null],
			[null, null],
			[null, null],
			[null, null]
		]);
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain('something_new');
		expect(serialized).not.toContain('deadbeef');
		expect(serialized).not.toContain('Run said');
		expect(serialized).not.toContain('fakefakepass');
		expect(serialized).not.toContain('ZmFrZQ');
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
					account: `owner@example.com\n${FAKE_BEARER}`,
					status: 'levitating',
					reasonCode: 'NOT A CODE',
					checkedAt: 'not a date',
					token: FAKE_API_KEY,
					limitResetsAt: 'tomorrow',
					limitWindow: 'fortnightly',
					usage: [
						{ window: 'five_hour', usedPercent: 250, resetsAt: 'soon' },
						{ window: 'weekly', usedPercent: 12.34, windowMinutes: -5 },
						{ window: 'has spaces', usedPercent: 1 },
						'junk'
					],
					usageObservedAt: '2026-11-10T11:00:00.000Z',
					lastSuccessAt: 'never',
					lastFailureKind: 'access_denied',
					lastFailureCode: 'org_access_disabled'
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
					// Neither true nor false: the node did not say.
					installed: null,
					version: null,
					signedIn: null,
					authMethod: 'unknown',
					account: 'owner@example.com [redacted]',
					status: 'unknown',
					reasonCode: null,
					reason: null,
					checkedAt: '2026-11-10T12:00:00.000Z',
					usage: [{ window: 'weekly', usedPercent: 12.3, resetsAt: null }],
					usageObservedAt: '2026-11-10T11:00:00.000Z'
					// No `lastFailureKind` / `lastFailureCode` without the instant they belong to.
				}
			]
		});
		expect(JSON.stringify(report)).not.toContain('FAKE');
		expect(JSON.stringify(report)).not.toContain('fakefake');
	});

	it('keeps installed as three states', () => {
		const report = normalizeFleetAgentReadinessReport({
			checkedAt: '2026-11-10T12:00:00.000Z',
			agents: [
				{ provider: 'a', installed: true, status: 'ready' },
				{ provider: 'b', installed: false, status: 'not_installed' },
				{ provider: 'c', installed: null, status: 'unknown', reasonCode: 'probe_timed_out' }
			]
		});
		expect(report?.agents.map((agent) => agent.installed)).toEqual([true, false, null]);
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

describe('isFleetAgentUsageWindowCurrent', () => {
	const observedAt = '2026-11-10T10:00:00.000Z';

	it('a window that names its reset is current until that instant', () => {
		const window = { window: 'weekly', resetsAt: '2026-11-10T12:30:00.000Z' };
		expect(isFleetAgentUsageWindowCurrent(window, observedAt, NOW)).toBe(true);
		expect(isFleetAgentUsageWindowCurrent(window, observedAt, NOW + 31 * 60_000)).toBe(false);
		// A reset alone is enough: it needs no observation time.
		expect(isFleetAgentUsageWindowCurrent(window, null, NOW)).toBe(true);
	});

	it('a window that names no reset expires after its own length', () => {
		const fiveHour = { window: 'five_hour', resetsAt: null };
		expect(isFleetAgentUsageWindowCurrent(fiveHour, observedAt, NOW)).toBe(true);
		expect(isFleetAgentUsageWindowCurrent(fiveHour, observedAt, Date.parse(observedAt) + 5 * 3_600_000)).toBe(
			false
		);
		const weekly = { window: 'weekly', resetsAt: null };
		expect(isFleetAgentUsageWindowCurrent(weekly, observedAt, NOW + 6 * 86_400_000)).toBe(true);
		expect(isFleetAgentUsageWindowCurrent(weekly, observedAt, NOW + 7 * 86_400_000)).toBe(false);
	});

	it('uses the length the CLI stated, then the default for a window it cannot size', () => {
		const stated = { window: 'primary', resetsAt: null, windowMinutes: 60 };
		expect(isFleetAgentUsageWindowCurrent(stated, observedAt, Date.parse(observedAt) + 59 * 60_000)).toBe(true);
		expect(isFleetAgentUsageWindowCurrent(stated, observedAt, Date.parse(observedAt) + 60 * 60_000)).toBe(false);
		const unsized = { window: 'secondary', resetsAt: null };
		const limit = FLEET_AGENT_USAGE_DEFAULT_WINDOW_MINUTES * 60_000;
		expect(isFleetAgentUsageWindowCurrent(unsized, observedAt, Date.parse(observedAt) + limit - 1)).toBe(true);
		expect(isFleetAgentUsageWindowCurrent(unsized, observedAt, Date.parse(observedAt) + limit)).toBe(false);
	});

	it('a reading that cannot be dated at all is not current', () => {
		expect(isFleetAgentUsageWindowCurrent({ window: 'weekly', resetsAt: null }, null, NOW)).toBe(false);
		expect(isFleetAgentUsageWindowCurrent({ window: 'weekly', resetsAt: null }, 'whenever', NOW)).toBe(false);
	});
});

describe('the node-level answer is three-state', () => {
	it('an agent is ready only when it is installed AND ready', () => {
		expect(isFleetAgentReady(entry())).toBe(true);
		expect(isFleetAgentReady(entry({ installed: false }))).toBe(false);
		expect(isFleetAgentReady(entry({ installed: null }))).toBe(false);
		for (const status of FLEET_AGENT_READINESS_STATUSES.filter((value) => value !== 'ready')) {
			expect(isFleetAgentReady(entry({ status }))).toBe(false);
		}
	});

	it('every status but ready and unknown is a definite negative', () => {
		for (const status of FLEET_AGENT_READINESS_STATUSES) {
			expect(isFleetAgentDefinitelyUnavailable(entry({ status }))).toBe(
				status !== 'ready' && status !== 'unknown'
			);
		}
	});

	it('true: one ready agent is enough, whatever the others are', () => {
		expect(anyFleetAgentReady([entry({ status: 'access_denied' }), entry({ provider: 'codex' })])).toBe(true);
		expect(anyFleetAgentReady([entry({ status: 'unknown' }), entry({ provider: 'codex' })])).toBe(true);
	});

	it('false: only when EVERY agent has a definite negative verdict', () => {
		expect(anyFleetAgentReady([entry({ status: 'access_denied' }), entry({ status: 'not_signed_in' })])).toBe(
			false
		);
		expect(
			anyFleetAgentReady([
				entry({ status: 'limit_reached' }),
				entry({ provider: 'codex', installed: false, status: 'not_installed' }),
				entry({ provider: 'gemini', status: 'unsupported' })
			])
		).toBe(false);
		// The node said it has no agent CLI at all.
		expect(anyFleetAgentReady([])).toBe(false);
	});

	it('null: unknown is never shown as "cannot"', () => {
		expect(anyFleetAgentReady([entry({ status: 'unknown' })])).toBeNull();
		// One definite negative beside one unknown is still not an answer.
		expect(
			anyFleetAgentReady([entry({ status: 'access_denied' }), entry({ provider: 'codex', status: 'unknown' })])
		).toBeNull();
		// The startup lookup timed out for both CLIs (the reviewer's S5).
		expect(
			anyFleetAgentReady([
				entry({ installed: null, status: 'unknown', reasonCode: 'probe_timed_out' }),
				entry({ provider: 'codex', installed: null, status: 'unknown', reasonCode: 'probe_timed_out' })
			])
		).toBeNull();
	});

	it('serves the stored report with the answer, stamped with the receipt time', () => {
		const view = resolveFleetNodeAgentReadiness({
			at: '2026-11-10T12:00:01.000Z',
			checkedAt: '2026-11-10T12:00:00.000Z',
			agents: [
				entry({ status: 'access_denied', reasonCode: 'org_access_disabled' }),
				entry({ provider: 'codex', installed: false, status: 'not_installed', signedIn: null, account: null })
			]
		});
		expect(view?.at).toBe('2026-11-10T12:00:01.000Z');
		expect(view?.anyReady).toBe(false);
		expect(view?.agents.map((agent) => agent.status)).toEqual(['access_denied', 'not_installed']);
		expect(view?.agents[0]?.reason).toBe(describeFleetAgentReason('org_access_disabled'));
	});

	it('serves null — could not be determined — when the status command did not answer', () => {
		const view = resolveFleetNodeAgentReadiness({
			at: '2026-11-10T12:00:01.000Z',
			checkedAt: '2026-11-10T12:00:00.000Z',
			agents: [
				entry({ signedIn: null, authMethod: 'unknown', status: 'unknown', reasonCode: 'status_unanswered' }),
				entry({ provider: 'codex', installed: false, status: 'not_installed' })
			]
		});
		expect(view?.anyReady).toBeNull();
	});

	it('answers null for a row that holds no report, a junk one, or one with no receipt time', () => {
		expect(resolveFleetNodeAgentReadiness(null)).toBeNull();
		expect(resolveFleetNodeAgentReadiness('{}')).toBeNull();
		expect(resolveFleetNodeAgentReadiness({ at: '2026-11-10T12:00:00.000Z' })).toBeNull();
		expect(resolveFleetNodeAgentReadiness({ checkedAt: '2026-11-10T12:00:00.000Z', agents: [] })).toBeNull();
	});

	it('an agent the platform is throttling is not ready — with the fixed sentence, never the throttle`s own text', () => {
		const stored = { at: '2026-11-10T12:00:01.000Z', checkedAt: '2026-11-10T12:00:00.000Z', agents: [entry()] };
		expect(resolveFleetNodeAgentReadiness(stored)?.anyReady).toBe(true);
		const view = resolveFleetNodeAgentReadiness(stored, {
			throttles: [
				{
					provider: 'claude-code',
					window: 'weekly',
					until: '2026-11-12T02:01:00.000Z',
					// What a run reported, stored by the usage-limit feature: not ours to repeat.
					reason: `You've hit your weekly limit · resets Nov 12, 3am ${FAKE_DB_URL}`,
					since: '2026-11-10T11:59:30.000Z'
				}
			]
		});
		expect(view?.anyReady).toBe(false);
		expect(view?.agents[0]).toMatchObject({
			status: 'limit_reached',
			reasonCode: 'usage_limit',
			reason: 'The weekly limit is reached.',
			limitWindow: 'weekly',
			limitResetsAt: '2026-11-12T02:01:00.000Z'
		});
		expect(JSON.stringify(view)).not.toContain('fakefakepass');
		expect(JSON.stringify(view)).not.toContain('resets Nov 12');
	});

	it('a throttle on one CLI leaves another ready, and never overrides a worse status', () => {
		const view = resolveFleetNodeAgentReadiness(
			{
				at: '2026-11-10T12:00:01.000Z',
				checkedAt: '2026-11-10T12:00:00.000Z',
				agents: [
					entry({ status: 'not_signed_in', reasonCode: 'session_expired' }),
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
		expect(view?.agents[0]).toMatchObject({ status: 'not_signed_in', reasonCode: 'session_expired' });
		expect(view?.anyReady).toBe(true);
	});

	it('drops a usage reading that has rolled over since the node sent it', () => {
		const stored = {
			at: '2026-11-10T12:00:01.000Z',
			checkedAt: '2026-11-10T12:00:00.000Z',
			agents: [
				entry({
					usage: [
						{ window: 'five_hour', usedPercent: 90, resetsAt: '2026-11-10T13:00:00.000Z' },
						{ window: 'weekly', usedPercent: 20, resetsAt: null }
					],
					usageObservedAt: '2026-11-10T11:00:00.000Z'
				})
			]
		};
		expect(resolveFleetNodeAgentReadiness(stored, { now: NOW })?.agents[0]?.usage).toHaveLength(2);
		// After the 5-hour window's reset: only the weekly reading is left.
		expect(resolveFleetNodeAgentReadiness(stored, { now: NOW + 2 * 3_600_000 })?.agents[0]?.usage).toEqual([
			{ window: 'weekly', usedPercent: 20, resetsAt: null }
		]);
		// After a week: nothing, and no "as of" left dangling either.
		const later = resolveFleetNodeAgentReadiness(stored, { now: NOW + 8 * 86_400_000 })?.agents[0];
		expect(later).not.toHaveProperty('usage');
		expect(later).not.toHaveProperty('usageObservedAt');
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

/**
 * PR #3131 review, item 6(b), on the platform's side: a node that went
 * offline leaves its last report behind. Its verdicts must age there too.
 */
describe('resolveFleetNodeAgentReadiness — a served verdict ages, even when the node has stopped beating', () => {
	const RECEIVED = '2026-11-10T12:00:01.000Z';
	const CHECKED = '2026-11-10T12:00:00.000Z';
	const HOUR = 3_600_000;
	const at = (ms: number) => Date.parse(RECEIVED) + ms;
	const base = {
		provider: 'claude-code',
		installed: true,
		version: '2.1.319',
		signedIn: true,
		authMethod: 'subscription',
		account: null,
		checkedAt: CHECKED
	};
	const stored = (agent: Record<string, unknown>) => ({
		at: RECEIVED,
		checkedAt: CHECKED,
		agents: [{ ...base, ...agent }]
	});
	const refused = {
		status: 'access_denied',
		reasonCode: 'org_access_disabled',
		lastFailureAt: '2026-11-10T11:00:00.000Z',
		lastFailureKind: 'access_denied',
		lastFailureCode: 'org_access_disabled'
	};
	const served = (agent: Record<string, unknown>, now: number) =>
		resolveFleetNodeAgentReadiness(stored(agent), { now });

	it('a refusal a run proved stands for 24 hours from the run, then reads unknown with the last failure kept', () => {
		const fresh = served(refused, at(22 * HOUR));
		expect(fresh?.agents[0]).toMatchObject({ status: 'access_denied', reasonCode: 'org_access_disabled' });
		expect(fresh?.anyReady).toBe(false);

		const aged = served(refused, at(24 * HOUR));
		expect(aged?.agents[0]).toMatchObject({
			status: 'unknown',
			reasonCode: 'verdict_stale',
			reason: describeFleetAgentReason('verdict_stale'),
			lastFailureAt: '2026-11-10T11:00:00.000Z',
			lastFailureKind: 'access_denied',
			lastFailureCode: 'org_access_disabled'
		});
		// Not known is not "no agent can work" — and never "ready".
		expect(aged?.anyReady).toBeNull();
		expect(served(refused, at(30 * 24 * HOUR))?.agents[0]?.status).toBe('unknown');
	});

	it('an empty credit balance stands for its hour, then reads unknown — never ready', () => {
		const credit = {
			status: 'limit_reached',
			reasonCode: 'out_of_credit',
			lastFailureAt: '2026-11-10T11:30:00.000Z',
			lastFailureKind: 'limit_reached',
			lastFailureCode: 'out_of_credit'
		};
		expect(served(credit, at(20 * 60_000))?.agents[0]?.status).toBe('limit_reached');
		expect(served(credit, at(HOUR))?.agents[0]).toMatchObject({ status: 'unknown', reasonCode: 'verdict_stale' });
	});

	describe('a usage limit is not a refusal: when it is over the sign-in speaks again (review N3)', () => {
		const named = {
			status: 'limit_reached',
			reasonCode: 'usage_limit',
			limitWindow: 'weekly',
			limitResetsAt: '2026-11-12T03:00:00.000Z',
			lastFailureAt: '2026-11-10T11:30:00.000Z',
			lastFailureKind: 'limit_reached',
			lastFailureCode: 'usage_limit'
		};
		const BEFORE = Date.parse('2026-11-12T02:00:00.000Z');
		const AFTER = Date.parse('2026-11-12T04:00:00.000Z');

		it('stands until the reset it named', () => {
			expect(served(named, BEFORE)?.agents[0]).toMatchObject({
				status: 'limit_reached',
				reasonCode: 'usage_limit',
				limitResetsAt: '2026-11-12T03:00:00.000Z'
			});
		});

		it.each([
			[true, 'ready', null, true],
			[false, 'not_signed_in', 'status_signed_out', false],
			[null, 'unknown', 'status_unanswered', null]
		] as const)('after it, signedIn %j reads %s (%s)', (signedIn, status, reasonCode, anyReady) => {
			const view = served({ ...named, signedIn }, AFTER);
			expect(view?.agents[0]).toMatchObject({ status, reasonCode, reason: describeFleetAgentReason(reasonCode) });
			expect(view?.agents[0]).not.toHaveProperty('limitResetsAt');
			expect(view?.agents[0]).not.toHaveProperty('limitWindow');
			// The last failure is still on record; it is just no longer the status.
			expect(view?.agents[0]?.lastFailureCode).toBe('usage_limit');
			expect(view?.anyReady).toBe(anyReady);
		});

		it('a limit that named no reset is held for its hour, then the same', () => {
			const noReset = { ...named, limitWindow: 'rate', limitResetsAt: undefined };
			expect(served(noReset, at(20 * 60_000))?.agents[0]?.status).toBe('limit_reached');
			expect(served(noReset, at(HOUR))?.agents[0]).toMatchObject({ status: 'ready', reasonCode: null });
			// The node sends the end of its hold as the reset; that is honoured the same way.
			const withHold = { ...noReset, limitResetsAt: '2026-11-10T12:30:00.000Z' };
			expect(served(withHold, at(20 * 60_000))?.agents[0]?.status).toBe('limit_reached');
			expect(served(withHold, at(40 * 60_000))?.agents[0]?.status).toBe('ready');
		});

		it('unless the platform itself is still holding that CLI back: its throttle is the newer evidence', () => {
			const held = resolveFleetNodeAgentReadiness(stored(named), {
				now: AFTER,
				throttles: [
					{
						provider: 'claude-code',
						window: 'weekly',
						until: '2026-11-13T00:00:00.000Z',
						reason: 'not shown',
						since: '2026-11-12T03:30:00.000Z'
					}
				]
			});
			expect(held?.agents[0]).toMatchObject({
				status: 'limit_reached',
				reasonCode: 'usage_limit',
				limitResetsAt: '2026-11-13T00:00:00.000Z'
			});
			expect(held?.anyReady).toBe(false);
		});
	});

	it('what the status command said does not age: it is re-asked, not remembered', () => {
		const signedOut = {
			status: 'not_signed_in',
			reasonCode: 'status_signed_out',
			signedIn: false,
			...{
				lastFailureAt: refused.lastFailureAt,
				lastFailureKind: 'not_signed_in',
				lastFailureCode: 'session_expired'
			}
		};
		expect(served(signedOut, at(30 * 24 * HOUR))?.agents[0]).toMatchObject({
			status: 'not_signed_in',
			reasonCode: 'status_signed_out'
		});
		expect(
			served(
				{ status: 'ready', reasonCode: null, ...{ lastFailureAt: refused.lastFailureAt } },
				at(30 * 24 * HOUR)
			)?.anyReady
		).toBe(true);
	});

	it('ages by the NODE`s clock carried forward, so a machine whose clock is off is not aged early', () => {
		// The node's clock runs 6 hours behind the platform's: its instants are
		// 6 hours "older" than the platform's now, and must not count as age.
		const skewed = {
			at: RECEIVED,
			checkedAt: '2026-11-10T06:00:00.000Z',
			agents: [
				{
					...base,
					...refused,
					checkedAt: '2026-11-10T06:00:00.000Z',
					lastFailureAt: '2026-11-10T05:00:00.000Z'
				}
			]
		};
		// 20 hours after receipt: the run is 21 hours old on the node's clock (27 on the platform's).
		expect(resolveFleetNodeAgentReadiness(skewed, { now: at(20 * HOUR) })?.agents[0]?.status).toBe('access_denied');
		expect(resolveFleetNodeAgentReadiness(skewed, { now: at(24 * HOUR) })?.agents[0]?.status).toBe('unknown');
	});
});

/**
 * PR #3131 second review, N1 (blocker). The masking runs on text a NODE
 * chose (`account`, `version`), synchronously, on the heartbeat's request
 * path, and a body may be a megabyte. Two of its first patterns backtracked
 * quadratically (`a-` × 16 KB took 0.6 s, × 32 KB 2.3 s): one enrolled node
 * could hold the API's event loop for minutes.
 *
 * Two independent bounds now, each pinned here: every node-supplied string
 * is cut to a small window before anything reads it, and every pattern is
 * linear. The budgets are generous (the real figures are well under a
 * millisecond); the old code missed them by three orders of magnitude.
 */
describe('masking and normalising are bounded for any input (review N1)', () => {
	const MEGABYTE = 1024 * 1024;
	/** Inputs that made the old patterns restart inside one long run. */
	const ADVERSARIAL: ReadonlyArray<readonly [string, string]> = [
		['a-', 'word boundaries inside a scheme-shaped run'],
		['a.', 'dotted name run'],
		['a_', 'underscored name run'],
		['a ', 'short words'],
		['key', 'a secret-shaped name, never assigned'],
		['key ', 'secret-shaped names, never assigned'],
		['://a', 'URL openers with no credentials'],
		['://a:b', 'half a URL credential'],
		['eyJaaaaaaaa-', 'token openers with no second segment'],
		['Basic ', 'auth schemes with no value'],
		['sk-', 'key openers'],
		['=', 'separators'],
		['a=', 'empty assignments'],
		['\u0001', 'control characters'],
		[' ', 'whitespace']
	];
	const repeatTo = (unit: string, length: number) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
	/** The fastest of three runs: a timing budget should not fail on one scheduler hiccup. */
	const fastestMs = (run: () => unknown): number => {
		let best = Number.POSITIVE_INFINITY;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const started = performance.now();
			run();
			best = Math.min(best, performance.now() - started);
		}
		return best;
	};
	const BUDGET_MS = 50;

	it.each(ADVERSARIAL)('redactFleetAgentText: 1 MB of %j (%s) returns within the budget', (unit) => {
		const text = repeatTo(unit, MEGABYTE);
		expect(fastestMs(() => redactFleetAgentText(text))).toBeLessThan(BUDGET_MS);
		// And what comes back is bounded too.
		expect(redactFleetAgentText(text).length).toBeLessThanOrEqual(4096 + 64);
	});

	it.each(ADVERSARIAL)(
		'the normaliser: a report whose every string is 1 MB of %j (%s) returns within the budget',
		(unit) => {
			const huge = repeatTo(unit, MEGABYTE);
			const report = {
				checkedAt: huge,
				agents: [
					{
						provider: 'claude-code',
						installed: true,
						version: huge,
						signedIn: true,
						authMethod: huge,
						account: huge,
						status: huge,
						reasonCode: huge,
						reason: huge,
						checkedAt: huge,
						signInCheckedAt: huge,
						limitResetsAt: huge,
						limitWindow: huge,
						usage: [{ window: huge, usedPercent: 10, resetsAt: huge }],
						usageObservedAt: huge,
						lastSuccessAt: huge,
						lastFailureAt: '2026-11-10T12:00:00.000Z',
						lastFailureKind: huge,
						lastFailureCode: huge
					},
					{ provider: huge, installed: true, status: 'ready' }
				]
			};
			// Asserted, not annotated: an annotated `= null` narrows the variable
			// to `null` for the type checker, which cannot see the assignment
			// inside the callback (so `normalised?.agents` would be on `never`).
			let normalised = null as ReturnType<typeof normalizeFleetAgentReadinessReport>;
			expect(fastestMs(() => (normalised = normalizeFleetAgentReadinessReport(report)))).toBeLessThan(BUDGET_MS);
			// One entry survives (the megabyte "provider" is not a token), and nothing of it is long.
			expect(normalised?.agents).toHaveLength(1);
			expect(JSON.stringify(normalised).length).toBeLessThan(2048);
		}
	);

	it('an oversized agents list is truncated before it is walked', () => {
		const agents = Array.from({ length: 200_000 }, (_, index) => ({
			provider: `cli-${index}`,
			installed: true,
			status: 'ready',
			account: 'a-'.repeat(2048)
		}));
		// Asserted, not annotated — see the case above.
		let normalised = null as ReturnType<typeof normalizeFleetAgentReadinessReport>;
		expect(fastestMs(() => (normalised = normalizeFleetAgentReadinessReport({ agents })))).toBeLessThan(BUDGET_MS);
		expect(normalised?.agents.map((agent) => agent.provider)).toEqual(
			Array.from({ length: 8 }, (_, index) => `cli-${index}`)
		);
	});

	it('the old quadratic inputs, at the sizes the review measured, now cost nothing', () => {
		// Review: 8 KB = 0.2 s, 16 KB = 0.6 s, 32 KB = 2.3 s before the fix.
		for (const size of [8_000, 16_000, 32_000]) {
			for (const unit of ['a-', 'a.', 'a ']) {
				const account = repeatTo(unit, size);
				expect(
					fastestMs(() =>
						normalizeFleetAgentReadinessReport({
							agents: [
								{ provider: 'claude-code', installed: true, status: 'ready', account, version: account }
							]
						})
					)
				).toBeLessThan(BUDGET_MS);
			}
		}
	});

	it('cuts BEFORE it masks, without leaving half a secret at the cut', () => {
		// A key that starts inside the 200 characters an account label keeps and
		// runs far past them: it is seen whole by the masking, not cut in two.
		const label = `${'owner@example.com '.repeat(10)}${FAKE_API_KEY}${'FAKE'.repeat(400)} trailing`;
		const account = sanitizeFleetAgentAccount(label);
		expect(Array.from(account ?? '').length).toBeLessThanOrEqual(200);
		expect(account).toContain('[redacted]');
		expect(account).not.toContain('FAKE');

		// Text past the window is dropped, never returned unmasked.
		const tail = `${'word '.repeat(2000)}${FAKE_API_KEY}`;
		expect(redactFleetAgentText(tail)).not.toContain('FAKE');
		expect(sanitizeFleetAgentAccount(tail)).not.toContain('FAKE');
	});

	it('masks the same shapes as before, and a quoted assignment too', () => {
		expect(redactFleetAgentText('{"password":"hunter2-fake"}')).toBe('{"password=[redacted]"}');
		expect(redactFleetAgentText("api_key = 'fake-value-1'")).toBe("api_key=[redacted]'");
		// A name that is not a secret keeps its value.
		expect(redactFleetAgentText('region=eu-west-1 plan: max')).toBe('region=eu-west-1 plan: max');
		expect(redactFleetAgentText('see https://example.com/docs for more')).toBe(
			'see https://example.com/docs for more'
		);
	});

	it('a token that is too long to be one is refused without being read', () => {
		const report = normalizeFleetAgentReadinessReport({
			agents: [
				{ provider: `${' '.repeat(40)}codex${' '.repeat(20)}`, installed: true, status: 'ready' },
				{ provider: 'x'.repeat(200), installed: true, status: 'ready' },
				{
					provider: 'claude-code',
					installed: true,
					status: 'ready',
					usage: [{ window: 'w'.repeat(5000), usedPercent: 5 }]
				}
			]
		});
		expect(report?.agents.map((agent) => agent.provider)).toEqual(['codex', 'claude-code']);
		expect(report?.agents[1]?.usage).toBeUndefined();
	});
});
