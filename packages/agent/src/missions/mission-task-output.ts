/**
 * APW-08 T34 (FR-51…FR-55) — a Mission's OUTPUT: whether its tick files Ideas (as every Mission
 * did before P2), Tasks on its attached App or Repository Works, or both, and the bounds of the
 * Task output.
 *
 * `missions.taskOutput` is `simple-json`, so whatever is stored is read back through
 * {@link normalizeMissionTaskOutput} on every use: a value out of bounds, of the wrong type or
 * missing falls back to the default (plan §3.3: "fails toward the defaults"). A mode that is not
 * one of the three reads as `ideas` — the Mission before P2.
 *
 * A leaf: no Nest, no TypeORM. Its only imports are the Work-kind vocabulary
 * (`@ever-works/contracts`) and the Task-isolation leaf, so the tick and the write path decide
 * "can this Mission file Tasks on that Work" with one function.
 */

import { isAppWorkKind, workKindDeliversTasksAsPullRequests } from '@ever-works/contracts';
import { resolveTaskIsolation } from '../tasks-domain/task-isolation';

export const MISSION_OUTPUT_MODES = ['ideas', 'tasks', 'both'] as const;
export type MissionOutputMode = (typeof MISSION_OUTPUT_MODES)[number];

/** The default mode: the Mission before APW-08 P2. */
export const DEFAULT_MISSION_OUTPUT_MODE: MissionOutputMode = 'ideas';

/** Tasks one tick may file per Work (plan §3.3). */
export const MISSION_TASKS_PER_TICK = { min: 1, max: 3, default: 1 } as const;
/** Open Tasks a Mission may have on one Work before it files no more (plan §3.3). */
export const MISSION_OPEN_TASKS_CAP = { min: 1, max: 10, default: 3 } as const;

/** The relations under which a Mission files Tasks on a Work (FR-51). */
export const MISSION_TASK_OUTPUT_RELATIONS = ['improves', 'operates'] as const;

/**
 * The warning a write answers when Task output has no Work to file on (plan §5, S27): no App or
 * Repository Work is attached as Improves or Operates.
 *
 * The code on the wire stays `noAppWorkRelation` — it predates Repository Works being eligible,
 * and the web card, the API specs and the e2e suite all match on the string — but its meaning
 * is the general one above. A Repository Work that IS attached but cannot take Tasks answers
 * {@link MISSION_REPO_WORK_ISOLATION_OFF} instead, because the fix is a different one.
 */
export const MISSION_NO_APP_WORK_RELATION = 'noAppWorkRelation';

/**
 * The warning a write answers when a Repository Work is attached as Improves or Operates but its
 * Task isolation is off. A Task on a Repository Work only becomes a branch and a pull request
 * while that setting is on, and the Mission never turns it on by itself, so it files nothing on
 * that Work until its owner does.
 */
export const MISSION_REPO_WORK_ISOLATION_OFF = 'repoWorkTaskIsolationOff';

/**
 * The warning a write answers when an attached Repository Work (isolation on) would get no Task
 * because the Agent its Tasks would run with — the Mission's Task output Agent, else the Work's
 * only Agent — may not both commit and open pull requests, or no single Agent resolves. Such a
 * run would change nothing (no workspace) or end with a pushed branch and no pull request.
 */
export const MISSION_REPO_WORK_AGENT_CANNOT_OPEN_PULL_REQUESTS =
    'repoWorkAgentCannotOpenPullRequests';

/**
 * The warning a write answers when an attached Repository Work's effective merge policy lets
 * agents merge their own pull requests and the Mission has not opted in
 * (`taskOutput.allowAgentMerge: true`): its unattended Tasks are not filed or started there.
 */
export const MISSION_REPO_WORK_ALLOWS_AGENT_MERGE = 'repoWorkAllowsAgentMerge';

