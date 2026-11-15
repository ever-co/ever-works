'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';
import {
    listTaskRunCandidatesAction,
    runTaskAction,
    type RunTaskActionResult,
} from '@/app/actions/tasks';
import {
    RUN_AGENT_AMBIGUOUS,
    RUN_ALREADY_IN_FLIGHT,
    RUN_NO_AGENT,
    type RunCandidateAgent,
} from '@/lib/api/tasks.shared';
import { isRunRefused, runRefusalText } from './run-refusal';

/**
 * Board dispatch (kanban M3) — the "Run" affordance and its agent picker.
 *
 * One component serves three entry points so they can never disagree
 * about what running a Task means:
 *
 *   - the Run button on a kanban card,
 *   - the Run button on Task detail,
 *   - the board opening the picker on its own (`open` / `onOpenChange`),
 *     which is how a drag into In Progress with no Agent assigned stops
 *     being a silent no-op.
 *
 * It never branches on an error MESSAGE — production redacts thrown
 * Server-Action messages — only on the stable `code` the action returns.
 */

/** Catalogue key (under `dashboard.tasksPage.runMenu`) for each way an Agent became a candidate. */
const SOURCE_LABEL_KEYS = {
    assignee: 'sourceAssignee',
    task: 'sourceTask',
    'work-default': 'sourceWorkDefault',
} as const satisfies Record<RunCandidateAgent['source'], string>;

export interface RunWithAgentMenuProps {
    taskId: string;
    /** `compact` renders the card-sized icon button; default is the detail button. */
    compact?: boolean;
    /** Controlled picker state — the board uses this for the drag case. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Fired after a run is accepted (dispatched or parked) — never for a refused one. */
    onRunStarted?: (result: Extract<RunTaskActionResult, { ok: true }>) => void;
    className?: string;
}

export function RunWithAgentMenu({
    taskId,
    compact = false,
    open,
    onOpenChange,
    onRunStarted,
    className,
}: RunWithAgentMenuProps) {
    const t = useTranslations('dashboard.tasksPage.runMenu');
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const isControlled = open !== undefined;
    const pickerOpen = isControlled ? open : uncontrolledOpen;

    const [candidates, setCandidates] = useState<RunCandidateAgent[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [tone, setTone] = useState<'ok' | 'error'>('ok');
    const containerRef = useRef<HTMLDivElement | null>(null);

    const setOpen = useCallback(
        (next: boolean) => {
            if (!isControlled) setUncontrolledOpen(next);
            onOpenChange?.(next);
        },
        [isControlled, onOpenChange],
    );

    // Load the picker's options the first time it opens. Best-effort:
    // a failed lookup still shows the panel, just with an empty list and
    // the reason, rather than leaving the user with a dead button.
    useEffect(() => {
        if (!pickerOpen || candidates !== null) return;
        let cancelled = false;
        void (async () => {
            try {
                const rows = await listTaskRunCandidatesAction(taskId);
                if (!cancelled) setCandidates(rows);
            } catch {
                if (!cancelled) setCandidates([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [pickerOpen, candidates, taskId]);

    // Close on outside click / Escape — the picker is a popover, not a
    // modal, so it must never trap the board's own `r` shortcut.
    useEffect(() => {
        if (!pickerOpen) return;
        const onPointerDown = (event: MouseEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [pickerOpen, setOpen]);

    const dispatch = useCallback(
        async (agentId?: string | null) => {
            setBusy(true);
            setMessage(null);
            try {
                const result = await runTaskAction(taskId, agentId ?? null);
                if (result.ok && isRunRefused(result.run)) {
                    // APW-08 T12 — refused before any run row (no isolated runtime, no commit
                    // permission, App changes paused): say why, never "Run started".
                    setOpen(false);
                    setTone('error');
                    setMessage(runRefusalText(result.run.error, t('refusedFallback')));
                    return;
                }
                if (result.ok) {
                    setOpen(false);
                    setTone('ok');
                    setMessage(
                        result.run.parked
                            ? t('queued', {
                                  reason: result.run.queuedReason ?? t('queuedDefaultReason'),
                              })
                            : t('runStarted'),
                    );
                    onRunStarted?.(result);
                    return;
                }
                setTone('error');
                if (result.code === RUN_AGENT_AMBIGUOUS || result.code === RUN_NO_AGENT) {
                    // The server already told us who the options are —
                    // trust that list over a second round trip.
                    setCandidates(result.candidates ?? []);
                    setOpen(true);
                    setMessage(
                        result.code === RUN_NO_AGENT ? t('noAgentAssigned') : t('pickAgent'),
                    );
                    return;
                }
                if (result.code === RUN_ALREADY_IN_FLIGHT) {
                    setMessage(t('alreadyInFlight'));
                    return;
                }
                setMessage(result.message || t('runFailed'));
            } finally {
                setBusy(false);
            }
        },
        [taskId, setOpen, onRunStarted, t],
    );

    return (
        <div ref={containerRef} className={cn('relative inline-flex flex-col', className)}>
            <button
                type="button"
                disabled={busy}
                onClick={() => void dispatch(null)}
                aria-label={t('runLabel')}
                title={t('runTitle')}
                data-testid="task-run-button"
                className={cn(
                    'inline-flex items-center gap-1 rounded font-medium transition-colors disabled:opacity-50',
                    compact
                        ? 'text-[10px] px-1.5 py-0.5 text-text-muted hover:text-primary'
                        : 'text-xs px-2.5 py-1.5 border border-border dark:border-border-dark hover:border-primary hover:text-primary',
                )}
            >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                {t('run')}
            </button>

            {pickerOpen && (
                <div
                    role="dialog"
                    aria-label={t('pickerLabel')}
                    data-testid="task-run-agent-picker"
                    className={cn(
                        'absolute top-full right-0 mt-1 z-20 min-w-[200px] max-w-[280px]',
                        'rounded-md border border-border/60 dark:border-border-dark/60',
                        'bg-card dark:bg-card-primary-dark p-1.5 shadow-md',
                    )}
                >
                    <p className="px-1.5 pb-1 text-[10px] uppercase tracking-wide text-text-muted">
                        {t('runWith')}
                    </p>
                    {candidates === null ? (
                        <p className="px-1.5 py-1 text-[11px] text-text-muted">{t('loading')}</p>
                    ) : candidates.length === 0 ? (
                        <p className="px-1.5 py-1 text-[11px] text-text-muted">
                            {t('noAgentAvailable')}
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-0.5">
                            {candidates.map((agent) => (
                                <li key={agent.id}>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void dispatch(agent.id)}
                                        data-testid="task-run-agent-option"
                                        className="w-full flex items-center justify-between gap-2 text-left text-[11px] px-2 py-1 rounded hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-primary disabled:opacity-50"
                                    >
                                        <span className="truncate">{agent.name}</span>
                                        <span className="text-[9px] text-text-muted shrink-0">
                                            {t(SOURCE_LABEL_KEYS[agent.source])}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {message && (
                <p
                    className={cn(
                        'mt-1 text-[10px]',
                        tone === 'error' ? 'text-danger' : 'text-text-muted',
                    )}
                    role={tone === 'error' ? 'alert' : 'status'}
                    data-testid="task-run-message"
                    data-tone={tone}
                >
                    {message}
                </p>
            )}
        </div>
    );
}
