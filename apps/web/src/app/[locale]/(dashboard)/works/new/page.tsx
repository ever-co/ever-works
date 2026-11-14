import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { getAuthFromCookie } from '@/lib/auth';
import {
    gitProvidersAPI,
    deployAPI,
    workAPI,
    GitProviderConnectionInfo,
    GitProviderInfo,
    type WebsiteTemplateOption,
} from '@/lib/api';
import { redirect } from 'next/navigation';
import NewWorkClient, { type CreationMode } from './new-work-client';
// Imported from `@/lib/work-kinds/chip-values` (no `'use client'`) rather than
// from `./new-work-client` (a client module): a server component that imports a
// plain value across a client boundary receives a client reference, not the
// array, which threw `TypeError: a.filter is not a function` in the server
// render of this page.
import { ALL_WORK_KIND_CHIP_VALUES } from '@/lib/work-kinds/chip-values';
import { getDisabledWorkKinds } from '@/lib/feature-flags/work-kinds';
import { fetchWorkTemplateCatalog } from '@/lib/api/work-templates.server';
import type { WorkBlueprintEntry } from '@/lib/api/work-templates';
import type { DeployProvider } from './deploy-provider-selector';
import { workProposalsAPI } from '@/lib/api/work-proposals';
import type { WorkProposal } from '@/lib/api/work-proposals';
import { ROUTES } from '@/lib/constants';
import { resolveManagedStorageStatus } from '@/lib/works/managed-storage';
import {
    blueprintHandoffFormHref,
    readBlueprintHandoff,
    type BlueprintHandoff,
} from '@/lib/works/blueprint-handoff.shared';
import {
    resolveBlueprintHandoff,
    workspaceOfBlueprintHandoff,
} from '@/lib/works/blueprint-handoff.server';
import {
    BROWSER_WORKSPACE_SCOPE_HEADER,
    buildWorkspaceHref,
    parseWorkspaceSelector,
    type WorkspaceScope,
} from '@/lib/workspace-scope';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('newWork') };
}

export interface ProviderWithConnection {
    provider: GitProviderInfo;
    connectionInfo: GitProviderConnectionInfo | null;
}

interface NewWorkPageProps {
    searchParams: Promise<{
        proposal?: string;
        mode?: string;
        prompt?: string;
        kind?: string;
        // A Blueprint hand-off from Ever Platform's marketplace
        // (`@/lib/works/blueprint-handoff.shared`): read only with `kind=app`.
        blueprint?: string | string[];
        install?: string | string[];
        ever_org?: string | string[];
    }>;
}

/** The workspace the visitor is in, as the proxy read it from the address. */
async function currentWorkspace(): Promise<WorkspaceScope> {
    try {
        return parseWorkspaceSelector((await headers()).get(BROWSER_WORKSPACE_SCOPE_HEADER));
    } catch {
        return { kind: 'personal' };
    }
}

const KUBERNETES_DEPLOY_PROVIDER_ID = 'k8s';
const VALID_CREATION_MODES: CreationMode[] = ['ai', 'manual', 'import'];
const VALID_WORK_KINDS = [
    'website',
    'landing-page',
    'blog',
    'directory',
    'awesome-repo',
    'repo',
    // APW-01 T23 — `?kind=app` (from the `/new` App chip). A disabled App kind
    // still degrades through `safeInitialKind` below, exactly like any other.
    'app',
] as const;
type InitialWorkKind = (typeof VALID_WORK_KINDS)[number];

