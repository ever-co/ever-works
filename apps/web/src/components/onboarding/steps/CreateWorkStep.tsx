'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FolderPlus } from 'lucide-react';
import { desktopNextStep, type OnboardingDesktopChoice } from '@ever-works/contracts/api';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { GenerationConsole } from '../GenerationConsole';
import { workLandingHref, type StartedWork } from '../generation-console';
import {
    fetchWorkStatusFromApi,
    useGenerationConsole,
    type FetchWorkStatus,
} from '../use-generation-console';

/** What `onQuickCreate` answers once the Work exists and its generation has started. */
export interface QuickCreateStarted {
    readonly workId?: string;
    readonly workSlug?: string;
    readonly workName?: string;
    readonly generationHistoryId?: string;
}

export interface CreateWorkStepProps {
    readonly onLeave: () => void;
    /**
     * EW-617 G4: when a prompt is present (from the landing page `?prompt=…`
     * handoff, or typed into the wizard), this step swaps the
     * "Create your first Work" link for a one-click "Generate now" button.
     * The button calls `onQuickCreate(prompt)`; the parent owns the API call
     * so this component stays I/O-free apart from the status polling below.
     */
    readonly prompt?: string;
    readonly onQuickCreate?: (prompt: string) => Promise<QuickCreateStarted | void>;
    /**
     * Called as the user edits the prompt textarea so the parent can persist
     * the edited value into the wizard state (`flow.setPrompt`). Keeps the
     * generated Work in sync with what the user actually sees before hitting
     * "Generate now".
     */
    readonly onPromptChange?: (value: string) => void;
    /**
     * A8 — the bucket the user picked on the "Where it runs" step. It decides
     * the follow-on guidance rendered below the primary action: a desktop or
     * own-nodes user is finished with the wizard but NOT finished setting up,
     * and this is the only place the wizard can say so.
     */
    readonly desktopChoice?: OnboardingDesktopChoice;
    /** Replaces the description under "Ready to generate" (the quick start has no "wizard choices"). */
    readonly intro?: string;
    /** The Work kind the visitor picked on the home page, as a label ("Directory website"). */
    readonly kindLabel?: string;
    /** `true` when "Generate now" is pressed, `false` when that start is refused. */
    readonly onBusyChange?: (busy: boolean) => void;
    /** The Work exists and its generation has started. */
    readonly onGenerationStarted?: (work: StartedWork) => void;
    /**
     * "Open your Work" — pressed, or by itself once the generation finishes.
     * `href` is where to land: the Generator tab while it runs (live progress),
     * the Work overview once it is generated.
     */
    readonly onOpenWork?: (work: StartedWork, href: string) => void;
    /** Status source for the console; defaults to the one the Work page polls. */
    readonly fetchWorkStatus?: FetchWorkStatus;
    readonly pollIntervalMs?: number;
}

const QUICK_CREATE_FALLBACK_ERROR = 'Generation failed to start. Please try again.';

/** The line under the heading once "Generate now" was pressed. */
const RUN_DESCRIPTIONS: Record<string, string> = {
    starting:
        'Creating your Work and its repository, then starting the generation. Follow along below.',
    generating:
        'Your Work exists and its content is being generated. Follow along below, or open the Work — the generation keeps running either way.',
    generated: 'All done. Opening your Work…',
    failed: 'Your Work exists, but its generation stopped. The log below says where.',
    cancelled: 'The generation was cancelled.',
    lost: 'This page stopped following the generation. The note below says why and what to do.',
};

/**
 * Final step — either:
 *  1. (legacy) navigates the user into the /works/new form, or
 *  2. (EW-617 G4) one-click "Generate now" when a `prompt` is set. Pressing it
 *     turns the step into a live console: the Work being created, then the
 *     generation's steps, log and progress, then "Open your Work". The wizard
 *     no longer closes the moment the request returns — that left the visitor
 *     looking at an empty page while the dashboard loaded.
 */
