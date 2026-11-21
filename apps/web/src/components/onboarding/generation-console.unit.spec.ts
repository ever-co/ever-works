import { describe, expect, it } from 'vitest';
import type { GenerateStatus } from '@/lib/api/types-only';
import {
    INITIAL_CONSOLE_STATE,
    consoleReducer,
    formatElapsed,
    isTerminalPhase,
    MAX_FAILED_POLLS,
    nextPollDelay,
    nextStepsFor,
    workLandingHref,
    type ConsoleState,
} from './generation-console';

const T0 = '2026-11-21T10:00:00.000Z';
const T1 = '2026-11-21T10:00:05.000Z';
const T2 = '2026-11-21T10:00:10.000Z';

const WORK = { id: 'w-1', slug: 'ai-robots', name: 'AI robots directory' };

function started(): ConsoleState {
    const afterStart = consoleReducer(INITIAL_CONSOLE_STATE, { type: 'start', at: T0 });
    return consoleReducer(afterStart, { type: 'started', work: WORK, at: T1 });
}

function status(partial: Partial<GenerateStatus>): GenerateStatus {
    return { status: 'generating', ...partial } as GenerateStatus;
}

function texts(state: ConsoleState): string[] {
    return state.lines.map((line) => line.text);
}

describe('consoleReducer — the quick-create request', () => {
    it('says what the platform is doing while the Work is being created', () => {
        const state = consoleReducer(INITIAL_CONSOLE_STATE, { type: 'start', at: T0 });

        expect(state.phase).toBe('starting');
        expect(state.startedAt).toBe(T0);
        expect(texts(state).join('\n')).toMatch(/creating your work/i);
        expect(texts(state).join('\n')).toMatch(/repository/i);
    });

    it('records the created Work and that generation has started', () => {
        const state = started();

        expect(state.phase).toBe('generating');
        expect(state.work).toEqual(WORK);
        const joined = texts(state).join('\n');
        expect(joined).toContain('AI robots directory');
        expect(joined).toMatch(/generation started/i);
        expect(state.lines.some((line) => line.tone === 'success')).toBe(true);
    });

    it('keeps the API refusal verbatim and marks it as an error', () => {
        const afterStart = consoleReducer(INITIAL_CONSOLE_STATE, { type: 'start', at: T0 });
        const message =
            'One or more selected providers are not available.\nSearch: Provider "tavily" is not configured.';
        const state = consoleReducer(afterStart, { type: 'startFailed', message, at: T1 });

        expect(state.phase).toBe('start-failed');
        expect(state.error).toBe(message);
        expect(state.work).toBeUndefined();
        expect(state.lines.at(-1)).toMatchObject({ tone: 'error', text: message });
    });

    it('starts a retry from a clean step and progress', () => {
        const failed = consoleReducer(started(), {
            type: 'status',
            status: status({
                status: 'error' as GenerateStatus['status'],
                stepName: 'Search the web',
                stepIndex: 2,
                totalSteps: 15,
                progress: 20,
                itemsProcessed: 4,
                error: 'boom',
            }),
            at: T1,
        });
        const retried = consoleReducer(failed, { type: 'start', at: T2 });

        expect(retried.step).toBeUndefined();
        expect(retried.progress).toBeUndefined();
        expect(retried.itemsProcessed).toBeUndefined();
        expect(retried.endedAt).toBeUndefined();
    });

    it('keeps the earlier attempt in the feed when the visitor tries again', () => {
        const failed = consoleReducer(
            consoleReducer(INITIAL_CONSOLE_STATE, { type: 'start', at: T0 }),
            { type: 'startFailed', message: 'boom', at: T1 },
        );
        const retried = consoleReducer(failed, { type: 'start', at: T2 });

        expect(retried.phase).toBe('starting');
        expect(retried.error).toBeUndefined();
        expect(texts(retried)).toContain('boom');
        expect(texts(retried).join('\n')).toMatch(/trying again/i);
    });
});

