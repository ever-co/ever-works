'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, Check } from 'lucide-react';
import { useRouter } from '@/i18n/navigation';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { useMounted } from '@/lib/hooks/use-mounted';
import { ROUTES } from '@/lib/constants';
import { useOnboardingFlow, type WizardStep } from './useOnboardingFlow';
import { WizardFooter } from './WizardFooter';
import { WelcomeStep } from './steps/WelcomeStep';
import { ChoiceStep } from './steps/ChoiceStep';
import { ConfigStep } from './steps/ConfigStep';
import { PluginsCatalogStep } from './steps/PluginsCatalogStep';
import { ProfileStep } from './steps/ProfileStep';
import { RosterStep } from './steps/RosterStep';
import { CommunicationStep, SLACK_CONNECTOR_PLUGIN_ID } from './steps/CommunicationStep';
import { CreateWorkStep, type QuickCreateStarted } from './steps/CreateWorkStep';
import { useTurnstile } from './use-turnstile';
import { AI_ICONS, DB_ICONS, DEPLOY_ICONS, STORAGE_ICONS } from './brand-icons';
import { trackOnboardingEvent } from '@/app/actions/onboarding/track';
import { completeOnboarding, patchOnboardingState } from '@/app/actions/onboarding/state';
import { getOnboardingPluginStatuses } from '@/app/actions/dashboard/onboarding';
import type {
    OnboardingAiChoice,
    OnboardingCatalogResponse,
    OnboardingDbChoice,
    OnboardingDeployChoice,
    OnboardingDesktopChoice,
    OnboardingStateResponse,
    OnboardingStorageChoice,
} from '@ever-works/contracts/api';
import type { UserPlugin } from '@/lib/api/plugins';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import type { GitProviderConnectionInfo } from '@/lib/api/plugins-capabilities/git-providers';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';
import { quickCreateSlugFromPrompt } from '@/lib/works/work-slug.shared';
import { readPromptHandoff } from './prompt-handoff';
import type { StartedWork } from './generation-console';

export interface EverWorksOnboardingWizardProps {
    readonly open: boolean;
    readonly initialState: OnboardingStateResponse;
    readonly catalog: OnboardingCatalogResponse;
    readonly plugins: ReadonlyArray<UserPlugin>;
    readonly initialConnections: Record<
        string,
        OAuthConnectionInfo | GitProviderConnectionInfo | null
    >;
    readonly initialDeviceAuthStatuses: Record<string, PluginDeviceAuthStatus | null>;
    readonly onClose: () => void;
    /**
     * "Open your Work" from the generation console. `href` is where to land
     * (the Generator tab while it runs). When absent, the wizard closes and
     * routes there itself.
     */
    readonly onOpenWork?: (work: StartedWork, href: string) => void;
}

/**
 * v2 onboarding wizard — choice-driven flow (Welcome → AI → Storage →
 * Deploy → Plugins → Create Work). Server-authoritative state, telemetry
 * via server action, Back / Skip / Refresh footer controls.
 */
