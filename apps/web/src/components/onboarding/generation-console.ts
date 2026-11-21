import { GenerateStatusType } from '@/lib/api/enums';
import type { GenerateStatus, GenerationStepLog } from '@/lib/api/types-only';
import { ROUTES } from '@/lib/constants';

/**
 * The onboarding generation console — what the visitor sees after pressing
 * "Generate now".
 *
 * Two sources feed it, both already in the platform:
 *
 *  1. The quick-create request itself (`POST /api/works/quick-create`). It
 *     creates the Work and its repositories and then starts the generation, so
 *     it can take a while and reports nothing until it returns. The console
 *     says what is happening and how long it has been going.
 *  2. The Work's `generateStatus` once the Work exists — the same object the
 *     Work page polls every few seconds (`getWorkForStatusRefresh`): current
 *     step, progress, items made, warnings, the pipeline's `recentLogs` and
 *     the final error.
 *
 * This file is the I/O-free half: a reducer that turns those events into the
 * lines on screen, plus the routing and error-hint helpers.
 */

export type ConsolePhase =
    | 'idle'
    | 'starting'
    | 'start-failed'
    | 'generating'
    | 'generated'
    | 'failed'
    | 'cancelled';

export type ConsoleTone = 'info' | 'step' | 'success' | 'warn' | 'error' | 'muted';

export interface ConsoleLine {
    /** Stable React key; also the dedupe key for pipeline log entries. */
    readonly key: string;
    /** ISO timestamp the line refers to. */
    readonly at: string;
    readonly tone: ConsoleTone;
    readonly text: string;
    /** `platform` for lines this console writes, else the pipeline log's source. */
    readonly source: 'platform' | GenerationStepLog['source'];
}

export interface StartedWork {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
}

export interface ConsoleState {
    readonly phase: ConsolePhase;
    readonly lines: readonly ConsoleLine[];
    readonly startedAt?: string;
    /** When the attempt ended (refused, generated, failed, cancelled); stops the clock. */
    readonly endedAt?: string;
    readonly work?: StartedWork;
    readonly step?: { readonly name: string; readonly index: number; readonly total?: number };
    readonly progress?: number;
    readonly itemsProcessed?: number;
    readonly error?: string;
    /** Consecutive status polls that came back empty. */
    readonly failedPolls: number;
    /** Attempts made in this console (a retry is the second). */
    readonly attempts: number;
}

export type ConsoleEvent =
    | { readonly type: 'start'; readonly at: string }
    | { readonly type: 'started'; readonly work: StartedWork; readonly at: string }
    | { readonly type: 'startFailed'; readonly message: string; readonly at: string }
    | { readonly type: 'status'; readonly status: Partial<GenerateStatus>; readonly at: string }
    | { readonly type: 'pollFailed'; readonly at: string };

export const INITIAL_CONSOLE_STATE: ConsoleState = {
    phase: 'idle',
    lines: [],
    failedPolls: 0,
    attempts: 0,
};

/** Polls in a row that may fail before the console says it lost contact. */
const POLL_FAILURES_BEFORE_WARNING = 3;
/** The feed keeps this many lines; the Work page has the full history. */
const MAX_LINES = 300;

const TERMINAL_PHASES: ReadonlySet<ConsolePhase> = new Set(['generated', 'failed', 'cancelled']);

const LOG_TONES: Record<string, ConsoleTone> = {
    error: 'error',
    warn: 'warn',
    debug: 'muted',
    info: 'info',
};

export function isTerminalPhase(phase: ConsolePhase): boolean {
    return TERMINAL_PHASES.has(phase);
}