describe('consoleReducer — live generation status', () => {
    it('adds one line per pipeline step, with its position', () => {
        let state = started();
        state = consoleReducer(state, {
            type: 'status',
            status: status({
                step: 'prompt',
                stepName: 'Process prompt',
                stepIndex: 0,
                totalSteps: 15,
            }),
            at: T1,
        });
        // The same step polled again adds nothing.
        state = consoleReducer(state, {
            type: 'status',
            status: status({
                step: 'prompt',
                stepName: 'Process prompt',
                stepIndex: 0,
                totalSteps: 15,
            }),
            at: T2,
        });
        state = consoleReducer(state, {
            type: 'status',
            status: status({
                step: 'items',
                stepName: 'Generate items',
                stepIndex: 5,
                totalSteps: 15,
            }),
            at: T2,
        });

        const stepLines = state.lines.filter((line) => line.tone === 'step');
        expect(stepLines.map((line) => line.text)).toEqual([
            'Step 1 of 15: Process prompt',
            'Step 6 of 15: Generate items',
        ]);
        expect(state.step).toEqual({ name: 'Generate items', index: 5, total: 15 });
    });

    it('dates a step by the pipeline’s own "step started" entry, so the feed stays in order', () => {
        const stepStarted = {
            timestamp: '2026-11-21T10:00:03.000Z',
            level: 'info' as const,
            source: 'pipeline' as const,
            stepIndex: 2,
            stepName: 'Search the web',
            event: 'step_started' as const,
            message: 'Started: Search the web',
        };
        const state = consoleReducer(started(), {
            type: 'status',
            status: status({
                stepName: 'Search the web',
                stepIndex: 2,
                totalSteps: 15,
                recentLogs: [stepStarted],
            }),
            at: T2,
        });

        const stepLine = state.lines.find((line) => line.tone === 'step');
        expect(stepLine?.at).toBe(stepStarted.timestamp);
    });

    it('keeps earlier steps’ log lines before the current step’s marker', () => {
        const log = (
            second: number,
            stepIndex: number,
            event: 'step_started' | 'message',
            message: string,
        ) => ({
            timestamp: `2026-11-21T10:00:0${second}.000Z`,
            level: 'info' as const,
            source: 'pipeline' as const,
            stepIndex,
            event,
            message,
        });
        const state = consoleReducer(started(), {
            type: 'status',
            status: status({
                stepName: 'Search the web',
                stepIndex: 1,
                totalSteps: 15,
                recentLogs: [
                    log(6, 0, 'message', 'Prompt parsed'),
                    log(7, 1, 'step_started', 'Started: Search the web'),
                    log(8, 1, 'message', 'Found 64 sources'),
                ],
            }),
            at: T2,
        });

        const fromPoll = texts(state).slice(-4);
        expect(fromPoll).toEqual([
            'Prompt parsed',
            'Step 2 of 15: Search the web',
            'Started: Search the web',
            'Found 64 sources',
        ]);
    });

    it('streams the pipeline log without repeating entries it already shows', () => {
        const log = {
            timestamp: '2026-11-21T10:00:06.000Z',
            level: 'info' as const,
            source: 'pipeline' as const,
            event: 'message' as const,
            message: 'Searching the web for AI robot companies',
        };
        const warn = {
            ...log,
            timestamp: '2026-11-21T10:00:07.000Z',
            level: 'warn' as const,
            message: 'Search slow',
        };
        let state = consoleReducer(started(), {
            type: 'status',
            status: status({ recentLogs: [log] }),
            at: T1,
        });
        state = consoleReducer(state, {
            type: 'status',
            status: status({ recentLogs: [log, warn] }),
            at: T2,
        });

        const logLines = state.lines.filter((line) => line.source === 'pipeline');
        expect(logLines.map((line) => line.text)).toEqual([
            'Searching the web for AI robot companies',
            'Search slow',
        ]);
        expect(logLines.map((line) => line.tone)).toEqual(['info', 'warn']);
        expect(logLines[0].at).toBe(log.timestamp);
    });

    it('shows each degraded-service warning once', () => {
        let state = consoleReducer(started(), {
            type: 'status',
            status: status({ warnings: ['Screenshots are disabled'] }),
            at: T1,
        });
        state = consoleReducer(state, {
            type: 'status',
            status: status({ warnings: ['Screenshots are disabled'] }),
            at: T2,
        });

        expect(texts(state).filter((text) => text === 'Screenshots are disabled')).toHaveLength(1);
    });

    it('tracks progress and the number of items made so far', () => {
        const state = consoleReducer(started(), {
            type: 'status',
            status: status({ progress: 42.4, itemsProcessed: 17 }),
            at: T1,
        });

        expect(state.progress).toBe(42);
        expect(state.itemsProcessed).toBe(17);
    });

    it('finishes on a generated status', () => {
        const state = consoleReducer(started(), {
            type: 'status',
            status: status({ status: 'generated' as GenerateStatus['status'] }),
            at: T2,
        });

        expect(state.phase).toBe('generated');
        expect(state.progress).toBe(100);
        expect(state.lines.at(-1)?.tone).toBe('success');
    });

    it('reports a failed generation with the pipeline error', () => {
        const state = consoleReducer(started(), {
            type: 'status',
            status: status({
                status: 'error' as GenerateStatus['status'],
                error: 'AI provider timed out',
            }),
            at: T2,
        });

        expect(state.phase).toBe('failed');
        expect(state.error).toBe('AI provider timed out');
        expect(state.lines.at(-1)).toMatchObject({ tone: 'error' });
        expect(state.lines.at(-1)?.text).toContain('AI provider timed out');
    });

    it('reports a cancelled generation', () => {
        const state = consoleReducer(started(), {
            type: 'status',
            status: status({ status: 'cancelled' as GenerateStatus['status'] }),
            at: T2,
        });

        expect(state.phase).toBe('cancelled');
    });

    it('ignores a status that arrives after the run has ended', () => {
        const done = consoleReducer(started(), {
            type: 'status',
            status: status({ status: 'generated' as GenerateStatus['status'] }),
            at: T2,
        });
        const late = consoleReducer(done, {
            type: 'status',
            status: status({ stepName: 'Late step', stepIndex: 3, totalSteps: 15 }),
            at: T2,
        });

        expect(late).toBe(done);
    });

    it('says once that the server is unreachable after repeated failed polls, then recovers', () => {
        let state = started();
        for (let i = 0; i < 5; i += 1) {
            state = consoleReducer(state, { type: 'pollFailed', at: T2 });
        }
        const warnings = state.lines.filter((line) => /can.t reach/i.test(line.text));
        expect(warnings).toHaveLength(1);

        state = consoleReducer(state, { type: 'status', status: status({}), at: T2 });
        expect(state.failedPolls).toBe(0);
    });
});

