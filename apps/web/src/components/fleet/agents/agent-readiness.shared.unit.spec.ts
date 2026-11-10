import { describe, expect, it } from 'vitest';
import {
    FLEET_AGENT_READINESS_STATUSES,
    FLEET_AGENT_REASON_CODES,
    describeFleetAgentReason,
    resolveFleetNodeAgentReadiness,
    type FleetAgentReadinessEntry,
    type FleetNodeAgentReadinessView,
} from '@ever-works/contracts';
import {
    AGENT_LIMIT_WINDOW_KEYS,
    AGENT_USAGE_WINDOW_KEYS,
    agentDotClass,
    agentFailureNote,
    agentLabelClass,
    agentLimitWindowKey,
    agentReasonKey,
    agentStatusTone,
    agentUsageBarClass,
    agentUsageBarWidth,
    agentUsageWindowKey,
    currentAgentUsage,
    formatAgentCost,
    listedAgents,
    nodeAgentsBlocked,
    runStatsAreFloor,
    summarizeNodeAgents,
    untilParts,
} from './agent-readiness.shared';
import en from '../../../../messages/en.json';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const HOUR = 3_600_000;

const agent = (over: Partial<FleetAgentReadinessEntry> = {}): FleetAgentReadinessEntry => ({
    provider: 'claude-code',
    installed: true,
    version: '2.1.319',
    signedIn: true,
    authMethod: 'subscription',
    account: 'owner@example.com (Acme, max)',
    status: 'ready',
    reasonCode: null,
    reason: null,
    checkedAt: '2026-11-10T12:00:00.000Z',
    ...over,
});

/** A CLI the node could not judge: its startup lookup timed out. */
const timedOut = (provider = 'claude-code') =>
    agent({
        provider,
        installed: null,
        version: null,
        signedIn: null,
        authMethod: 'unknown',
        account: null,
        status: 'unknown',
        reasonCode: 'probe_timed_out',
        reason: describeFleetAgentReason('probe_timed_out'),
    });

const readiness = (
    agents: FleetAgentReadinessEntry[],
    anyReady: boolean | null = agents.some(
        (entry) => entry.installed === true && entry.status === 'ready',
    ),
): FleetNodeAgentReadinessView => ({
    at: '2026-11-10T12:00:01.000Z',
    checkedAt: '2026-11-10T12:00:00.000Z',
    agents,
    anyReady,
});

describe('agentStatusTone', () => {
    it.each([
        ['ready', 'ok'],
        ['limit_reached', 'warn'],
        ['not_signed_in', 'bad'],
        ['access_denied', 'bad'],
        ['not_installed', 'muted'],
        ['unsupported', 'muted'],
        ['unknown', 'muted'],
    ] as const)('%s → %s', (status, tone) => {
        expect(agentStatusTone(status)).toBe(tone);
    });

    it('gives every tone a dot and a label class', () => {
        expect(agentDotClass('ok')).toBe('bg-success');
        expect(agentDotClass('warn')).toBe('bg-warning');
        expect(agentDotClass('bad')).toBe('bg-danger');
        expect(agentDotClass('muted')).toContain('bg-text-muted');
        expect(agentLabelClass('warn')).toBe('text-warning');
        expect(agentLabelClass('bad')).toBe('text-danger');
        expect(agentLabelClass('ok')).toContain('text-text-muted');
    });
});