export function CreateWorkStep({
    onLeave,
    prompt,
    onQuickCreate,
    onPromptChange,
    desktopChoice,
    intro,
    kindLabel,
    onBusyChange,
    onGenerationStarted,
    onOpenWork,
    fetchWorkStatus = fetchWorkStatusFromApi,
    pollIntervalMs,
}: CreateWorkStepProps) {
    // Defaults to the cloud path, which renders no extra guidance — so a user
    // who never saw the bucket step sees exactly the previous screen.
    const nextStep = desktopNextStep(desktopChoice);
    const trimmedPrompt = prompt?.trim() ?? '';
    // Latch the "generate" mode on first render. Once the step is entered via
    // the prompt hand-off it stays in generate mode for the component's
    // lifetime, so clearing the textarea disables the button rather than
    // collapsing the whole step back to the legacy "create" link.
    const [hasPrompt] = useState(() => trimmedPrompt.length > 0 && Boolean(onQuickCreate));
    const [editablePrompt, setEditablePrompt] = useState(trimmedPrompt);
    const [submitting, setSubmitting] = useState(false);
    const run = useGenerationConsole({ fetchStatus: fetchWorkStatus, pollIntervalMs });
    const { phase, work } = run.state;

    const editable = phase === 'idle' || phase === 'start-failed';
    const canSubmit = editablePrompt.trim().length > 0 && !submitting;

    const openWork = (target: StartedWork, status?: string) => {
        onOpenWork?.(target, workLandingHref(target.id, status));
    };

    // Land on the Work by itself once its content is generated — once.
    const autoOpenedRef = useRef(false);
    useEffect(() => {
        if (phase !== 'generated' || !work || autoOpenedRef.current) return;
        autoOpenedRef.current = true;
        onOpenWork?.(work, workLandingHref(work.id, 'generated'));
    }, [phase, work, onOpenWork]);

    const handleQuickCreate = async () => {
        const value = editablePrompt.trim();
        if (!onQuickCreate || submitting || !value) return;
        setSubmitting(true);
        onBusyChange?.(true);
        run.start();
        try {
            const result = await onQuickCreate(value);
            if (!result?.workId) {
                // A caller that returns no Work to follow keeps the old contract:
                // the wizard closes.
                onLeave();
                return;
            }
            const started: StartedWork = {
                id: result.workId,
                slug: result.workSlug ?? '',
                name: result.workName || value.slice(0, 80),
            };
            run.started(started);
            onGenerationStarted?.(started);
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            run.startFailed(message || QUICK_CREATE_FALLBACK_ERROR);
            onBusyChange?.(false);
        } finally {
            setSubmitting(false);
        }
    };

    const handlePromptChange = (value: string) => {
        setEditablePrompt(value);
        onPromptChange?.(value);
    };

    const heading = !hasPrompt
        ? 'Create your first Work'
        : phase === 'idle'
          ? 'Ready to generate'
          : phase === 'generated'
            ? 'Your Work is ready'
            : phase === 'failed' || phase === 'cancelled'
              ? 'The generation stopped'
              : phase === 'start-failed'
                ? 'We could not start the generation'
                : phase === 'lost'
                  ? 'Stopped following the generation'
                  : 'Building your Work';

    return (
        <div className="space-y-5 max-w-2xl">
            <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-secondary dark:bg-white/5">
                    {hasPrompt ? (
                        <FolderPlus className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                    ) : (
                        <FolderPlus className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                    )}
                </div>
                <div className="min-w-0 flex-1">
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                        {heading}
                    </h3>
                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                        {!hasPrompt
                            ? "You're all set. Hit the button below to start building — your choices above are saved and any new Work will pick them up."
                            : editable
                              ? (intro ??
                                'We saved your wizard choices. Review or tweak the prompt below, then generate — repos, items, and deploy all in one go.')
                              : RUN_DESCRIPTIONS[phase]}
                    </p>
                    {hasPrompt ? (
                        <div className="mt-3">
                            <div className="mb-1.5 flex items-center justify-between gap-3">
                                <label
                                    htmlFor="onboarding-prompt-input"
                                    className="block text-sm font-medium text-text dark:text-text-dark"
                                >
                                    Prompt
                                </label>
                                {kindLabel ? (
                                    <span
                                        data-testid="onboarding-work-kind"
                                        className="rounded-full bg-surface-secondary dark:bg-white/5 px-2.5 py-0.5 text-xs text-text-secondary dark:text-text-secondary-dark"
                                    >
                                        Type: {kindLabel}
                                    </span>
                                ) : null}
                            </div>
                            <textarea
                                id="onboarding-prompt-input"
                                data-testid="onboarding-prompt-input"
                                value={editablePrompt}
                                onChange={(event) => handlePromptChange(event.target.value)}
                                readOnly={!editable}
                                aria-readonly={!editable}
                                rows={editable ? 4 : 2}
                                maxLength={5000}
                                className="w-full resize-y rounded-lg border border-card-border bg-white px-4 py-3 text-sm text-text outline-none transition-colors duration-200 placeholder-text-muted hover:border-border-secondary focus:border-primary focus:ring-2 focus:ring-primary/20 read-only:opacity-70 dark:border-white/9 dark:bg-card-primary-dark dark:text-text-dark dark:placeholder-text-muted-dark dark:hover:border-border-secondary-dark dark:focus:border-white/9"
                            />
                        </div>
                    ) : null}
                </div>
            </div>

            {hasPrompt && phase !== 'idle' ? (
                <GenerationConsole
                    state={run.state}
                    elapsedMs={run.elapsedMs}
                    onOpenWork={work ? () => openWork(work, statusForPhase(phase)) : undefined}
                    onRetry={submitting ? undefined : () => void handleQuickCreate()}
                />
            ) : null}

            {!hasPrompt || phase === 'idle' || nextStep.href ? (
                <div className="rounded-xl border border-dashed border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/30 p-5">
                    {hasPrompt ? (
                        phase === 'idle' ? (
                            <button
                                type="button"
                                onClick={() => void handleQuickCreate()}
                                disabled={!canSubmit}
                                data-testid="onboarding-generate-now"
                                className="inline-flex items-center gap-2 rounded-lg bg-black dark:bg-button-primary-dark px-4 py-2.5 text-sm font-medium text-white dark:text-black transition-colors hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                Generate now
                                <ArrowRight className="w-4 h-4" />
                            </button>
                        ) : null
                    ) : (
                        <Link
                            href={ROUTES.DASHBOARD_NEW}
                            onClick={onLeave}
                            className="inline-flex items-center gap-2 rounded-lg bg-black dark:bg-button-primary-dark px-4 py-2.5 text-sm font-medium text-white dark:text-black transition-colors hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark"
                        >
                            Create your first Work
                            <ArrowRight className="w-4 h-4" />
                        </Link>
                    )}
                    {nextStep.href ? (
                        <div
                            data-testid="onboarding-desktop-next-step"
                            className={
                                hasPrompt && phase !== 'idle'
                                    ? undefined
                                    : 'mt-4 border-t border-border dark:border-border-dark pt-4'
                            }
                        >
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {nextStep.title}
                            </p>
                            <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                                {nextStep.description}
                            </p>
                            <Link
                                href={nextStep.href}
                                onClick={onLeave}
                                className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                            >
                                {nextStep.title}
                                <ArrowRight className="w-3.5 h-3.5" />
                            </Link>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

/** The `generateStatus.status` a console phase stands for, for `workLandingHref`. */
function statusForPhase(phase: string): string | undefined {
    if (phase === 'generated') return 'generated';
    if (phase === 'failed') return 'error';
    if (phase === 'cancelled') return 'cancelled';
    return undefined;
}
