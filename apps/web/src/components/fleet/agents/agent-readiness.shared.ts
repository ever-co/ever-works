import {
    FLEET_AGENT_REASON_CODES,
    anyFleetAgentReady,
    isFleetAgentUsageWindowCurrent,
} from '@ever-works/contracts';
import type {
    FleetAgentFailureKind,
    FleetAgentReadinessEntry,
    FleetAgentReadinessStatus,
    FleetAgentReasonCode,
    FleetAgentUsageWindow,
    FleetModelUsageLimitWindow,
    FleetNodeAgentReadinessView,
    FleetNodeRunStats,
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
 * The usage windows of an agent that still describe its seat, with when they
 * were observed.
 *
 * A reading is a snapshot: "82% used" from a run six hours ago says nothing
 * about a five-hour window now. A window that names its reset is shown until
 * then; one that names none is shown for its own length after it was
 * observed (the platform's rule, {@link isFleetAgentUsageWindowCurrent}). The
 * platform drops stale windows when it serves the view; this covers the time
 * a page stays open after that.
 */
export function currentAgentUsage(
    agent: Pick<FleetAgentReadinessEntry, 'usage' | 'usageObservedAt'>,
    now: number = Date.now(),
): { windows: FleetAgentUsageWindow[]; observedAt: string | null } {
    const observedAt = typeof agent.usageObservedAt === 'string' ? agent.usageObservedAt : null;
    const windows = (agent.usage ?? []).filter((window) =>
        isFleetAgentUsageWindowCurrent(window, observedAt, now),
    );
    return { windows, observedAt: windows.length > 0 ? observedAt : null };
}

/**
 * What a computer's agents add up to:
 *
 * - `hidden`       — nothing to show: someone else's computer (the report is
 *                    the owner's), a cluster row, or a machine still enrolling;
 * - `unknown`      — the node never reported its agents (an older node
 *                    version): "unknown — update the node", never "none can";
 * - `undetermined` — it reported, no agent is ready, and at least one could
 *                    not be judged (a status command that did not answer, a
 *                    lookup that timed out, a refusal too old to still call
 *                    the status). Said neutrally: not known is not "cannot";
 * - `no-agents`    — it reported, and has no agent CLI installed, for certain;
 * - `none-ready`   — it has agents, and every one has a definite reason it
 *                    cannot work now;
 * - `ready`        — at least one can.
 */
export type NodeAgentSummary =
    | 'hidden'
    | 'unknown'
    | 'undetermined'
    | 'no-agents'
    | 'none-ready'
    | 'ready';

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
    // The platform's three-state answer when the row carries one (it knows
    // about a throttle the node has not heard of yet); the report's own
    // otherwise; and only for a view that carries neither, the same rule the
    // platform applies, over the list.
    const answer =
        node.anyAgentReady !== undefined
            ? node.anyAgentReady
            : readiness.anyReady !== undefined
              ? readiness.anyReady
              : anyFleetAgentReady(readiness.agents);
    if (answer === true) return 'ready';
    if (answer === null) return 'undetermined';
    return readiness.agents.some((agent) => agent.installed === true) ? 'none-ready' : 'no-agents';
}

/**
 * True when the computer is ONLINE and it is CERTAIN no agent on it can work
 * — the case "Online" alone used to hide. An offline or drained computer is
 * not warned about: it takes no work whatever its agents say. Neither is one
 * whose agents could not be judged: that gets a neutral line, not a warning.
 */
export function nodeAgentsBlocked(node: NodeAgentSummaryInput): boolean {
    if (node.status !== 'online') return false;
    const summary = summarizeNodeAgents(node);
    return summary === 'none-ready' || summary === 'no-agents';
}

/**
 * The agents worth a row, in the order the node sent them.
 *
 * A CLI that is, for certain, not installed is left out of the compact list
 * (it would be noise on every computer) and kept, last, in the full one.
 * Every other row stays in both — in particular one the node could not judge
 * (`installed: null`, a lookup that timed out): it is the row that explains
 * why the computer's answer is "not known".
 */
export function listedAgents(
    readiness: Pick<FleetNodeAgentReadinessView, 'agents'> | null | undefined,
    options: { includeNotInstalled?: boolean } = {},
): FleetAgentReadinessEntry[] {
    const agents = readiness?.agents ?? [];
    const absent = (agent: FleetAgentReadinessEntry) =>
        agent.status === 'not_installed' || agent.installed === false;
    const shown = agents.filter((agent) => !absent(agent));
    if (!options.includeNotInstalled) return shown;
    return [...shown, ...agents.filter(absent)];
}

/**
 * The reason code of an agent when this build has a sentence for it, else
 * null (the caller then shows the platform's own English sentence).
 *
 * A reason is a CODE on the wire; the sentence is chosen here, in the
 * viewer's language. Nothing an agent run printed is ever part of it.
 */
export function agentReasonKey(code: string | null | undefined): FleetAgentReasonCode | null {
    return typeof code === 'string' &&
        (FLEET_AGENT_REASON_CODES as readonly string[]).includes(code)
        ? (code as FleetAgentReasonCode)
        : null;
}

/** The windows a usage limit can name; anything else reads as the general one. */
export const AGENT_LIMIT_WINDOW_KEYS = ['weekly', 'session', 'daily', 'rate', 'usage'] as const;

export function agentLimitWindowKey(window: string | null | undefined): FleetModelUsageLimitWindow {
    return (AGENT_LIMIT_WINDOW_KEYS as readonly string[]).includes(window ?? '')
        ? (window as FleetModelUsageLimitWindow)
        : 'usage';
}

/**
 * What to say about the last run an agent refused, beside its status:
 *
 * - `seen` — the status IS that refusal (a run proved it): say how long ago
 *   it was last seen, so a verdict from this morning does not read like one
 *   from this minute;
 * - `last` — the status has aged to `unknown` (no run since): keep the last
 *   failure and its time in view, so "unknown" still says what to look at.
 *
 * Null when there is nothing to add — no refusal recorded, or an agent that
 * is ready again.
 */
export interface AgentFailureNote {
    mode: 'seen' | 'last';
    at: string;
    kind: FleetAgentFailureKind | null;
    code: FleetAgentReasonCode | null;
    /**
     * `seen` only: a run found the CLI not signed in, and the CLI's own
     * status command has said "signed in" SINCE. The owner may well have
     * signed in again with the same account — which looks identical to the
     * node, so the verdict stands until a run succeeds — and the line says
     * so: the refusal was seen before the latest sign-in check.
     */
    beforeSignInCheck: boolean;
}

export function agentFailureNote(
    agent: Pick<
        FleetAgentReadinessEntry,
        'status' | 'reasonCode' | 'lastFailureAt' | 'lastFailureKind' | 'lastFailureCode'
    > &
        Partial<Pick<FleetAgentReadinessEntry, 'signedIn' | 'checkedAt'>>,
): AgentFailureNote | null {
    const at = typeof agent.lastFailureAt === 'string' ? agent.lastFailureAt : '';
    const failedAt = at ? new Date(at).getTime() : Number.NaN;
    if (!Number.isFinite(failedAt)) return null;
    const checkedAt =
        typeof agent.checkedAt === 'string' ? new Date(agent.checkedAt).getTime() : NaN;
    const note = (mode: AgentFailureNote['mode']): AgentFailureNote => ({
        mode,
        at,
        kind: agent.lastFailureKind ?? null,
        code: agentReasonKey(agent.lastFailureCode),
        beforeSignInCheck:
            mode === 'seen' &&
            agent.status === 'not_signed_in' &&
            agent.signedIn === true &&
            Number.isFinite(checkedAt) &&
            checkedAt > failedAt,
    });
    const refused =
        agent.status === 'not_signed_in' ||
        agent.status === 'access_denied' ||
        agent.status === 'limit_reached';
    // The status came from that run only when it carries the run's own code
    // (a `not_signed_in` the status command reported has a different one).
    if (refused && agent.reasonCode && agent.reasonCode === agent.lastFailureCode) {
        return note('seen');
    }
    if (agent.status === 'unknown' && agent.reasonCode === 'verdict_stale') return note('last');
    return null;
}

/**
 * Whether a window of run statistics is a FLOOR ("2000+"). A capped read
 * kept the newest jobs, so the 7-day figures always are; the 24-hour figures
 * are only when every job it kept was that recent.
 */
export function runStatsAreFloor(stats: FleetNodeRunStats, window: 'last24h' | 'last7d'): boolean {
    if (stats.capped !== true) return false;
    return window === 'last7d' || stats.last24h.runs >= stats.last7d.runs;
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
