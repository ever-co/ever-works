import type {
    FleetAgentReadinessEntry,
    FleetAgentReadinessStatus,
    FleetAgentUsageWindow,
    FleetNodeAgentReadinessView,
    FleetNodeStatus,
    FleetViewerRole,
} from '@ever-works/contracts';

/**
 * Pure presentation helpers for a computer's agent readiness — the list in
 * the sidebar's "Local runners" popover and on the Fleet Computers page.
 *
 * A `.shared.ts` file (the house convention) so these can be unit-tested and
 * imported from a server or a client component without dragging React or a
 * `server-only` module across the boundary.
 *
 * What they decide, and nothing else: which word and colour a status gets,
 * what the node-level line says, and the coarse "resets in 2h" shape. The
 * facts come from the platform (`FleetNodeView.agentReadiness`,
 * `anyAgentReady`); nothing here re-derives whether an agent can work.
 */

/** How a status is coloured: fine, wait, act, or nothing to say. */
export type AgentTone = 'ok' | 'warn' | 'bad' | 'muted';

/**
 * `ready` is fine; `limit_reached` ends by itself (wait); `not_signed_in` and
 * `access_denied` need a person; the rest are not problems an owner can act
 * on from here.
 */
export function agentStatusTone(status: FleetAgentReadinessStatus): AgentTone {
    switch (status) {
        case 'ready':
            return 'ok';
        case 'limit_reached':
            return 'warn';
        case 'not_signed_in':
        case 'access_denied':
            return 'bad';
        default:
            return 'muted';
    }
}

/** Tailwind class for the status dot of a tone. */
export function agentDotClass(tone: AgentTone): string {
    switch (tone) {
        case 'ok':
            return 'bg-success';
        case 'warn':
            return 'bg-warning';
        case 'bad':
            return 'bg-danger';
        default:
            return 'bg-text-muted dark:bg-text-muted-dark';
    }
}

/** Tailwind class for a status word of a tone (muted and ok read as plain text). */
export function agentLabelClass(tone: AgentTone): string {
    switch (tone) {
        case 'warn':
            return 'text-warning';
        case 'bad':
            return 'text-danger';
        default:
            return 'text-text-muted dark:text-text-muted-dark';
    }
}

/** Usage at which a bar turns amber, and at which it turns red. */
export const AGENT_USAGE_WARN_PERCENT = 75;
export const AGENT_USAGE_FULL_PERCENT = 95;

/** Tailwind class for a usage bar's fill. */
export function agentUsageBarClass(
    window: Pick<FleetAgentUsageWindow, 'usedPercent' | 'limited'>,
): string {
    const used = window.usedPercent ?? 0;
    if (window.limited || used >= AGENT_USAGE_FULL_PERCENT) return 'bg-danger';
    if (used >= AGENT_USAGE_WARN_PERCENT) return 'bg-warning';
    return 'bg-info';
}

/** A usage figure as a bar width, 0-100; null when the CLI gave no figure. */
export function agentUsageBarWidth(
    window: Pick<FleetAgentUsageWindow, 'usedPercent' | 'limited'>,
): number | null {
    if (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) {
        return window.limited ? 100 : null;
    }
    return Math.min(100, Math.max(0, Math.round(window.usedPercent)));
}

/** Usage windows this build has a word for; any other token is shown as it is. */
export const AGENT_USAGE_WINDOW_KEYS = [
    'five_hour',
    'weekly',
    'weekly_opus',
    'weekly_sonnet',
    'overage',
    'primary',
    'secondary',
    'usage',
] as const;

export type AgentUsageWindowKey = (typeof AGENT_USAGE_WINDOW_KEYS)[number];

/** The i18n key of a window, or null when it has none (render the token). */
export function agentUsageWindowKey(window: string): AgentUsageWindowKey | null {
    return (AGENT_USAGE_WINDOW_KEYS as readonly string[]).includes(window)
        ? (window as AgentUsageWindowKey)
        : null;
}