export default async function NewWorkPage({ searchParams }: NewWorkPageProps) {
    const params = await searchParams;
    const proposalId = params.proposal;
    const initialPrompt = (params.prompt ?? '').trim().slice(0, 4000);
    const initialKind = (VALID_WORK_KINDS as readonly string[]).includes(params.kind ?? '')
        ? (params.kind as InitialWorkKind)
        : null;
    // A Blueprint hand-off opens the App form whatever `mode` says (an App has one form).
    const handoff: BlueprintHandoff | null =
        initialKind === 'app' && !proposalId ? readBlueprintHandoff(params) : null;
    const initialMode = (VALID_CREATION_MODES as string[]).includes(params.mode ?? '')
        ? (params.mode as CreationMode)
        : handoff
          ? 'manual'
          : initialPrompt.length > 0
            ? 'ai'
            : null;

    if (!proposalId && !initialMode) {
        redirect(ROUTES.DASHBOARD_NEW);
    }
    const user = await getAuthFromCookie();

    // Defense: rendering with `user!` (non-null assertion) crashes the page
    // when the cookie is missing or stale. Redirect to login first so the
    // server response is a clean 307 instead of a 500.
    if (!user) {
        redirect('/login');
    }

    // A hand-off that names an Ever organization is for the Organization linked to
    // it: the App belongs there, which is also where Ever Platform is told of it.
    // Only from the personal workspace, and only to one of the person's own
    // Organizations; when none is linked to it the form opens where the visitor is.
    if (handoff?.everOrg && (await currentWorkspace()).kind === 'personal') {
        const workspace = await workspaceOfBlueprintHandoff(handoff);
        if (workspace) {
            redirect(buildWorkspaceHref(workspace, blueprintHandoffFormHref(handoff)));
        }
    }

    // Get all available git providers and their connection status
    let providers: ProviderWithConnection[] = [];
    let defaultProviderId: string | null = null;

    // Get all available deploy providers
    let deployProviders: DeployProvider[] = [];
    let defaultDeployProviderId: string | null = null;
    let websiteTemplates: WebsiteTemplateOption[] = [];

    try {
        const providersResult = await gitProvidersAPI.list();

        // Use first enabled provider as default
        const enabledProviders = providersResult.providers.filter((p) => p.enabled);
        defaultProviderId = enabledProviders[0]?.id || null;

        // Get connection info for each provider
        providers = await Promise.all(
            providersResult.providers.map(async (provider: GitProviderInfo) => {
                const connectionInfo = await gitProvidersAPI
                    .checkConnection(provider.id)
                    .catch(() => null);
                return { provider, connectionInfo };
            }),
        );
    } catch (error) {
        console.error('Failed to fetch git providers:', error);
    }

    // Fetch deploy providers
    try {
        const deployProvidersResult = await deployAPI.getProviders();
        if (deployProvidersResult.providers) {
            deployProviders = deployProvidersResult.providers;
            const firstConfigured = deployProviders.find((p) => p.enabled && p.configured);
            // When nothing is configured, default to Kubernetes (the shared
            // customer cluster) rather than Vercel — k8s needs no external
            // account, so it's the deterministic zero-config fallback. Vercel
            // remains available and becomes the default the moment its token is
            // connected (it is `configured`, so `firstConfigured` wins).
            const enabledK8s = deployProviders.find(
                (p) => p.enabled && p.id === KUBERNETES_DEPLOY_PROVIDER_ID,
            );
            const firstEnabled = deployProviders.find((p) => p.enabled);
            defaultDeployProviderId =
                firstConfigured?.id || enabledK8s?.id || firstEnabled?.id || null;
        }
    } catch (error) {
        console.error('Failed to fetch deploy providers:', error);
        deployProviders = [];
    }

    try {
        const websiteTemplatesResult = await workAPI.getWebsiteTemplates();
        websiteTemplates = websiteTemplatesResult.templates;
    } catch (error) {
        console.error('Failed to fetch website templates:', error);
        websiteTemplates = [];
    }

    // Works Templates catalog (ADR-014) — manifest Work blueprints from
    // `ever-works/works`, layered ADDITIVELY on top of the per-user website
    // templates above. Always resolves to an array (built-in fallback on any
    // failure), so the Create-Work chips + selector never break.
    let workBlueprints: WorkBlueprintEntry[] = [];
    try {
        workBlueprints = await fetchWorkTemplateCatalog();
    } catch (error) {
        console.error('Failed to fetch work blueprints:', error);
        workBlueprints = [];
    }

    let proposal: WorkProposal | null = null;
    if (proposalId) {
        // `get` now rethrows transient failures (only 404/403 → null). This
        // is a best-effort prefill on an SSR page load, so degrade to an
        // empty create form rather than error the whole route on a blip.
        proposal = await workProposalsAPI.get(proposalId).catch(() => null);
        // If the proposal is already accepted AND has a built Work, send the
        // user to the existing Work instead of starting a duplicate create flow.
        if (proposal?.status === 'accepted' && proposal.acceptedWorkId) {
            redirect(`/works/${proposal.acceptedWorkId}`);
        }
        // Any other status (pending / queued / building / failed / dismissed, or
        // accepted-without-a-Work) keeps the proposal so the create form opens
        // pre-filled with the Idea's detail. The home page surfaces Ideas of
        // every status and "Build" routes here, so gating prefill to `pending`
        // left the form blank for those cards.
    }

    // Gate each work-kind chip behind its `works-<value>` PostHog flag.
    // Fail-open: no PostHog config / errors / missing flags → everything
    // enabled. The current user id is the flag distinct id so per-user /
    // percentage rollouts work; falls back to 'anonymous' otherwise.
    const disabledSet = await getDisabledWorkKinds(ALL_WORK_KIND_CHIP_VALUES, user.id);
    const disabledKinds = Array.from(disabledSet);

    // Whether this user's Works are pushed to the managed Ever Works GitHub
    // org. Resolved on the server from the onboarding state (the user's
    // choice) + the onboarding catalog (the platform capability) — the same
    // two inputs `POST /works` uses — because the flag behind it is an API
    // env var that a client component cannot see. When it's on, the Git
    // Provider section must not claim "Not connected": there is nothing to
    // connect.
    const managedStorage = await resolveManagedStorageStatus();

    // A kind disabled by a feature flag must not be preselectable via the
    // `?kind=` URL handoff — otherwise a user could deep-link a "Soon"
    // chip into the selected state and submit it. If the resolved kind is
    // disabled, drop it back to the default (null → client defaults to
    // its own first live kind).
    const safeInitialKind = initialKind && disabledSet.has(initialKind) ? null : initialKind;

    // The Blueprint of a hand-off, as this installation's Apps catalog names it.
    // Read only when the App form will be shown; a catalog that cannot be read,
    // or a Blueprint it does not have, opens the form on the catalog instead.
    const appBlueprintHandoff =
        handoff && safeInitialKind === 'app' ? await resolveBlueprintHandoff(handoff) : null;

    return (
        <NewWorkClient
            user={user!}
            providers={providers}
            defaultProviderId={defaultProviderId}
            deployProviders={deployProviders}
            defaultDeployProviderId={defaultDeployProviderId}
            websiteTemplates={websiteTemplates}
            workBlueprints={workBlueprints}
            proposal={proposal}
            initialMode={initialMode}
            initialPrompt={initialPrompt}
            initialKind={safeInitialKind}
            appBlueprintHandoff={appBlueprintHandoff}
            disabledKinds={disabledKinds}
            managedGitStorage={managedStorage.managedGitActive}
        />
    );
}
