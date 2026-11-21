'use client';

import { useEffect, useRef } from 'react';
import { ArrowRight, RotateCcw } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import {
    formatElapsed,
    formatStep,
    isTerminalPhase,
    nextStepsFor,
    type ConsoleLine,
    type ConsolePhase,
    type ConsoleState,
    type ConsoleTone,
} from './generation-console';

export interface GenerationConsoleProps {
    readonly state: ConsoleState;
    /** Time since the current attempt started, for the clock in the header. */
    readonly elapsedMs: number;
    readonly onOpenWork?: () => void;
    readonly onRetry?: () => void;
    readonly className?: string;
}

const STATUS_TEXT: Record<ConsolePhase, string> = {
    idle: 'Ready',
    starting: 'Creating your Work…',
    'start-failed': 'Could not start',
    generating: 'Generating…',
    generated: 'Done',
    failed: 'Generation failed',
    cancelled: 'Cancelled',
};

const STATUS_DOT: Record<ConsolePhase, string> = {
    idle: 'bg-text-muted',
    starting: 'bg-sky-500 animate-pulse',
    'start-failed': 'bg-red-500',
    generating: 'bg-sky-500 animate-pulse',
    generated: 'bg-emerald-500',
    failed: 'bg-red-500',
    cancelled: 'bg-amber-500',
};

const TONE_TEXT: Record<ConsoleTone, string> = {
    info: 'text-text dark:text-text-dark',
    step: 'text-sky-700 dark:text-sky-300 font-medium',
    success: 'text-emerald-700 dark:text-emerald-400',
    warn: 'text-amber-700 dark:text-amber-400',
    error: 'text-red-600 dark:text-red-400',
    muted: 'text-text-muted dark:text-text-muted-dark',
};

const TONE_GLYPH: Record<ConsoleTone, string> = {
    info: '·',
    step: '▸',
    success: '✓',
    warn: '!',
    error: '✗',
    muted: '·',
};

const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
});

function formatTime(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : timeFormatter.format(date);
}

/**
 * Live console for the onboarding "Generate now" run: a status header with a
 * clock, the current pipeline step and progress, a log feed, and — when
 * something goes wrong — the error in full with what to do next.
 *
 * Security: every line is rendered as React text. Messages come from the
 * pipeline and can carry text derived from fetched pages or model output;
 * never switch this to `dangerouslySetInnerHTML`.
 */
export function GenerationConsole({
    state,
    elapsedMs,
    onOpenWork,
    onRetry,
    className,
}: GenerationConsoleProps) {
    const logRef = useRef<HTMLDivElement>(null);
    const lineCount = state.lines.length;

    useEffect(() => {
        const el = logRef.current;
        if (el && lineCount > 0) {
            el.scrollTop = el.scrollHeight;
        }
    }, [lineCount]);

    const failed =
        state.phase === 'start-failed' || state.phase === 'failed' || state.phase === 'cancelled';
    const next = failed ? nextStepsFor(state.error, state.phase) : null;
    const running = state.phase === 'starting' || state.phase === 'generating';
    const showProgress = state.phase === 'generating' || isTerminalPhase(state.phase);
    const progress = state.progress ?? 0;

    return (
        <section
            data-testid="onboarding-console"
            aria-label="Generation progress"
            className={cn(
                'overflow-hidden rounded-xl border border-card-border dark:border-white/9 bg-white dark:bg-card-primary-dark',
                className,
            )}
        >
            <header className="flex items-center justify-between gap-3 border-b border-border dark:border-border-dark px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                    <span
                        aria-hidden
                        className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOT[state.phase])}
                    />
                    <span
                        data-testid="onboarding-console-status"
                        className="truncate text-sm font-medium text-text dark:text-text-dark"
                    >
                        {STATUS_TEXT[state.phase]}
                    </span>
                </div>
                <span
                    data-testid="onboarding-console-elapsed"
                    className="shrink-0 font-mono text-xs tabular-nums text-text-muted dark:text-text-muted-dark"
                    aria-label="Elapsed time"
                >
                    {formatElapsed(elapsedMs)}
                </span>
            </header>

            {showProgress ? (
                <div className="space-y-2 px-4 pt-3">
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                        <span
                            data-testid="onboarding-console-step"
                            className="truncate text-text-secondary dark:text-text-secondary-dark"
                        >
                            {state.step ? formatStep(state.step) : noStepText(state.phase)}
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums text-text dark:text-text-dark">
                            {progress}%
                        </span>
                    </div>
                    <div
                        role="progressbar"
                        aria-label="Generation progress"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progress}
                        className="h-1 w-full overflow-hidden rounded-full bg-surface-secondary dark:bg-white/10"
                    >
                        <div
                            className={cn(
                                'h-full rounded-full transition-[width] duration-700 ease-out',
                                state.phase === 'failed'
                                    ? 'bg-red-500'
                                    : 'bg-text dark:bg-white/80',
                            )}
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                    {state.itemsProcessed ? (
                        <p className="text-xs tabular-nums text-text-muted dark:text-text-muted-dark">
                            {`${state.itemsProcessed} items generated`}
                        </p>
                    ) : null}
                </div>
            ) : null}

            <div
                ref={logRef}
                role="log"
                aria-live="polite"
                aria-label="Generation log"
                className="mt-3 max-h-56 overflow-y-auto border-t border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-black/20 px-4 py-3 font-mono text-[11px] leading-5"
            >
                {state.lines.map((entry) => (
                    <ConsoleRow key={entry.key} entry={entry} />
                ))}
                {running ? (
                    <div aria-hidden className="h-5 text-emerald-500 animate-pulse">
                        &#9608;
                    </div>
                ) : null}
            </div>

            {failed && state.error ? (
                <div className="space-y-2 border-t border-border dark:border-border-dark px-4 py-3">
                    <p
                        role="alert"
                        data-testid="onboarding-generate-error"
                        className="whitespace-pre-line text-sm text-red-600 dark:text-red-400"
                    >
                        {state.error}
                    </p>
                    {next ? (
                        <p
                            data-testid="onboarding-console-hint"
                            className="text-sm text-text-secondary dark:text-text-secondary-dark"
                        >
                            {next.hint}
                        </p>
                    ) : null}
                </div>
            ) : null}

            <ConsoleActions
                state={state}
                actions={next?.actions ?? []}
                onOpenWork={onOpenWork}
                onRetry={onRetry}
            />
        </section>
    );
}