describe('summarizeNodeAgents', () => {
    it('ready when at least one agent can work', () => {
        expect(
            summarizeNodeAgents({
                status: 'online',
                agentReadiness: readiness([
                    agent({ status: 'access_denied' }),
                    agent({ provider: 'codex' }),
                ]),
                anyAgentReady: true,
            }),
        ).toBe('ready');
    });

    it('none-ready when it has agents and none can work — the case "Online" used to hide', () => {
        const node = {
            status: 'online' as const,
            agentReadiness: readiness([agent({ status: 'access_denied' })]),
            anyAgentReady: false,
        };
        expect(summarizeNodeAgents(node)).toBe('none-ready');
        expect(nodeAgentsBlocked(node)).toBe(true);
    });

    it('no-agents when it reported and has no agent CLI installed', () => {
        const node = {
            status: 'online' as const,
            agentReadiness: readiness([
                agent({ installed: false, status: 'not_installed', version: null }),
            ]),
            anyAgentReady: false,
        };
        expect(summarizeNodeAgents(node)).toBe('no-agents');
        expect(nodeAgentsBlocked(node)).toBe(true);
        expect(
            summarizeNodeAgents({
                status: 'online',
                agentReadiness: readiness([]),
                anyAgentReady: false,
            }),
        ).toBe('no-agents');
    });

    it('unknown — never "none can" — when the node never reported (an older node version)', () => {
        for (const agentReadiness of [null, undefined]) {
            const node = { status: 'online' as const, agentReadiness, anyAgentReady: null };
            expect(summarizeNodeAgents(node)).toBe('unknown');
            expect(nodeAgentsBlocked(node)).toBe(false);
        }
    });

    describe('undetermined — it reported, and it is still not known (review item 5)', () => {
        it('a startup lookup that timed out on every CLI: neutral, never the "no agent can work" warning', () => {
            // Review S5, end to end over the platform's own resolution: what a
            // node whose PATH lookups timed out reports, as the API serves it.
            const view = resolveFleetNodeAgentReadiness(
                {
                    at: '2026-11-10T12:00:01.000Z',
                    checkedAt: '2026-11-10T12:00:00.000Z',
                    agents: [timedOut('claude-code'), timedOut('codex')],
                },
                { now: NOW },
            );
            expect(view?.anyReady).toBeNull();
            const node = {
                status: 'online' as const,
                agentReadiness: view,
                anyAgentReady: view?.anyReady,
            };
            expect(summarizeNodeAgents(node)).toBe('undetermined');
            expect(nodeAgentsBlocked(node)).toBe(false);
            // The compact views keep the rows that explain it.
            expect(listedAgents(view).map((entry) => entry.provider)).toEqual([
                'claude-code',
                'codex',
            ]);
        });

        it('one agent unknown and the other not installed: still not "no agent CLI is installed"', () => {
            const node = {
                status: 'online' as const,
                agentReadiness: readiness(
                    [
                        agent({ status: 'unknown', reasonCode: 'status_unanswered' }),
                        agent({ provider: 'codex', installed: false, status: 'not_installed' }),
                    ],
                    null,
                ),
                anyAgentReady: null,
            };
            expect(summarizeNodeAgents(node)).toBe('undetermined');
            expect(nodeAgentsBlocked(node)).toBe(false);
        });

        it('a refusal that has aged to unknown is undetermined too, not red for ever', () => {
            const node = {
                status: 'online' as const,
                agentReadiness: readiness(
                    [agent({ status: 'unknown', reasonCode: 'verdict_stale' })],
                    null,
                ),
                anyAgentReady: null,
            };
            expect(summarizeNodeAgents(node)).toBe('undetermined');
            expect(nodeAgentsBlocked(node)).toBe(false);
        });
    });

    it('trusts the platform’s answer over the list (a throttle the node has not heard of yet)', () => {
        expect(
            summarizeNodeAgents({
                status: 'online',
                agentReadiness: readiness([agent()], true),
                anyAgentReady: false,
            }),
        ).toBe('none-ready');
    });

    it('falls back to the report’s own answer when the row carries none', () => {
        expect(
            summarizeNodeAgents({ status: 'online', agentReadiness: readiness([agent()], true) }),
        ).toBe('ready');
        expect(
            summarizeNodeAgents({
                status: 'online',
                agentReadiness: readiness([agent({ status: 'unknown' })], null),
            }),
        ).toBe('undetermined');
    });

    it('applies the platform’s rule to the list for a view that carries no answer at all', () => {
        const bare = (agents: FleetAgentReadinessEntry[]) =>
            ({
                at: '2026-11-10T12:00:01.000Z',
                checkedAt: '2026-11-10T12:00:00.000Z',
                agents,
            }) as unknown as FleetNodeAgentReadinessView;
        expect(summarizeNodeAgents({ status: 'online', agentReadiness: bare([agent()]) })).toBe(
            'ready',
        );
        expect(
            summarizeNodeAgents({
                status: 'online',
                agentReadiness: bare([agent({ status: 'not_signed_in' })]),
            }),
        ).toBe('none-ready');
        expect(
            summarizeNodeAgents({
                status: 'online',
                agentReadiness: bare([agent({ status: 'unknown' })]),
            }),
        ).toBe('undetermined');
    });

    it('hidden for someone else’s computer, a cluster row and one still enrolling', () => {
        const report = readiness([agent({ status: 'access_denied' })]);
        expect(
            summarizeNodeAgents({
                status: 'online',
                agentReadiness: report,
                viewerRole: 'org-member',
            }),
        ).toBe('hidden');
        expect(
            summarizeNodeAgents({ status: 'online', agentReadiness: null, persisted: false }),
        ).toBe('hidden');
        expect(summarizeNodeAgents({ status: 'enrolling', agentReadiness: null })).toBe('hidden');
        expect(
            summarizeNodeAgents({ status: 'online', agentReadiness: report, viewerRole: 'owner' }),
        ).toBe('none-ready');
    });

    it.each(['offline', 'paused', 'disabled'] as const)(
        'does not warn about a %s computer: it takes no work whatever its agents say',
        (status) => {
            const node = {
                status,
                agentReadiness: readiness([agent({ status: 'not_signed_in' })]),
                anyAgentReady: false,
            };
            expect(summarizeNodeAgents(node)).toBe('none-ready');
            expect(nodeAgentsBlocked(node)).toBe(false);
        },
    );
});