export function consoleReducer(state: ConsoleState, event: ConsoleEvent): ConsoleState {
    switch (event.type) {
        case 'start': {
            const attempt = state.attempts + 1;
            const lines = [
                ...(attempt > 1
                    ? [line(event.at, 'muted', 'Trying again…', attempt, 'retry')]
                    : []),
                line(event.at, 'info', 'Checking your prompt and your setup', attempt, 'check'),
                line(
                    event.at,
                    'info',
                    'Creating your Work and its Git repository — this can take up to a minute',
                    attempt,
                    'create',
                ),
            ];
            return {
                ...state,
                phase: 'starting',
                startedAt: event.at,
                endedAt: undefined,
                error: undefined,
                // A retry is a new run: the last run's position means nothing.
                step: undefined,
                progress: undefined,
                itemsProcessed: undefined,
                failedPolls: 0,
                attempts: attempt,
                lines: append(state.lines, lines),
            };
        }
        case 'started':
            return {
                ...state,
                phase: 'generating',
                work: event.work,
                lines: append(state.lines, [
                    line(
                        event.at,
                        'success',
                        `Work "${event.work.name}" created`,
                        state.attempts,
                        'created',
                    ),
                    line(event.at, 'success', 'Generation started', state.attempts, 'gen-started'),
                    line(
                        event.at,
                        'muted',
                        'Waiting for the generator to pick up the job…',
                        state.attempts,
                        'waiting',
                    ),
                ]),
            };
        case 'startFailed':
            return {
                ...state,
                phase: 'start-failed',
                error: event.message,
                endedAt: event.at,
                lines: append(state.lines, [
                    line(event.at, 'error', event.message, state.attempts, 'start-failed'),
                ]),
            };
        case 'pollFailed': {
            if (isTerminalPhase(state.phase)) return state;
            const failedPolls = state.failedPolls + 1;
            const warn =
                failedPolls === POLL_FAILURES_BEFORE_WARNING
                    ? [
                          line(
                              event.at,
                              'warn',
                              "Can't reach the server right now — still trying. Your Work keeps generating either way.",
                              state.attempts,
                              `poll-lost-${state.lines.length}`,
                          ),
                      ]
                    : [];
            return { ...state, failedPolls, lines: append(state.lines, warn) };
        }
        case 'status':
            return applyStatus(state, event.status, event.at);
        default:
            return state;
    }
}

function applyStatus(
    state: ConsoleState,
    status: Partial<GenerateStatus>,
    at: string,
): ConsoleState {
    if (isTerminalPhase(state.phase) || !state.work) return state;

    const seen = new Set(state.lines.map((entry) => entry.key));
    const added: ConsoleLine[] = [];
    const push = (entry: ConsoleLine) => {
        if (seen.has(entry.key)) return;
        seen.add(entry.key);
        added.push(entry);
    };

    let step = state.step;
    const stepName = status.stepName || status.step;
    if (stepName && typeof status.stepIndex === 'number') {
        const total = status.totalSteps && status.totalSteps > 0 ? status.totalSteps : undefined;
        step = { name: stepName, index: status.stepIndex, total };
        // Dated by the pipeline's own "step started" entry when it sent one,
        // so the marker sits with that step's log lines rather than at the
        // moment the poll noticed it.
        const stepStartedAt = status.recentLogs?.find(
            (log) => log?.event === 'step_started' && log.stepIndex === status.stepIndex,
        )?.timestamp;
        push({
            key: `step:${state.attempts}:${status.stepIndex}:${stepName}`,
            at: stepStartedAt || at,
            tone: 'step',
            source: 'platform',
            text: formatStep(step),
        });
    } else if (stepName) {
        step = { name: stepName, index: state.step?.index ?? 0, total: state.step?.total };
        push({
            key: `step:${state.attempts}:${stepName}`,
            at,
            tone: 'step',
            source: 'platform',
            text: stepName,
        });
    }

    for (const log of status.recentLogs ?? []) {
        if (!log?.message) continue;
        push({
            key: `log:${log.timestamp}:${log.event}:${log.message}`,
            at: log.timestamp || at,
            tone: LOG_TONES[log.level] ?? 'info',
            source: log.source,
            text: log.message,
        });
    }

    for (const warning of status.warnings ?? []) {
        if (!warning) continue;
        push({
            key: `warning:${state.attempts}:${warning}`,
            at,
            tone: 'warn',
            source: 'platform',
            text: warning,
        });
    }

    let phase: ConsolePhase = state.phase;
    let progress =
        typeof status.progress === 'number' ? clampPercent(status.progress) : state.progress;
    let error = state.error;
    switch (status.status) {
        case GenerateStatusType.GENERATED:
            phase = 'generated';
            progress = 100;
            push({
                key: `done:${state.attempts}`,
                at,
                tone: 'success',
                source: 'platform',
                text: 'Done — your Work is generated. Opening it now…',
            });
            break;
        case GenerateStatusType.ERROR:
            phase = 'failed';
            error = status.error || 'The generation stopped with an error.';
            push({
                key: `failed:${state.attempts}`,
                at,
                tone: 'error',
                source: 'platform',
                text: `Generation failed: ${error}`,
            });
            break;
        case GenerateStatusType.CANCELLED:
            phase = 'cancelled';
            push({
                key: `cancelled:${state.attempts}`,
                at,
                tone: 'warn',
                source: 'platform',
                text: 'Generation was cancelled.',
            });
            break;
        default:
            break;
    }

    return {
        ...state,
        phase,
        endedAt: isTerminalPhase(phase) ? at : state.endedAt,
        step,
        progress,
        itemsProcessed:
            typeof status.itemsProcessed === 'number'
                ? status.itemsProcessed
                : state.itemsProcessed,
        error,
        failedPolls: 0,
        lines: append(state.lines, inTimeOrder(added)),
    };
}