/**
 * What a computer's agents add up to:
 *
 * - `hidden`     — nothing to show: someone else's computer (the report is
 *                  the owner's), a cluster row, or a machine still enrolling;
 * - `unknown`    — the node never reported its agents (an older node
 *                  version): "unknown — update the node", never "none can";
 * - `no-agents`  — it reported, and has no agent CLI installed;
 * - `none-ready` — it has agents, and none can work now;
 * - `ready`      — at least one can.
 */
export type NodeAgentSummary = 'hidden' | 'unknown' | 'no-agents' | 'none-ready' | 'ready';

export interface NodeAgentSummaryInput {
    status: FleetNodeStatus;
    agentReadiness?: FleetNodeAgentReadinessView | null;
    anyAgentReady?: boolean | null;
    viewerRole?: FleetViewerRole;
    persisted?: boolean;
}

export function summarizeNodeAgents(node: NodeAgentSummaryInput): NodeAgentSummary {
    if (node.persisted === false) return 'hidden';
    if (node.viewerRole !== undefined && node.viewerRole !== 'owner') return 'hidden';
    if (node.status === 'enrolling') return 'hidden';
    const readiness = node.agentReadiness;
    if (!readiness) return 'unknown';
    if (!readiness.agents.some((agent) => agent.installed)) return 'no-agents';
    // The platform's answer when it gave one; the list itself otherwise.
    const anyReady =
        typeof node.anyAgentReady === 'boolean' ? node.anyAgentReady : readiness.anyReady === true;
    return anyReady ? 'ready' : 'none-ready';
}

/**
 * True when the computer is ONLINE and no agent on it can work — the case
 * "Online" alone used to hide. An offline or drained computer is not warned
 * about: it takes no work whatever its agents say.
 */
export function nodeAgentsBlocked(node: NodeAgentSummaryInput): boolean {
    if (node.status !== 'online') return false;
    const summary = summarizeNodeAgents(node);
    return summary === 'none-ready' || summary === 'no-agents';
}

/**
 * The agents worth a row: installed ones first, in the order the node sent
 * them. A CLI that is simply not installed is left out of the compact list
 * (it would be noise on every computer) and kept, last, in the full one.
 */
export function listedAgents(
    readiness: Pick<FleetNodeAgentReadinessView, 'agents'> | null | undefined,
    options: { includeNotInstalled?: boolean } = {},
): FleetAgentReadinessEntry[] {
    const agents = readiness?.agents ?? [];
    const installed = agents.filter((agent) => agent.installed);
    if (!options.includeNotInstalled) return installed;
    return [...installed, ...agents.filter((agent) => !agent.installed)];
}

/**
 * Coarse time until an instant, in whole units: `{ unit: 'hour', value: 2 }`.
 *
 * The SHAPE, not a string, so the caller renders it through `next-intl` in
 * the viewer's language. `soon` under a minute; null when the instant is
 * missing, unparseable or already past (a reset that has happened is not
 * announced as coming).
 */
export type UntilParts = { unit: 'minute' | 'hour' | 'day'; value: number } | { unit: 'soon' };

export function untilParts(
    iso: string | null | undefined,
    now: number = Date.now(),
): UntilParts | null {
    if (typeof iso !== 'string' || !iso) return null;
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then) || then <= now) return null;
    const minutes = Math.ceil((then - now) / 60_000);
    if (minutes <= 1) return { unit: 'soon' };
    if (minutes < 60) return { unit: 'minute', value: minutes };
    if (minutes < 48 * 60) return { unit: 'hour', value: Math.round(minutes / 60) };
    return { unit: 'day', value: Math.round(minutes / (24 * 60)) };
}

/** Cents as dollars with two decimals (`310` → `$3.10`); null for a non-number. */
export function formatAgentCost(cents: number | null | undefined): string | null {
    if (typeof cents !== 'number' || !Number.isFinite(cents) || cents < 0) return null;
    return `$${(cents / 100).toFixed(2)}`;
}