describe('listedAgents', () => {
    const report = readiness([
        agent({ provider: 'codex', installed: false, status: 'not_installed' }),
        agent(),
        agent({ provider: 'gemini', status: 'unsupported' }),
        timedOut('opencode'),
    ]);

    it('compact: everything but the CLIs that are, for certain, not installed — in the node’s order', () => {
        expect(listedAgents(report).map((entry) => entry.provider)).toEqual([
            'claude-code',
            'gemini',
            // `installed: null`: the row that explains "not known" is kept.
            'opencode',
        ]);
    });

    it('full: the not-installed ones last', () => {
        expect(
            listedAgents(report, { includeNotInstalled: true }).map((entry) => entry.provider),
        ).toEqual(['claude-code', 'gemini', 'opencode', 'codex']);
    });

    it('nothing for a node that never reported', () => {
        expect(listedAgents(null)).toEqual([]);
        expect(listedAgents(undefined, { includeNotInstalled: true })).toEqual([]);
    });
});

describe('agentReasonKey / agentLimitWindowKey', () => {
    it('knows every code the contract declares, and nothing else', () => {
        for (const code of FLEET_AGENT_REASON_CODES) expect(agentReasonKey(code)).toBe(code);
        for (const other of [null, undefined, '', 'a_code_from_the_future', 'Not logged in']) {
            expect(agentReasonKey(other)).toBeNull();
        }
    });

    it('reads any window it does not know as the general one', () => {
        expect(agentLimitWindowKey('weekly')).toBe('weekly');
        expect(agentLimitWindowKey('session')).toBe('session');
        for (const other of [null, undefined, '', 'monthly']) {
            expect(agentLimitWindowKey(other)).toBe('usage');
        }
    });
});

describe('agentFailureNote — a verdict carries its age (review item 6)', () => {
    const at = new Date(NOW - 3 * HOUR).toISOString();

    it('a status a run proved is "seen": the refusal and how long ago', () => {
        expect(
            agentFailureNote(
                agent({
                    status: 'access_denied',
                    reasonCode: 'org_access_disabled',
                    lastFailureAt: at,
                    lastFailureKind: 'access_denied',
                    lastFailureCode: 'org_access_disabled',
                }),
            ),
        ).toEqual({ mode: 'seen', at, kind: 'access_denied', code: 'org_access_disabled' });
    });

    it('a status that aged to unknown keeps the last failure in view', () => {
        expect(
            agentFailureNote(
                agent({
                    status: 'unknown',
                    reasonCode: 'verdict_stale',
                    lastFailureAt: at,
                    lastFailureKind: 'limit_reached',
                    lastFailureCode: 'out_of_credit',
                }),
            ),
        ).toEqual({ mode: 'last', at, kind: 'limit_reached', code: 'out_of_credit' });
    });

    it('says nothing when the status is not that run’s: ready again, or the status command’s own word', () => {
        const refused = {
            lastFailureAt: at,
            lastFailureKind: 'not_signed_in' as const,
            lastFailureCode: 'session_expired',
        };
        expect(agentFailureNote(agent({ status: 'ready', ...refused }))).toBeNull();
        expect(
            agentFailureNote(
                agent({ status: 'not_signed_in', reasonCode: 'status_signed_out', ...refused }),
            ),
        ).toBeNull();
        expect(
            agentFailureNote(
                agent({ status: 'unknown', reasonCode: 'status_unanswered', ...refused }),
            ),
        ).toBeNull();
    });

    it('says nothing without a readable instant, and reads an unknown code as none', () => {
        expect(
            agentFailureNote(agent({ status: 'access_denied', reasonCode: 'permission_denied' })),
        ).toBeNull();
        expect(
            agentFailureNote(
                agent({
                    status: 'unknown',
                    reasonCode: 'verdict_stale',
                    lastFailureAt: 'yesterday-ish',
                }),
            ),
        ).toBeNull();
        expect(
            agentFailureNote(
                agent({
                    status: 'unknown',
                    reasonCode: 'verdict_stale',
                    lastFailureAt: at,
                    lastFailureCode: 'a_code_from_the_future',
                }),
            ),
        ).toEqual({ mode: 'last', at, kind: null, code: null });
    });
});