/**
 * One poll can bring log lines from several steps plus the current step's
 * marker. Ordered by time within the batch (stable, so equal times keep their
 * order); the lines already on screen are never moved.
 */
function inTimeOrder(lines: ConsoleLine[]): ConsoleLine[] {
    const time = (entry: ConsoleLine) => {
        const ms = Date.parse(entry.at);
        return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
    };
    return [...lines].sort((a, b) => time(a) - time(b));
}

export function formatStep(step: { name: string; index: number; total?: number }): string {
    return step.total ? `Step ${step.index + 1} of ${step.total}: ${step.name}` : step.name;
}

function line(
    at: string,
    tone: ConsoleTone,
    text: string,
    attempt: number,
    id: string,
): ConsoleLine {
    return { key: `platform:${attempt}:${id}`, at, tone, text, source: 'platform' };
}

function append(
    lines: readonly ConsoleLine[],
    added: readonly ConsoleLine[],
): readonly ConsoleLine[] {
    if (added.length === 0) return lines;
    const next = [...lines, ...added];
    return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
}

function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, Math.round(value)));
}

// ─── What to do next ─────────────────────────────────────────────────────────

export type NextStepAction = 'retry' | 'open-work' | 'plugins' | 'dashboard';

export interface NextSteps {
    readonly hint: string;
    readonly actions: readonly NextStepAction[];
}

/**
 * The guidance shown under an error. The API's own message is always shown in
 * full above it; this only adds what the visitor can do about it.
 */
export function nextStepsFor(message: string | undefined, phase: ConsolePhase): NextSteps {
    if (phase === 'failed') {
        return {
            hint: 'Your Work was created, but its generation stopped. Open the Work to read the full log and start the generation again from its Generator tab — or try again here.',
            actions: ['open-work', 'retry'],
        };
    }
    if (phase === 'cancelled') {
        return {
            hint: 'The generation was cancelled. Open the Work to start it again from its Generator tab.',
            actions: ['open-work', 'retry'],
        };
    }
    const text = message ?? '';
    if (/not configured|providers? (?:is|are) not available/i.test(text)) {
        return {
            hint: 'A provider this Work needs is not set up yet. Set it up in Settings → Plugins, then press Try again — your prompt stays here.',
            actions: ['plugins', 'retry'],
        };
    }
    if (/quota|active works/i.test(text)) {
        return {
            hint: 'You have reached the number of active Works your account allows. Open the dashboard to remove a Work you no longer need, then try again.',
            actions: ['dashboard'],
        };
    }
    if (/captcha/i.test(text)) {
        return {
            hint: 'We could not verify this browser. Reload the page and try again.',
            actions: ['retry'],
        };
    }
    if (/too many requests|throttl/i.test(text)) {
        return {
            hint: 'Too many attempts in a short time. Wait a minute, then try again.',
            actions: ['retry'],
        };
    }
    return {
        hint: 'Nothing is lost — your prompt is still here. Try again; if it keeps failing, open the dashboard and create the Work from there.',
        actions: ['retry', 'dashboard'],
    };
}

// ─── Routing ─────────────────────────────────────────────────────────────────

/**
 * Where "Open your Work" lands. While the generation runs (or after it
 * failed) that is the Generator tab: it shows the live progress and its log,
 * and after a failure the form to start again. Once the content exists, the
 * Work's overview.
 */
export function workLandingHref(workId: string, status: string | undefined): string {
    const id = encodeURIComponent(workId);
    return status === GenerateStatusType.GENERATED
        ? ROUTES.DASHBOARD_WORK(id)
        : ROUTES.DASHBOARD_WORK_GENERATOR(id);
}

export function formatElapsed(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