export function EverWorksOnboardingWizard({
    open,
    initialState,
    catalog,
    plugins,
    initialConnections,
    initialDeviceAuthStatuses,
    onClose,
    onOpenWork,
}: EverWorksOnboardingWizardProps) {
    const mounted = useMounted();
    const router = useRouter();

    const pluginsById = useMemo(() => {
        const map: Record<string, UserPlugin> = {};
        plugins.forEach((p) => {
            map[p.pluginId] = p;
        });
        return map;
    }, [plugins]);

    const [connections, setConnections] = useState(initialConnections);
    const [deviceAuthStatuses, setDeviceAuthStatuses] = useState(initialDeviceAuthStatuses);
    const [isStatusLoading, setIsStatusLoading] = useState(false);

    // EW-617 G7 — Turnstile token producer. Renders a hidden Managed
    // widget once at wizard mount; getToken() executes on demand
    // before each captcha-gated API call. No-ops cleanly when the
    // server's CAPTCHA_PROVIDER is unset.
    const turnstile = useTurnstile();

    // EW-617 G8 — correlation UUID minted on wizard mount, threaded
    // into telemetry events server-side so ops can trace the full
    // funnel (landing → wizard → work created → deploy ready). If the
    // landing page (G1) handed off a `corrId=…` in the URL hash, we
    // re-use it so the funnel chain is continuous from
    // `landing_prompt_submit` onwards.
    const correlationId = useMemo(() => {
        if (typeof window !== 'undefined') {
            const fromHash = readHashParam(window.location.hash, 'corrId');
            if (fromHash && /^[A-Za-z0-9_-]{8,64}$/.test(fromHash)) return fromHash;
        }
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        // Fallback for environments without crypto.randomUUID — only
        // used in legacy browsers / older Node test envs.
        return `corr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }, []);

    const flow = useOnboardingFlow({
        initial: initialState,
        catalog,
        patchState: async (patch) => {
            const result = await patchOnboardingState(patch);
            // If the server-action wrapper reports `success: false` (e.g. API
            // 4xx/5xx, validation error), surface it so the user knows their
            // progress wasn't saved. Silent failures previously let the user
            // click through the whole wizard with nothing persisted.
            if (!result.success) {
                toast.error(result.error ?? 'Failed to save your onboarding progress');
            }
        },
        trackEvent: (event, props) => {
            void trackOnboardingEvent(event, props);
        },
        onClose,
        markCompleted: () => {
            void completeOnboarding();
        },
    });

    // EW-617 G4 + G1 — landing-page hand-off. When the wizard mounts and
    // the URL carries `#prompt=…` (or the older `?prompt=…`), the visitor
    // already said what they want: they get the prompt-first quick start
    // (Idea → Generate → Open your Work) with the defaults named, and
    // "Customize setup" opens the full wizard. This used to jump straight to
    // step 11 of 11 with every earlier step shown as done, which read as the
    // wizard skipping itself. Once per mount, and only while open: the
    // dashboard mounts this wizard closed on every page, and pages such as
    // `/tasks/new?prompt=…` and `/agents/new?prompt=…` own their `prompt`.
    //
    // Security: the prompt is read from an attacker-controllable URL before it
    // is stored in wizard state, persisted and rendered; `readPromptHandoff`
    // sanitises and bounds it (control chars stripped, 5000-char cap — the same
    // limit the contract and QuickCreateWorkDto enforce).
    const promptHydratedRef = useRef(false);
    const startQuickStart = flow.startQuickStart;
    useEffect(() => {
        if (!mounted || !open || promptHydratedRef.current) return;
        if (typeof window === 'undefined') return;
        promptHydratedRef.current = true;
        const handoff = readPromptHandoff(window.location.href);
        if (!handoff) return;

        startQuickStart(handoff.prompt);

        // Strip what the hand-off consumed (prompt, corrId, type) so a reload
        // doesn't re-trigger it and the prompt doesn't leak to analytics
        // referers. corrId was already read into `correlationId` above.
        window.history.replaceState({}, '', handoff.cleanedHref);
    }, [mounted, open, startQuickStart]);

    // A started generation pins the wizard to its console: leaving the step
    // would drop the live view, and the Work exists now.
    const [runBusy, setRunBusy] = useState(false);
    const [startedWork, setStartedWork] = useState<StartedWork | null>(null);
    const runLocked = runBusy || startedWork !== null;
    const finishFlow = flow.finish;

    const openWork = useCallback(
        (work: StartedWork, href: string) => {
            if (onOpenWork) {
                onOpenWork(work, href);
                return;
            }
            onClose();
            router.push(href);
        },
        [onClose, onOpenWork, router],
    );

    // Closing the dialog once the Work exists goes to the Work, not back to
    // an empty dashboard.
    const handleDismiss = useCallback(() => {
        if (startedWork) {
            openWork(
                startedWork,
                ROUTES.DASHBOARD_WORK_GENERATOR(encodeURIComponent(startedWork.id)),
            );
            return;
        }
        onClose();
    }, [onClose, openWork, startedWork]);

    // A "Try again" after a failed run starts another generation; onboarding is
    // completed (and `onboarding_completed` sent) for the first one only.
    const onboardingCompletedRef = useRef(false);
    const handleGenerationStarted = useCallback(
        (work: StartedWork) => {
            setStartedWork(work);
            if (onboardingCompletedRef.current) return;
            onboardingCompletedRef.current = true;
            // Onboarding is done; the wizard stays open on the console.
            finishFlow({ close: false });
        },
        [finishFlow],
    );

    const refreshConnections = async (pluginId?: string) => {
        const target = pluginId ? plugins.filter((p) => p.pluginId === pluginId) : plugins;
        if (target.length === 0) return;
        setIsStatusLoading(true);
        try {
            const result = await getOnboardingPluginStatuses(
                target.map((p) => ({ pluginId: p.pluginId, capabilities: p.capabilities })),
            );
            if (result.success && result.data) {
                setConnections((prev) => ({ ...prev, ...result.data!.connections }));
                setDeviceAuthStatuses((prev) => ({
                    ...prev,
                    ...result.data!.deviceAuthStatuses,
                }));
            }
        } finally {
            setIsStatusLoading(false);
        }
    };

    // EW-617 G4: anonymous + claimed users alike can one-click finish. The
    // endpoint reads provider defaults from onboarding state.
    const quickCreate = async (prompt: string): Promise<QuickCreateStarted> => {
        // EW-617 G7: fetch a fresh Turnstile token right before the call.
        // Empty when captcha is disabled — server is OK with that.
        const captchaToken = await turnstile.getToken();
        // EW-617 G8 — funnel step 3: wizard finished. Fire-and-forget; never
        // blocks the user flow.
        void import('@/app/actions/telemetry/funnel').then(({ emitFunnelEventAction }) =>
            emitFunnelEventAction({
                event: 'zero_friction.wizard_finished',
                funnelStep: 3,
                correlationId,
                extra: {
                    isAnonymous: false,
                    aiChoice: flow.state.ai.choice,
                    storageChoice: flow.state.storage.choice,
                    deployChoice: flow.state.deploy.choice,
                },
            }),
        );
        const { quickCreateWorkAction } = await import('@/app/actions/works/quick-create');
        const result = await quickCreateWorkAction({
            slug: slugifyPrompt(prompt),
            name: deriveNameFromPrompt(prompt),
            description: prompt.slice(0, 500),
            prompt,
            organization: false,
            deployProvider: flow.state.deploy.choice,
            storageProvider: flow.state.storage.choice,
            captchaToken: captchaToken || undefined,
            correlationId,
        });
        if (!result.success) {
            throw new Error(result.error ?? 'Failed to start generation');
        }
        return {
            workId: result.data?.work.id,
            workSlug: result.data?.work.slug,
            workName: result.data?.work.name,
            generationHistoryId: result.data?.generation.historyId,
        };
    };

    const runHandlers: RunHandlers = {
        onBusyChange: setRunBusy,
        onGenerationStarted: handleGenerationStarted,
        onOpenWork: openWork,
    };

    if (!mounted || !open) return null;

    const quickStart = flow.quickStart;
    const stepIndex = flow.stepIndex;
    const progressPercent = Math.round(((stepIndex + 1) / flow.steps.length) * 100);
    const currentStep = flow.currentStep;
    const isConfigStep = isConfigKind(currentStep.kind);

    const skipLabel = isConfigStep
        ? 'Skip step'
        : currentStep.kind === 'plugins-catalog'
          ? 'Skip — set up later'
          : flow.isLastStep
            ? 'Finish later'
            : 'Skip step';

    const nextLabel = flow.isLastStep ? 'Finish' : 'Next';

    return (
        <Dialog open={open} onOpenChange={(next) => !next && handleDismiss()}>
            <DialogContent className="max-w-5xl p-0 overflow-hidden rounded-lg shadow-2xl">
                {quickStart ? null : (
                    <div className="absolute top-0 left-0 right-0 h-[3px] bg-border dark:bg-border-dark z-10 rounded-t-lg">
                        <div
                            className="h-full w-full origin-left bg-text dark:bg-white/70 transition-transform duration-500 ease-out rounded-t-2xl"
                            style={{ transform: `scaleX(${progressPercent / 100})` }}
                        />
                    </div>
                )}

                <div className="grid gap-0 md:grid-cols-[260px_1fr] min-h-[88dvh]">
                    {quickStart ? (
                        <QuickStartNav
                            catalog={catalog}
                            state={flow.state}
                            stage={startedWork ? 'open' : runBusy ? 'generating' : 'generate'}
                            fullStepCount={flow.steps.length}
                            canCustomize={!runLocked}
                            onCustomize={flow.customizeSetup}
                            onClose={handleDismiss}
                        />
                    ) : (
                        <SideNav
                            steps={flow.steps}
                            activeIndex={stepIndex}
                            onJump={flow.jumpTo}
                            locked={runLocked}
                            onClose={handleDismiss}
                        />
                    )}

                    <section className="flex flex-col">
                        <div className="flex-1 overflow-y-auto px-8 pt-10 pb-6">
                            {quickStart ? (
                                <CreateWorkStep
                                    onLeave={() => flow.finish()}
                                    prompt={flow.state.prompt}
                                    onPromptChange={flow.setPrompt}
                                    intro="Review or tweak your prompt, then generate. We create the Work with the setup on the left and build its content — you can follow every step below."
                                    onQuickCreate={flow.state.prompt ? quickCreate : undefined}
                                    {...runHandlers}
                                />
                            ) : (
                                <StepBody
                                    step={currentStep}
                                    flow={flow}
                                    catalog={catalog}
                                    pluginsById={pluginsById}
                                    connections={connections}
                                    deviceAuthStatuses={deviceAuthStatuses}
                                    isStatusLoading={isStatusLoading}
                                    quickCreate={quickCreate}
                                    runHandlers={runHandlers}
                                    onPluginConnected={(pluginId) =>
                                        void refreshConnections(pluginId)
                                    }
                                />
                            )}
                        </div>
                        {quickStart ? null : (
                            <WizardFooter
                                stepIndex={stepIndex}
                                totalSteps={flow.steps.length}
                                canGoBack={flow.canGoBack && !runLocked}
                                nextLabel={nextLabel}
                                skipLabel={skipLabel}
                                showSkip={!flow.isLastStep || isConfigStep}
                                showNext={!flow.isLastStep}
                                showRefresh={isConfigStep}
                                refreshing={isStatusLoading}
                                onBack={flow.goBack}
                                onSkip={() => {
                                    if (flow.isLastStep) {
                                        flow.finish({ dismissed: true });
                                        return;
                                    }
                                    flow.skip();
                                }}
                                onRefresh={() => {
                                    flow.refresh();
                                    const pluginId = pluginIdForStep(currentStep, flow.state);
                                    void refreshConnections(pluginId);
                                }}
                                onNext={() => {
                                    if (flow.isLastStep) {
                                        flow.finish();
                                        return;
                                    }
                                    flow.goNext();
                                }}
                            />
                        )}
                    </section>
                </div>
            </DialogContent>
        </Dialog>
    );
}

interface RunHandlers {
    readonly onBusyChange: (busy: boolean) => void;
    readonly onGenerationStarted: (work: StartedWork) => void;
    readonly onOpenWork: (work: StartedWork, href: string) => void;
}

// ─── Subcomponents ─────────────────────────────────────────────────────────

/**
 * The prompt-first quick start's side panel: a three-stage path instead of
 * the eleven wizard steps, the defaults the Work will be created with, and
 * the way into the full wizard.
 */
function QuickStartNav({
    catalog,
    state,
    stage,
    fullStepCount,
    canCustomize,
    onCustomize,
    onClose,
}: {
    catalog: OnboardingCatalogResponse;
    state: ReturnType<typeof useOnboardingFlow>['state'];
    stage: 'generate' | 'generating' | 'open';
    fullStepCount: number;
    canCustomize: boolean;
    onCustomize: () => void;
    onClose: () => void;
}) {
    const stages: Array<{ label: string; status: 'done' | 'active' | 'todo' }> = [
        { label: 'Your idea', status: 'done' },
        {
            label: stage === 'generating' ? 'Generating' : 'Generate',
            status: stage === 'open' ? 'done' : 'active',
        },
        { label: 'Open your Work', status: stage === 'open' ? 'active' : 'todo' },
    ];
    const defaults = [
        { label: 'AI', value: cardTitle(catalog.ai, state.ai.choice) },
        { label: 'Git storage', value: cardTitle(catalog.storage, state.storage.choice) },
        { label: 'Hosting', value: cardTitle(catalog.deploy, state.deploy.choice) },
    ];

    return (
        <aside
            data-testid="onboarding-quick-start"
            className="relative flex flex-col bg-surface-secondary/50 dark:bg-surface-secondary-dark/60 border-r border-border dark:border-border-dark"
        >
            <div className="px-5 pt-8 pb-5">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-text-muted dark:text-text-muted-dark bg-surface-secondary dark:bg-white/5 px-2.5 py-1 rounded-full mb-3">
                    Quick start
                </span>
                <h2 className="text-sm font-semibold text-text dark:text-text-dark leading-snug">
                    Build from your idea
                </h2>
                <p className="text-[11px] leading-relaxed mt-1 text-text-muted dark:text-text-muted-dark">
                    You started with a prompt, so your Work is set up with the defaults below. You
                    can change any of them later in Settings.
                </p>
            </div>
            <ol className="px-3 pb-2 space-y-0.5" aria-label="Quick start progress">
                {stages.map((item, index) => (
                    <li
                        key={item.label}
                        aria-current={item.status === 'active' ? 'step' : undefined}
                        className={cn(
                            'flex items-center gap-3 rounded-lg px-3 py-2.5',
                            item.status === 'active' && 'bg-surface dark:bg-white/5',
                        )}
                    >
                        <span
                            className={cn(
                                'flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold',
                                item.status === 'active'
                                    ? 'bg-text dark:bg-white text-white dark:text-black'
                                    : item.status === 'done'
                                      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                                      : 'border border-border dark:border-border-dark text-text-muted dark:text-text-muted-dark',
                            )}
                        >
                            {item.status === 'done' ? (
                                <Check className="h-3.5 w-3.5" aria-label="done" />
                            ) : (
                                index + 1
                            )}
                        </span>
                        <span
                            className={cn(
                                'text-sm',
                                item.status === 'active'
                                    ? 'font-medium text-text dark:text-text-dark'
                                    : 'text-text-secondary dark:text-text-secondary-dark',
                            )}
                        >
                            {item.label}
                        </span>
                    </li>
                ))}
            </ol>
            <dl
                data-testid="onboarding-quick-start-defaults"
                className="mx-5 mt-3 space-y-1.5 rounded-lg border border-border dark:border-border-dark px-3 py-3 text-xs"
            >
                {defaults.map((row) => (
                    <div key={row.label} className="flex items-baseline justify-between gap-3">
                        <dt className="text-text-muted dark:text-text-muted-dark">{row.label}</dt>
                        <dd className="truncate text-right text-text dark:text-text-dark">
                            {row.value}
                        </dd>
                    </div>
                ))}
            </dl>
            {canCustomize ? (
                <div className="px-5 pt-3">
                    <button
                        type="button"
                        data-testid="onboarding-quick-start-customize"
                        onClick={onCustomize}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark hover:underline"
                    >
                        Customize setup instead ({fullStepCount} steps)
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </button>
                </div>
            ) : null}
            <div className="px-3 py-2 mt-auto border-t border-border dark:border-border-dark">
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={onClose}
                    className="w-4/5 mx-auto text-xs py-2.5 text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                >
                    Close
                </Button>
            </div>
        </aside>
    );
}

function cardTitle(
    cards: ReadonlyArray<{ choice: string; title: string }>,
    choice: string,
): string {
    return cards.find((card) => card.choice === choice)?.title ?? choice;
}

function SideNav({
    steps,
    activeIndex,
    onJump,
    locked = false,
    onClose,
}: {
    steps: WizardStep[];
    activeIndex: number;
    onJump: (index: number) => void;
    /** While a generation runs from the last step, the steps cannot be left. */
    locked?: boolean;
    onClose: () => void;
}) {
    return (
        <aside className="relative flex flex-col bg-surface-secondary/50 dark:bg-surface-secondary-dark/60 border-r border-border dark:border-border-dark">
            <div className="px-5 pt-8 pb-5">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-text-muted dark:text-text-muted-dark bg-surface-secondary dark:bg-white/5 px-2.5 py-1 rounded-full mb-3">
                    Setup
                </span>
                <h2 className="text-sm font-semibold text-text dark:text-text-dark leading-snug">
                    Get started with Ever Works
                </h2>
                <p className="text-[11px] leading-relaxed mt-1 text-text-muted dark:text-text-muted-dark">
                    A guided multi-step walkthrough. You can change any choice later from Settings.
                </p>
            </div>
            <nav className="flex-1 px-3 pb-2 space-y-0.5 overflow-y-auto">
                {steps.map((step, index) => {
                    const isActive = index === activeIndex;
                    const isPast = index < activeIndex;
                    return (
                        <button
                            key={step.id}
                            type="button"
                            onClick={() => onJump(index)}
                            disabled={locked && !isActive}
                            className={cn(
                                'w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                                isActive
                                    ? 'bg-surface dark:bg-white/5'
                                    : 'hover:bg-surface dark:hover:bg-surface-dark',
                            )}
                        >
                            <span
                                className={cn(
                                    'flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold transition-colors',
                                    isActive
                                        ? 'bg-text dark:bg-white text-white dark:text-black'
                                        : isPast
                                          ? 'bg-border dark:bg-border-dark text-text-muted dark:text-text-muted-dark'
                                          : 'border border-border dark:border-border-dark text-text-muted dark:text-text-muted-dark',
                                )}
                            >
                                {index + 1}
                            </span>
                            <span
                                className={cn(
                                    'text-sm truncate transition-colors',
                                    isActive
                                        ? 'font-medium text-text dark:text-text-dark'
                                        : 'text-text-secondary dark:text-text-secondary-dark',
                                )}
                            >
                                {labelForStep(step)}
                            </span>
                        </button>
                    );
                })}
            </nav>
            <div className="px-3 py-2 mt-auto border-t border-border dark:border-border-dark">
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={onClose}
                    className="w-4/5 mx-auto text-xs py-2.5 text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                >
                    Close wizard
                </Button>
            </div>
        </aside>
    );
}

function StepBody({
    step,
    flow,
    catalog,
    pluginsById,
    connections,
    deviceAuthStatuses,
    isStatusLoading,
    quickCreate,
    runHandlers,
    onPluginConnected,
}: {
    step: WizardStep;
    flow: ReturnType<typeof useOnboardingFlow>;
    catalog: OnboardingCatalogResponse;
    pluginsById: Record<string, UserPlugin | undefined>;
    connections: Record<string, OAuthConnectionInfo | GitProviderConnectionInfo | null>;
    deviceAuthStatuses: Record<string, PluginDeviceAuthStatus | null>;
    isStatusLoading: boolean;
    quickCreate: (prompt: string) => Promise<QuickCreateStarted>;
    runHandlers: RunHandlers;
    onPluginConnected: (pluginId: string) => void;
}) {
    switch (step.kind) {
        case 'welcome':
            return (
                <WelcomeStep
                    upcomingSteps={flow.steps.filter((s) => s.kind !== 'welcome').map(labelForStep)}
                />
            );
        case 'ai-choice':
            return (
                <ChoiceStep
                    title="Your AI choice"
                    description="Pick the AI provider that powers content generation."
                    cards={catalog.ai}
                    selected={flow.state.ai.choice}
                    columns={3}
                    icons={AI_ICONS}
                    onSelect={(choice) => flow.setAiChoice(choice as OnboardingAiChoice)}
                    onPlannedClick={(c) => flow.notePlannedClick('ai', c)}
                />
            );
        case 'ai-config': {
            const pluginId = flow.state.ai.choice;
            const plugin = pluginsById[pluginId] ?? null;
            return (
                <ConfigStep
                    title={`Configure ${plugin?.name ?? pluginId}`}
                    description="Paste your credentials below. Skip to come back later."
                    plugin={plugin}
                    connection={connections[pluginId] ?? null}
                    deviceAuthStatus={deviceAuthStatuses[pluginId] ?? null}
                    isStatusLoading={isStatusLoading}
                />
            );
        }
        case 'storage-choice':
            return (
                <ChoiceStep
                    title="Your Git Storage"
                    description="Where do you want your Work repos to live?"
                    cards={catalog.storage}
                    selected={flow.state.storage.choice}
                    icons={STORAGE_ICONS}
                    onSelect={(choice) => flow.setStorageChoice(choice as OnboardingStorageChoice)}
                    onPlannedClick={(c) => flow.notePlannedClick('storage', c)}
                />
            );
        case 'db-choice': {
            // Driven by the PostgreSQL DB plugin: its settingsSchema renders the
            // Ever Works DB / Custom selector + (for custom) the connection
            // string, saved as the plugin's user-scoped settings — replacing the
            // bespoke `db` bucket. Falls back to the choice cards until the
            // plugin is loaded in the running API image (graceful, additive).
            const dbPlugin = pluginsById['postgres-db'] ?? null;
            if (dbPlugin) {
                return (
                    <ConfigStep
                        title="Your DB Storage"
                        description="Choose where your Works store data — the managed Ever Works DB (a database is provisioned per Work) or your own Postgres server."
                        plugin={dbPlugin}
                        connection={connections['postgres-db'] ?? null}
                        isStatusLoading={isStatusLoading}
                    />
                );
            }
            return (
                <ChoiceStep
                    title="Your DB Storage"
                    description="Where should your Work's database live? Ever Works DB is fully managed; with Custom DB you enter connection details on the Deploy page after your Work is created."
                    cards={catalog.db}
                    selected={flow.state.db?.choice ?? 'ever-works-db'}
                    icons={DB_ICONS}
                    onSelect={(choice) => flow.setDbChoice(choice as OnboardingDbChoice)}
                    onPlannedClick={(c) => flow.notePlannedClick('db', c)}
                />
            );
        }
        case 'storage-config': {
            // Only `user-github` reaches here (others are auto-skipped).
            const plugin = pluginsById['github'] ?? null;
            return (
                <ConfigStep
                    title="Connect your GitHub"
                    description="Sign in with GitHub so we can create your Work repos."
                    plugin={plugin}
                    connection={connections['github'] ?? null}
                    isStatusLoading={isStatusLoading}
                />
            );
        }
        case 'deploy-choice':
            return (
                <ChoiceStep
                    title="Your deployment"
                    description="Where do you want your Works to be deployed?"
                    cards={catalog.deploy}
                    selected={flow.state.deploy.choice}
                    columns={3}
                    icons={DEPLOY_ICONS}
                    onSelect={(choice) => flow.setDeployChoice(choice as OnboardingDeployChoice)}
                    onPlannedClick={(c) => flow.notePlannedClick('deploy', c)}
                />
            );
        case 'desktop-choice':
            return (
                <ChoiceStep
                    title="Where Ever Works runs"
                    description="This one is not about a provider — it decides what we point you at once the wizard is done."
                    cards={catalog.desktop}
                    selected={flow.state.desktop?.choice ?? 'cloud'}
                    columns={3}
                    onSelect={(choice) => flow.setDesktopChoice(choice as OnboardingDesktopChoice)}
                    onPlannedClick={(c) => flow.notePlannedClick('desktop', c)}
                />
            );
        case 'deploy-config': {
            const pluginId = flow.state.deploy.choice; // 'vercel' | 'k8s'
            const plugin = pluginsById[pluginId] ?? null;
            return (
                <ConfigStep
                    title={`Configure ${plugin?.name ?? pluginId}`}
                    description="Add deployment credentials. You can change this later."
                    plugin={plugin}
                    connection={connections[pluginId] ?? null}
                    isStatusLoading={isStatusLoading}
                />
            );
        }
        case 'profile':
            return (
                <ProfileStep
                    roles={flow.state.profile?.roles ?? []}
                    teamSize={flow.state.profile?.teamSize}
                    onToggleRole={flow.toggleRole}
                    onSelectTeamSize={flow.setTeamSize}
                />
            );
        case 'roster':
            // AW-20 — the one step that hands the user a team rather than
            // more plumbing. It owns its own primary action ("Create my
            // agents") the same way ProfileStep owns its seeding block;
            // the footer's Skip is what makes it skippable.
            return <RosterStep />;
        case 'communication':
            // Audit item (b) — connect in place. The connector plugin is
            // passed in so the card can render its settings panel + enable
            // action inline; when the image ships without it the step
            // degrades to the Settings → Plugins link it used to be.
            return (
                <CommunicationStep
                    slackPlugin={pluginsById[SLACK_CONNECTOR_PLUGIN_ID] ?? null}
                    slackConnection={connections[SLACK_CONNECTOR_PLUGIN_ID] ?? null}
                    isStatusLoading={isStatusLoading}
                    onConnected={onPluginConnected}
                />
            );
        case 'plugins-catalog':
            return (
                <PluginsCatalogStep
                    cards={catalog.plugins}
                    pluginsById={pluginsById}
                    onExpand={() => flow.setPluginsReviewed(true)}
                />
            );
        case 'create-work':
            return (
                <CreateWorkStep
                    onLeave={() => flow.finish()}
                    prompt={flow.state.prompt}
                    onPromptChange={flow.setPrompt}
                    desktopChoice={flow.state.desktop?.choice}
                    onQuickCreate={flow.state.prompt ? quickCreate : undefined}
                    {...runHandlers}
                />
            );
        default:
            return null;
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isConfigKind(kind: WizardStep['kind']): boolean {
    return kind === 'ai-config' || kind === 'storage-config' || kind === 'deploy-config';
}

// EW-617 G8: read `corrId=…` from the URL hash fragment at mount. The
// landing page (G1) hands off via fragment so nothing reaches server access
// logs. Bad input returns `null`.
function readHashParam(hash: string, key: string): string | null {
    if (!hash) return null;
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    try {
        const params = new URLSearchParams(raw);
        return params.get(key);
    } catch {
        return null;
    }
}

// EW-617 G4: derive a DNS-safe slug from the user's prompt.
// The slug column has the same `^[a-z0-9]+(?:-[a-z0-9]+)*$` constraint
// as `CreateWorkDto.slug`, so we strip everything else and bound the
// length. Adds a short timestamp suffix so two users typing the same
// prompt don't collide.
// (`quickCreateSlugFromPrompt` — cut without a trailing hyphen, so a space at
// the cut can no longer produce `--`, which the API refuses.)
function slugifyPrompt(prompt: string): string {
    return quickCreateSlugFromPrompt(prompt);
}

// Pull the first ~80 chars of the prompt as a display name. Title-cased
// so it looks like a name in the dashboard list.
function deriveNameFromPrompt(prompt: string): string {
    const head = prompt.slice(0, 80).trim();
    return head.charAt(0).toUpperCase() + head.slice(1);
}

function pluginIdForStep(
    step: WizardStep,
    state: ReturnType<typeof useOnboardingFlow>['state'],
): string | undefined {
    if (step.kind === 'ai-config') return state.ai.choice;
    if (step.kind === 'storage-config') return 'github';
    if (step.kind === 'deploy-config') return state.deploy.choice;
    return undefined;
}

function labelForStep(step: WizardStep): string {
    switch (step.kind) {
        case 'welcome':
            return 'Welcome';
        case 'ai-choice':
            return 'Your AI choice';
        case 'ai-config':
            return 'Configure AI';
        case 'storage-choice':
            return 'Your Git Storage';
        case 'storage-config':
            return 'Configure storage';
        case 'db-choice':
            return 'Your DB Storage';
        case 'deploy-choice':
            return 'Your deployment';
        case 'deploy-config':
            return 'Configure deployment';
        case 'desktop-choice':
            return 'Where it runs';
        case 'profile':
            return 'What do you do';
        case 'roster':
            return 'Your agents';
        case 'communication':
            return 'Communication';
        case 'plugins-catalog':
            return 'Plugins & Integrations';
        case 'create-work':
            return 'Create your first Work';
        default:
            return step.kind;
    }
}