describe('consoleReducer — when the status can no longer be read', () => {
    it.each([
        ['unauthenticated', /session/i],
        ['not-found', /can no longer be found/i],
    ] as const)('stops following on %s and says why', (reason, text) => {
        const state = consoleReducer(started(), { type: 'pollStopped', reason, at: T2 });

        expect(state.phase).toBe('lost');
        expect(state.stopReason).toBe(reason);
        expect(isTerminalPhase(state.phase)).toBe(true);
        expect(state.error).toMatch(text);
        expect(state.endedAt).toBe(T2);
        expect(state.lines.at(-1)?.tone).toBe('warn');
    });

    it('stops following after too many failed reads in a row', () => {
        let state = started();
        for (let i = 0; i < MAX_FAILED_POLLS - 1; i += 1) {
            state = consoleReducer(state, { type: 'pollFailed', at: T2 });
        }
        expect(state.phase).toBe('generating');

        state = consoleReducer(state, { type: 'pollFailed', at: T2 });
        expect(state.phase).toBe('lost');
        expect(state.stopReason).toBe('unreachable');
    });

    it('ignores statuses once it stopped following', () => {
        const lost = consoleReducer(started(), {
            type: 'pollStopped',
            reason: 'unauthenticated',
            at: T2,
        });
        expect(consoleReducer(lost, { type: 'status', status: status({}), at: T2 })).toBe(lost);
    });

    it('lets "Try again" start over after it stopped following', () => {
        const lost = consoleReducer(started(), {
            type: 'pollStopped',
            reason: 'not-found',
            at: T2,
        });
        const retried = consoleReducer(lost, { type: 'start', at: T2 });

        expect(retried.phase).toBe('starting');
        expect(retried.stopReason).toBeUndefined();
        expect(retried.failedPolls).toBe(0);
    });
});

describe('nextPollDelay — backing off while the server does not answer', () => {
    it('polls at the base rate while reads succeed or have failed only a couple of times', () => {
        expect(nextPollDelay(0, 3_000)).toBe(3_000);
        expect(nextPollDelay(2, 3_000)).toBe(3_000);
    });

    it('doubles the wait from the third failure in a row, up to 30 s', () => {
        expect(nextPollDelay(3, 3_000)).toBe(6_000);
        expect(nextPollDelay(4, 3_000)).toBe(12_000);
        expect(nextPollDelay(5, 3_000)).toBe(24_000);
        expect(nextPollDelay(6, 3_000)).toBe(30_000);
        expect(nextPollDelay(9, 3_000)).toBe(30_000);
    });
});