export interface MissionTaskOutput {
    tasksPerTick: number;
    openTasksCap: number;
    /** The Agent the filed Tasks are dispatched to; absent = the Work's default Agent. */
    agentId?: string;
    /**
     * Set over the API only (no form): the Mission's Tasks on a Repository Work may run under a
     * merge policy that lets agents merge their own pull requests. Absent = not allowed: such a
     * Work gets no Task (`repoWorkAllowsAgentMerge`). Kept only when exactly `true`; a template
     * manifest can never set it (`sanitizeTemplateTaskOutput`).
     */
    allowAgentMerge?: true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMissionOutputMode(value: unknown): value is MissionOutputMode {
    return typeof value === 'string' && (MISSION_OUTPUT_MODES as readonly string[]).includes(value);
}

/** A stored mode, read without trusting it: anything else is `ideas`. */
export function normalizeMissionOutputMode(raw: unknown): MissionOutputMode {
    return isMissionOutputMode(raw) ? raw : DEFAULT_MISSION_OUTPUT_MODE;
}

/** Does this mode file Tasks on the Mission's App or Repository Works? */
export function missionFilesTasks(mode: unknown): boolean {
    const normalized = normalizeMissionOutputMode(mode);
    return normalized === 'tasks' || normalized === 'both';
}

function boundedInt(
    raw: unknown,
    bounds: { readonly min: number; readonly max: number; readonly default: number },
): number {
    if (typeof raw !== 'number' || !Number.isInteger(raw)) return bounds.default;
    if (raw < bounds.min || raw > bounds.max) return bounds.default;
    return raw;
}

/**
 * The Task output of a Mission, read without trusting the column: each field in bounds or its
 * default, an `agentId` kept only when it is a uuid, `allowAgentMerge` only when exactly `true`.
 * A non-object is the defaults.
 */
export function normalizeMissionTaskOutput(raw: unknown): MissionTaskOutput {
    const input =
        raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {};
    const agentId =
        typeof input.agentId === 'string' && UUID.test(input.agentId.trim())
            ? input.agentId.trim().toLowerCase()
            : undefined;
    const output: MissionTaskOutput = {
        tasksPerTick: boundedInt(input.tasksPerTick, MISSION_TASKS_PER_TICK),
        openTasksCap: boundedInt(input.openTasksCap, MISSION_OPEN_TASKS_CAP),
    };
    if (agentId) output.agentId = agentId;
    if (input.allowAgentMerge === true) output.allowAgentMerge = true;
    return output;
}

/** The part of a `mission_works` row (hydrated with its Work) the Task output reads. */
export interface MissionTaskOutputWorkRow {
    workId?: string | null;
    relation: string;
    workKind?: string | null;
    /** The Work's `taskIsolation` setting (`worktree` = on). */
    workTaskIsolation?: string | null;
}

/**
 * The FIRST, static half of whether a Mission's Task output files Tasks on one attached Work —
 * what the relation row alone can say:
 *
 *   - `eligible` — attached as Improves or Operates, of a kind whose Tasks are delivered as pull
 *     requests (`app`, `repo`), and the Work's own setting isolates its Tasks;
 *   - `isolation-off` — the same, except that the Work's Task isolation is off, so a Task there
 *     would run with no branch and open no pull request. Only a Repository Work can be here: an
 *     App Work's Tasks are always isolated. Nothing is filed on it, and nothing turns the
 *     setting on for the owner;
 *   - `not-applicable` — another relation or another kind: never a target, exactly as before.
 *
 * What this guarantees: the Work's setting, asked through `resolveTaskIsolation` with a Work and
 * no per-Task override (how a Mission-filed Task is created). What it does NOT see is the Agent:
 * the worker also turns isolation off for an Agent that may not commit, and opens no pull request
 * for one that may not open them. For a Repository Work that second half is asked before the
 * planner runs — `TaskTransitionService.missionRepoRunRefusal`, with the Agent dispatch will
 * resolve — and again at dispatch, so `eligible` here is necessary, not sufficient.
 */
export type MissionTaskOutputEligibility = 'eligible' | 'isolation-off' | 'not-applicable';

export function missionTaskOutputEligibility(
    row: MissionTaskOutputWorkRow,
): MissionTaskOutputEligibility {
    if (!(MISSION_TASK_OUTPUT_RELATIONS as readonly string[]).includes(row.relation)) {
        return 'not-applicable';
    }
    const kind = row.workKind ?? null;
    if (!workKindDeliversTasksAsPullRequests(kind)) return 'not-applicable';
    const isolation = resolveTaskIsolation(
        { workId: row.workId || 'attached-work' },
        { kind, taskIsolation: row.workTaskIsolation ?? null },
    );
    return isolation === 'on' ? 'eligible' : 'isolation-off';
}

/**
 * The warnings a write answers for a Mission that files Tasks, from its attached Works:
 * {@link MISSION_NO_APP_WORK_RELATION} when none is an App or Repository Work attached as
 * Improves or Operates; {@link MISSION_REPO_WORK_ISOLATION_OFF} when a Repository Work is, with
 * its Task isolation off. Never both: a Repository Work that is attached is not "no Work".
 */
export function missionTaskOutputWarnings(rows: readonly MissionTaskOutputWorkRow[]): string[] {
    const verdicts = rows.map((row) => missionTaskOutputEligibility(row));
    if (verdicts.includes('isolation-off')) return [MISSION_REPO_WORK_ISOLATION_OFF];
    return verdicts.includes('eligible') ? [] : [MISSION_NO_APP_WORK_RELATION];
}

/**
 * `EVER_WORKS_APP_CHANGES_ENABLED` is the operator's switch for App Work changes only (APW-08
 * T49, R-30): every other reader of it asks "is this an App Work?" first. So while it is off, a
 * Mission files nothing on its App Works and keeps filing on its Repository Works.
 */
export function missionTaskOutputPausedBySwitch(
    row: Pick<MissionTaskOutputWorkRow, 'workKind'>,
    appChangesEnabled: boolean,
): boolean {
    return !appChangesEnabled && isAppWorkKind(row.workKind ?? null);
}