describe('untilParts', () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();

    it.each([
        [30_000, { unit: 'soon' }],
        [5 * 60_000, { unit: 'minute', value: 5 }],
        [59 * 60_000, { unit: 'minute', value: 59 }],
        [2 * 3_600_000, { unit: 'hour', value: 2 }],
        [47 * 3_600_000, { unit: 'hour', value: 47 }],
        [3 * 86_400_000, { unit: 'day', value: 3 }],
    ])('%d ms ahead → %j', (ahead, expected) => {
        expect(untilParts(at(ahead), NOW)).toEqual(expected);
    });

    it('null for a reset that has passed, is missing or cannot be read', () => {
        expect(untilParts(at(-60_000), NOW)).toBeNull();
        expect(untilParts(at(0), NOW)).toBeNull();
        expect(untilParts(null, NOW)).toBeNull();
        expect(untilParts('', NOW)).toBeNull();
        expect(untilParts('soon', NOW)).toBeNull();
    });
});

describe('usage bars', () => {
    it('colours by how full the window is, and red once the CLI says it is exhausted', () => {
        expect(agentUsageBarClass({ usedPercent: 10 })).toBe('bg-info');
        expect(agentUsageBarClass({ usedPercent: 80 })).toBe('bg-warning');
        expect(agentUsageBarClass({ usedPercent: 97 })).toBe('bg-danger');
        expect(agentUsageBarClass({ usedPercent: 40, limited: true })).toBe('bg-danger');
    });

    it('width is the figure, bounded; a limit with no figure is a full bar; no figure is no bar', () => {
        expect(agentUsageBarWidth({ usedPercent: 42.4 })).toBe(42);
        expect(agentUsageBarWidth({ usedPercent: 140 })).toBe(100);
        expect(agentUsageBarWidth({ usedPercent: -3 })).toBe(0);
        expect(agentUsageBarWidth({ usedPercent: null, limited: true })).toBe(100);
        expect(agentUsageBarWidth({ usedPercent: null })).toBeNull();
    });

    it('names the windows it knows and leaves any other token to be shown as it is', () => {
        expect(agentUsageWindowKey('five_hour')).toBe('five_hour');
        expect(agentUsageWindowKey('weekly')).toBe('weekly');
        expect(agentUsageWindowKey('monthly_enterprise')).toBeNull();
    });
});

describe('currentAgentUsage — a reading has an age, and an end (review item 8)', () => {
    const observedAt = new Date(NOW - 2 * HOUR).toISOString();
    const usage = [
        // Names its reset: shown until then.
        { window: 'weekly', usedPercent: 40, resetsAt: new Date(NOW + 24 * HOUR).toISOString() },
        // Names none: shown for its own length after it was observed.
        { window: 'five_hour', usedPercent: 82, resetsAt: null, windowMinutes: 300 },
    ];

    it('keeps the windows that still describe the seat, with when they were observed', () => {
        expect(currentAgentUsage({ usage, usageObservedAt: observedAt }, NOW)).toEqual({
            windows: usage,
            observedAt,
        });
    });

    it('drops a window with no reset once its own length has passed since it was observed', () => {
        const later = NOW + 4 * HOUR; // six hours after the reading
        expect(
            currentAgentUsage({ usage, usageObservedAt: observedAt }, later).windows.map(
                (window) => window.window,
            ),
        ).toEqual(['weekly']);
    });

    it('drops a window whose reset has passed, and one that cannot be dated at all', () => {
        expect(currentAgentUsage({ usage, usageObservedAt: observedAt }, NOW + 48 * HOUR)).toEqual({
            windows: [],
            observedAt: null,
        });
        expect(
            currentAgentUsage(
                { usage: [{ window: 'five_hour', usedPercent: 82, resetsAt: null }] },
                NOW,
            ),
        ).toEqual({ windows: [], observedAt: null });
        expect(currentAgentUsage({}, NOW)).toEqual({ windows: [], observedAt: null });
    });
});