describe('nextStepsFor — what to do after an error', () => {
    it('points at Settings → Plugins when a provider is not configured', () => {
        const next = nextStepsFor(
            'One or more selected providers are not available.\nSearch: Provider "tavily" is not configured.',
            'start-failed',
        );
        expect(next.hint).toMatch(/settings → plugins/i);
        expect(next.actions).toEqual(['plugins', 'retry']);
    });

    it('explains the active-Works limit', () => {
        const next = nextStepsFor(
            'You have reached the deploy quota of 3 active Works',
            'start-failed',
        );
        expect(next.hint).toMatch(/active works/i);
        expect(next.actions).toContain('dashboard');
        expect(next.actions).not.toContain('retry');
    });

    it('sends a failed browser check to Try again, which runs the check again', () => {
        const next = nextStepsFor('captcha verification failed', 'start-failed');
        // The hand-off was already removed from the URL, so a reload would
        // lose the prompt; "Try again" fetches a fresh check token instead.
        expect(next.hint).not.toMatch(/reload/i);
        expect(next.hint).toMatch(/try again/i);
        expect(next.actions).toEqual(['retry']);
    });

    it.each([
        'Not available in the demo — sign up to use it',
        'The free demo AI quota is used up for today — sign up on app.ever.works to keep going',
        'This demo workspace has used all its free AI requests — sign up on app.ever.works to keep going',
    ])('treats a demo limit as a limit, not something to retry: %s', (message) => {
        const next = nextStepsFor(message, 'start-failed');
        expect(next.hint).toMatch(/demo/i);
        expect(next.hint).toMatch(/sign up/i);
        expect(next.actions).not.toContain('retry');
    });

    it.each([
        'The demo AI is busy — try again in a few seconds',
        'The demo AI model is temporarily unavailable — please try again later',
    ])('asks for a short wait on a busy demo AI: %s', (message) => {
        const next = nextStepsFor(message, 'start-failed');
        expect(next.hint).toMatch(/wait/i);
        expect(next.actions).toEqual(['retry']);
    });

    it('asks a visitor whose session ended to sign in again', () => {
        const next = nextStepsFor(undefined, 'lost', 'unauthenticated');
        expect(next.hint).toMatch(/sign in/i);
        expect(next.actions).toEqual(['sign-in']);
    });

    it('sends a visitor whose Work is gone to the dashboard', () => {
        const next = nextStepsFor(undefined, 'lost', 'not-found');
        expect(next.actions).toEqual(['dashboard']);
    });

    it('offers the Work and the dashboard when the server stays unreachable', () => {
        const next = nextStepsFor(undefined, 'lost', 'unreachable');
        expect(next.hint).toMatch(/keeps running/i);
        expect(next.actions).toEqual(['open-work', 'dashboard']);
    });

    it('asks the visitor to wait after a rate limit', () => {
        expect(nextStepsFor('ThrottlerException: Too Many Requests', 'start-failed').hint).toMatch(
            /wait/i,
        );
    });

    it('sends a failed generation to the Work, where it can be started again', () => {
        const next = nextStepsFor('AI provider timed out', 'failed');
        expect(next.hint).toMatch(/generator/i);
        expect(next.actions).toEqual(['open-work', 'retry']);
    });

    it('falls back to a retry and the dashboard for anything else', () => {
        const next = nextStepsFor('Failed to create work', 'start-failed');
        expect(next.hint).toMatch(/prompt is still here/i);
        expect(next.actions).toEqual(['retry', 'dashboard']);
    });
});

describe('workLandingHref — where "Open your Work" goes', () => {
    it('opens the Generator tab, which shows the live progress, while generating', () => {
        expect(workLandingHref('w-1', 'generating')).toBe('/works/w-1/generator');
        expect(workLandingHref('w-1', undefined)).toBe('/works/w-1/generator');
    });

    it('opens the Generator tab after an error, where the run can be started again', () => {
        expect(workLandingHref('w-1', 'error')).toBe('/works/w-1/generator');
    });

    it('opens the Work overview once the content is generated', () => {
        expect(workLandingHref('w-1', 'generated')).toBe('/works/w-1');
    });

    it('encodes the id', () => {
        expect(workLandingHref('a/b', 'generated')).toBe('/works/a%2Fb');
    });
});

describe('formatElapsed', () => {
    it('formats minutes and seconds', () => {
        expect(formatElapsed(0)).toBe('0:00');
        expect(formatElapsed(7_400)).toBe('0:07');
        expect(formatElapsed(65_000)).toBe('1:05');
        expect(formatElapsed(-5)).toBe('0:00');
    });
});