/** The step line before any step was reported. */
function noStepText(phase: ConsolePhase): string {
    if (phase === 'generated') return 'All steps done';
    if (phase === 'failed' || phase === 'cancelled') return 'Stopped before the first step';
    return 'Waiting for the first step…';
}

function ConsoleRow({ entry }: { entry: ConsoleLine }) {
    return (
        <div className="flex gap-2">
            <span className="w-16 shrink-0 tabular-nums text-text-muted dark:text-text-muted-dark">
                {formatTime(entry.at)}
            </span>
            <span aria-hidden className={cn('w-3 shrink-0 text-center', TONE_TEXT[entry.tone])}>
                {TONE_GLYPH[entry.tone]}
            </span>
            <span
                className={cn(
                    'min-w-0 flex-1 whitespace-pre-line break-words',
                    TONE_TEXT[entry.tone],
                )}
            >
                {entry.text}
            </span>
        </div>
    );
}

function ConsoleActions({
    state,
    actions,
    onOpenWork,
    onRetry,
}: {
    state: ConsoleState;
    actions: readonly string[];
    onOpenWork?: () => void;
    onRetry?: () => void;
}) {
    const canOpenWork = Boolean(state.work && onOpenWork);
    const canRetry = actions.includes('retry') && Boolean(onRetry);
    const showPlugins = actions.includes('plugins');
    const showDashboard = actions.includes('dashboard');
    if (!canOpenWork && !canRetry && !showPlugins && !showDashboard) return null;

    const primary =
        'inline-flex items-center gap-2 rounded-lg bg-black dark:bg-button-primary-dark px-3.5 py-2 text-sm font-medium text-white dark:text-black transition-colors hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark';
    const secondary =
        'inline-flex items-center gap-2 rounded-lg border border-border dark:border-border-dark px-3.5 py-2 text-sm font-medium text-text dark:text-text-dark transition-colors hover:bg-surface-secondary dark:hover:bg-white/5';
    // The Work is the way forward unless the start itself failed.
    const openIsPrimary = state.phase !== 'start-failed';

    return (
        <div className="flex flex-wrap items-center gap-2 border-t border-border dark:border-border-dark px-4 py-3">
            {canOpenWork ? (
                <button
                    type="button"
                    data-testid="onboarding-console-open-work"
                    onClick={onOpenWork}
                    className={openIsPrimary ? primary : secondary}
                >
                    Open your Work
                    <ArrowRight className="h-4 w-4" aria-hidden />
                </button>
            ) : null}
            {canRetry ? (
                <button
                    type="button"
                    data-testid="onboarding-console-retry"
                    onClick={onRetry}
                    className={canOpenWork ? secondary : primary}
                >
                    <RotateCcw className="h-4 w-4" aria-hidden />
                    Try again
                </button>
            ) : null}
            {showPlugins ? (
                <Link href={ROUTES.DASHBOARD_PLUGINS} className={secondary}>
                    Open Plugins settings
                </Link>
            ) : null}
            {showDashboard ? (
                <Link href={ROUTES.DASHBOARD} className={secondary}>
                    Go to the dashboard
                </Link>
            ) : null}
            {state.phase === 'generating' ? (
                <p className="basis-full text-xs text-text-muted dark:text-text-muted-dark">
                    You can open your Work now — the generation keeps running there and in the
                    background.
                </p>
            ) : null}
        </div>
    );
}