describe('runStatsAreFloor', () => {
    const stats = (runs24h: number, runs7d: number, capped?: boolean) => ({
        last24h: { runs: runs24h, failed: 0, costCents: 0 },
        last7d: { runs: runs7d, failed: 0, costCents: 0 },
        ...(capped === undefined ? {} : { capped }),
    });

    it('never for an uncapped read', () => {
        expect(runStatsAreFloor(stats(5, 9), 'last7d')).toBe(false);
        expect(runStatsAreFloor(stats(5, 9, false), 'last24h')).toBe(false);
    });

    it('a capped read: the 7-day figures always, the 24-hour ones only when every counted job was that recent', () => {
        expect(runStatsAreFloor(stats(300, 2000, true), 'last7d')).toBe(true);
        expect(runStatsAreFloor(stats(300, 2000, true), 'last24h')).toBe(false);
        expect(runStatsAreFloor(stats(2000, 2000, true), 'last24h')).toBe(true);
    });
});

describe('formatAgentCost', () => {
    it('cents as dollars', () => {
        expect(formatAgentCost(310)).toBe('$3.10');
        expect(formatAgentCost(0)).toBe('$0.00');
        expect(formatAgentCost(null)).toBeNull();
        expect(formatAgentCost(-1)).toBeNull();
        expect(formatAgentCost(Number.NaN)).toBeNull();
    });
});

/**
 * The words exist. `t(\`status.${status}\` as never)` is not type-checked, so
 * a status the contract adds without a message would render as a raw key.
 */
describe('fleet.agents messages (en.json)', () => {
    const messages = en.fleet.agents as Record<string, unknown>;
    const group = (name: string) => messages[name] as Record<string, string>;

    it('has a word for every status the contract declares', () => {
        expect(Object.keys(group('status')).sort()).toEqual(
            [...FLEET_AGENT_READINESS_STATUSES].sort(),
        );
    });

    it('has a sentence for every reason code — the same one the platform builds, so the two never drift', () => {
        expect(Object.keys(group('reason')).sort()).toEqual([...FLEET_AGENT_REASON_CODES].sort());
        for (const code of FLEET_AGENT_REASON_CODES) {
            if (code === 'usage_limit') continue;
            expect(group('reason')[code]).toBe(describeFleetAgentReason(code));
        }
        // The one sentence with a variable part: the window, a token of a closed set.
        expect(Object.keys(group('limitWindow')).sort()).toEqual(
            [...AGENT_LIMIT_WINDOW_KEYS].sort(),
        );
        for (const window of AGENT_LIMIT_WINDOW_KEYS) {
            expect(
                group('reason').usage_limit.replace('{window}', group('limitWindow')[window]),
            ).toBe(describeFleetAgentReason('usage_limit', { window }));
        }
    });

    it('has a word for every sign-in method and every usage window the list names', () => {
        expect(Object.keys(group('authMethod')).sort()).toEqual(
            ['access_token', 'api_key', 'cloud_provider', 'none', 'subscription', 'unknown'].sort(),
        );
        expect(Object.keys(group('window')).sort()).toEqual([...AGENT_USAGE_WINDOW_KEYS].sort());
    });

    it('has every other key the component asks for', () => {
        for (const key of [
            'title',
            'noneReady',
            'noneInstalledOnline',
            'noneInstalled',
            'unknown',
            'undetermined',
            'usage',
            'usageLimited',
            'usageAsOf',
            'lastSuccess',
            'lastSuccessNever',
            'lastSeen',
            'lastFailure',
        ]) {
            expect(typeof messages[key]).toBe('string');
        }
        expect(Object.keys(group('resetsIn')).sort()).toEqual(['day', 'hour', 'minute', 'soon']);
        expect(Object.keys(group('ago')).sort()).toEqual(['day', 'hour', 'minute', 'second']);
        expect(Object.keys(group('runs')).sort()).toEqual([
            'cost',
            'counts',
            'countsFloor',
            'last24h',
            'last7d',
        ]);
    });

    it('the neutral line does not read like the warning', () => {
        expect(messages.undetermined).not.toBe(messages.noneReady);
        expect(String(messages.undetermined)).not.toMatch(/no agent can work/i);
    });
});
