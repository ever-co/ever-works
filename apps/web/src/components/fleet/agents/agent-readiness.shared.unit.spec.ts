import { describe, expect, it } from 'vitest';
import {
    FLEET_AGENT_READINESS_STATUSES,
    type FleetAgentReadinessEntry,
    type FleetNodeAgentReadinessView,
} from '@ever-works/contracts';
import {
    AGENT_USAGE_WINDOW_KEYS,
    agentDotClass,
    agentLabelClass,
    agentStatusTone,
    agentUsageBarClass,
    agentUsageBarWidth,
    agentUsageWindowKey,
    formatAgentCost,
    listedAgents,
    nodeAgentsBlocked,
    summarizeNodeAgents,
    untilParts,
} from './agent-readiness.shared';
import en from '../../../../messages/en.json';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');

const agent = (over: Partial<FleetAgentReadinessEntry> = {}): FleetAgentReadinessEntry => ({
    provider: 'claude-code',
    installed: true,
    version: '2.1.319',
    signedIn: true,
    authMethod: 'subscription',
    account: 'owner@example.com (Acme, max)',
    status: 'ready',
    reason: null,
    checkedAt: '2026-11-10T12:00:00.000Z',
    ...over,
});

const readiness = (
    agents: FleetAgentReadinessEntry[],
    anyReady = agents.some((entry) => entry.installed && entry.status === 'ready'),
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

    it('trusts the platform’s answer over the list (a throttle the node has not heard of yet)', () => {
        expect(
            summarizeNodeAgents({
                status: 'online',
                agentReadiness: readiness([agent()], true),
                anyAgentReady: false,
            }),
        ).toBe('none-ready');
    });

    it('falls back to the report’s own answer when the row carries no boolean', () => {
        expect(
            summarizeNodeAgents({ status: 'online', agentReadiness: readiness([agent()], true) }),
        ).toBe('ready');
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
    ]);

    it('compact: installed agents only, in the node’s order', () => {
        expect(listedAgents(report).map((entry) => entry.provider)).toEqual([
            'claude-code',
            'gemini',
        ]);
    });

    it('full: installed first, the not-installed ones last', () => {
        expect(
            listedAgents(report, { includeNotInstalled: true }).map((entry) => entry.provider),
        ).toEqual(['claude-code', 'gemini', 'codex']);
    });

    it('nothing for a node that never reported', () => {
        expect(listedAgents(null)).toEqual([]);
        expect(listedAgents(undefined, { includeNotInstalled: true })).toEqual([]);
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
            'usage',
            'usageLimited',
            'lastSuccess',
            'lastSuccessNever',
        ]) {
            expect(typeof messages[key]).toBe('string');
        }
        expect(Object.keys(group('resetsIn')).sort()).toEqual(['day', 'hour', 'minute', 'soon']);
        expect(Object.keys(group('ago')).sort()).toEqual(['day', 'hour', 'minute', 'second']);
        expect(Object.keys(group('runs')).sort()).toEqual(['cost', 'counts', 'last24h', 'last7d']);
    });
});
