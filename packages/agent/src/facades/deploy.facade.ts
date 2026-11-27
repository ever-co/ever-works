import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type {
    IDeploymentPlugin,
    IDeployFacade,
    DeployFacadeOptions,
    DeployFacadeTeam,
    DeployProviderInfo,
    DeploymentLookupResult,
    DeploymentLookupContext,
    DeploymentDomain,
    AddDomainResult,
    SettingSource,
    WorkDeploymentRef,
    WorkDeploymentTeardownResult,
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES, isDnsProvider } from '@ever-works/plugin';
import type { IDnsProvider } from '@ever-works/plugin';
import { readPluginString } from '../plugins/services/lazy-plugin-proxy';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { GitFacadeService } from './git.facade';
import { WorkCustomDomainRepository } from '../database/repositories/work-custom-domain.repository';
import { AppDomainsService } from '../app-runtime/app-domains.service';
import { EverWorksK8sDeployProvider, buildEverWorksTenantNamespace } from '../ever-works-providers';
import { FacadeError, NoProviderError, ProviderNotFoundError } from './base.facade';
import { config } from '../config';
import { assertNotPlatformHost } from '../utils/platform-host';
import type { Work } from '../entities/work.entity';
import type { User } from '../entities/user.entity';
import {
    DeploymentContextResolutionError,
    PLATFORM_MANAGED_KUBECONFIG_SENTINEL,
    coerceDeploymentClusterSource,
    everWorksTenantNamespaceBase,
    isReservedDeployNamespace,
    resolveEffectiveDeploymentContext,
    resolveKubernetesDeployNamespace,
    type EffectiveDeploymentContextInput,
} from './deployment-context.resolver';

const KUBERNETES_DEPLOY_PROVIDER_ID = 'k8s';
const EVER_WORKS_DEPLOY_PROVIDER_ID = 'ever-works';

/**
 * APW-06 T26 — the `work.kind` an App Work carries.
 *
 * APW-01 adds `'app'` to the shared `WORK_KINDS` union additively; until that lands, `Work.kind` is
 * typed as a union that does not contain it, so the comparison goes through a string — the same rule
 * `app-launcher/managed-host-root.resolver.ts:48-70` already documents for its own copy.
 */
const APP_WORK_KIND = 'app';

// Security: allow-list of plugin IDs whose secret settings the deploy
// orchestrator is permitted to read via `getOtherPluginSettings`. The k8s
// deploy only needs the GitHub plugin's `readPackagesPat*` to mint a GHCR
// imagePullSecret, plus the `postgres-db` plugin's resolved DB connection
// (mode / custom / per-Work override) to compose the deployed site's
// `DATABASE_URL`. Restricting this prevents the open-ended "fetch any
// plugin's secrets" method from being repurposed to exfiltrate unrelated
// credentials (e.g. an AI provider's API key) for the request's user.
const CROSS_PLUGIN_SETTINGS_ALLOWLIST: ReadonlySet<string> = new Set(['github', 'postgres-db']);

function resolvePluginProviderId(providerId: string): string {
    return providerId === EVER_WORKS_DEPLOY_PROVIDER_ID
        ? KUBERNETES_DEPLOY_PROVIDER_ID
        : providerId;
}

export class DeployFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'DeployFacadeError';
    }
}

export class NoDeployProviderError extends DeployFacadeError {
    constructor() {
        super('No deployment provider configured or available', 'getPlugin');
        this.name = 'NoDeployProviderError';
    }
}

export class DeployProviderNotFoundError extends DeployFacadeError {
    constructor(providerId: string) {
        super(`Deployment provider not found: ${providerId}`, 'getPlugin', providerId);
        this.name = 'DeployProviderNotFoundError';
    }
}

export class NoDeployCredentialsError extends DeployFacadeError {
    constructor(providerId: string, userId: string, providerName?: string) {
        const displayName = providerName || providerId;
        super(
            `No ${displayName} credentials configured. ` +
                `Please configure your ${displayName} token in Plugin Settings.`,
            'getCredentials',
            providerId,
        );
        this.name = 'NoDeployCredentialsError';
    }
}

export interface DeployFacadeFullOptions extends DeployFacadeOptions {
    /** Override the provider (instead of using work.deployProvider) */
    providerOverride?: string;
}

interface EffectiveDeploymentOperationContext {
    readonly token: string;
    readonly teamScope: string | undefined;
    readonly context: DeploymentLookupContext;
}

/** Why {@link DeployFacadeService.prepareWorkDeploymentTeardown} prepared nothing. */
export type WorkDeploymentTeardownSkipReason =
    /** The Work row was not found. */
    | 'not_found'
    /** Not a platform-managed Kubernetes target (another provider, a member's own cluster, an App Work). */
    | 'not_managed'
    /**
     * This environment is not marked as the owner of the platform's Works
     * clusters (`EVER_WORKS_K8S_WORKS_CLUSTER_OWNER`), so its sharer check,
     * which sees only its own database, cannot tell whether another
     * environment's Work deploys to the same objects.
     */
    | 'not_cluster_owner'
    /** The deploy plugin has no `removeWorkDeployment`. */
    | 'unsupported'
    /** No enforced, non-reserved namespace: the objects' location is not known for sure. */
    | 'no_namespace'
    /** Another Work deploys, or may deploy, to the same namespace and object name. */
    | 'shared'
    /** The target could not be resolved (no platform credential, a refused context, a lookup error). */
    | 'unresolved';

export type WorkDeploymentTeardownPreparation =
    | {
          readonly status: 'ready';
          readonly namespace: string;
          readonly objectName: string;
          /**
           * The Work's cached `deployProjectId` (`namespace/name`) when it names
           * another place than `namespace/objectName`. It is set when the
           * platform first looks the deployment up and is not rewritten, so a
           * rename or a move since then shows here. Objects there are NOT
           * removed, so the caller can say where to look.
           */
          readonly staleTarget?: string;
          /** Removes the objects. Holds the cluster credential: never log or serialise the closure's inputs. */
          readonly run: () => Promise<WorkDeploymentTeardownResult>;
      }
    | {
          readonly status: 'skipped';
          readonly reason: WorkDeploymentTeardownSkipReason;
          /** A fixed sentence or a reason code, never an error message: it is logged. */
          readonly detail?: string;
      };

/** A platform-held cluster credential an orphan report lists with. */
export type PlatformDeployCluster = 'ever-works' | 'k8s-works' | 'k8s-works-shared';

/**
 * {@link DeployFacadeService.reportOrphanedWorkDeployments}: the website
 * deployments on the platform's clusters that no Work accounts for. A report
 * only: nothing in it is removed, and removing anything it names needs the
 * owner's explicit yes first. Secret-free: names, namespaces and reason codes.
 */
export interface WorkDeploymentOrphanReport {
    /**
     * Why nothing was listed, when nothing was. `not_cluster_owner`: this
     * environment is not marked as the clusters' owner
     * (`EVER_WORKS_K8S_WORKS_CLUSTER_OWNER`), so it cannot tell another
     * environment's deployments from orphans.
     */
    readonly skipped?: 'not_cluster_owner' | 'unsupported' | 'no_cluster' | 'works_unreadable';
    /** With `works_unreadable`, or a `no_cluster` whose lookup failed: the reason code. */
    readonly detail?: string;
    /** One entry per distinct credential (names that share one are listed together). */
    readonly clusters: ReadonlyArray<{
        readonly names: readonly PlatformDeployCluster[];
        /** Website deployments the deploy created there. */
        readonly listed: number;
        /** The list's reason code, when it failed. */
        readonly failed?: string;
    }>;
    /**
     * Deployments whose `namespace/name` is no Work's deploy target and no
     * Work's cached deploy target (`deployProjectId`): a deleted Work's
     * teardown was skipped or failed, or a Work moved off Kubernetes before
     * its deploy target was ever cached.
     */
    readonly orphans: ReadonlyArray<{
        /** The credential(s) that listed it: `+` joins names that share one, `, ` separate ones. */
        readonly cluster: string;
        readonly namespace: string;
        readonly name: string;
    }>;
    /**
     * Kubernetes Works whose target could not be worked out. A deployment with
     * one of their object names is not called an orphan, wherever it is.
     */
    readonly unresolvedWorks: number;
}

/** One distinct platform cluster credential, and the names that share it. Holds a secret: never log it. */
interface PlatformClusterCredential {
    readonly names: PlatformDeployCluster[];
    readonly kubeconfig: string;
    /** The cluster source a `k8s` deploy names it by (none for the managed `ever-works` one). */
    readonly clusterSource?: 'k8s-works' | 'k8s-works-shared';
}

/** What the Works account for, for {@link WorkDeploymentOrphanReport}. */
interface KnownWorkDeploymentTargets {
    /** Every `namespace/name` a Work deploys to, or has cached as its deploy target. */
    readonly targets: Set<string>;
    /** Object names of the Works whose target could not be worked out. */
    readonly unresolvedNames: Set<string>;
    readonly unresolvedWorks: number;
}

/** A Work of a provider that deploys to Kubernetes objects (`ever-works` is the managed alias of `k8s`). */
function isKubernetesFamilyProvider(provider: string | null | undefined): boolean {
    return provider === EVER_WORKS_DEPLOY_PROVIDER_ID || provider === KUBERNETES_DEPLOY_PROVIDER_ID;
}

/** An error's reason code (`code`, else its class name), never its message: the result is logged. */
function teardownFailureCode(error: unknown): string {
    const code = (error as { code?: unknown } | null)?.code;
    const reason = (error as { reason?: unknown } | null)?.reason;
    if (typeof code === 'string' && code) {
        return typeof reason === 'string' && reason ? `${code}/${reason}` : code;
    }
    const name = (error as { name?: unknown } | null)?.name;
    return typeof name === 'string' && name && name !== 'Error' ? name : 'unknown';
}

/** `namespace/name` when `deployProjectId` looks like a Kubernetes deployment id, else `null`. */
function kubernetesDeploymentId(deployProjectId: string | null | undefined): string | null {
    const value = (deployProjectId ?? '').trim();
    return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
        ? value
        : null;
}

/**
 * Whose per-tenant namespace (`{base}-{tenantId}`, see
 * {@link buildEverWorksTenantNamespace}) `namespace` is:
 *
 * - `'unreadable'` when it is a tenant namespace at the 63-character cap, the
 *   owner's own included: the id may have been cut there, so several tenants
 *   may share it (with the default base and a UUID the name is 55 characters);
 * - `null` when it is not a tenant namespace, or it is the owner's own;
 * - `{ tenantId }` otherwise, read back from the name. A tenant id is a user id
 *   (a UUID), which the name keeps as it is.
 *
 * A `k8s` Work on `k8s-works` can name any namespace explicitly, a member's
 * tenant namespace included; that member's Works then deploy to the same place.
 */
function foreignTenantOf(
    namespace: string,
    ownerId: string,
): { tenantId: string } | 'unreadable' | null {
    const base = everWorksTenantNamespaceBase();
    const prefix = `${base}-`;
    const tenantId = namespace.startsWith(prefix) ? namespace.slice(prefix.length) : '';
    // A cut can also drop the dash it left at the end, hence one below the cap.
    if (tenantId && namespace.length >= 62) {
        return 'unreadable';
    }
    if (!tenantId || namespace === buildEverWorksTenantNamespace(ownerId, base)) {
        return null;
    }
    return { tenantId };
}

/** Why another Work, or another tenant, may own a deleted Work's objects. */
type DeploymentSharer =
    /** Its own settings resolve to the same namespace. */
    | { readonly id: string; readonly why: 'resolved' }
    /** Its settings could not be read, so it may. */
    | { readonly id: string; readonly why: 'unresolved' }
    /** Its cached deploy target (`deployProjectId`) is this one, whatever it deploys to now. */
    | { readonly id: string; readonly why: 'cached_target' }
    /** It is the owner's or the namespace tenant's, on another provider now: its old objects may still serve it. */
    | {
          readonly id: string;
          readonly why: 'moved';
          readonly provider: string | null;
          readonly sameOwner: boolean;
      }
    /** The namespace is a tenant namespace whose tenants cannot be read back from its name. */
    | { readonly why: 'unreadable_tenant' };

/** The `shared` skip's detail: fixed wording, Work ids and object names only. */
function describeDeploymentSharer(
    sharer: DeploymentSharer,
    namespace: string,
    target: string,
): string {
    switch (sharer.why) {
        case 'resolved':
            return `Work ${sharer.id} deploys to ${target} too`;
        case 'unresolved':
            return `Work ${sharer.id} may deploy to ${target} too (its settings could not be read); remove the objects by hand if it does not`;
        case 'cached_target':
            return `Work ${sharer.id} has ${target} cached as its deploy target, whatever it deploys to now; its objects there may still serve it, so remove them by hand if they do not`;
        case 'moved': {
            const whose = sharer.sameOwner
                ? 'has the same name and owner'
                : `belongs to the tenant whose namespace ${namespace} is, has the same name`;
            return `Work ${sharer.id} ${whose} and was moved to ${sharer.provider || 'no provider'}; its old objects in ${target} may still serve it, so remove them by hand if they do not`;
        }
        case 'unreadable_tenant':
            return `${namespace} is a tenant namespace at the 63-character name cap, so which tenants share it cannot be read back from its name; remove the objects in ${target} by hand if no Work of theirs uses them`;
    }
}

/** `work.kind` compared as a string, like `appDomainsFor` (APW-01 adds `'app'` to the union additively). */
function isAppKind(work: Work): boolean {
    return (
        String(work.kind ?? '')
            .trim()
            .toLowerCase() === APP_WORK_KIND
    );
}

/**
 * The object name the Kubernetes plugin gives a website repository
 * (`sanitiseSlug` in `@ever-works/k8s-plugin`): lower case, every run of other
 * characters → `-`, dash runs collapsed, edge dashes dropped, 63 max.
 *
 * A copy, not an import: the agent never depends on a plugin package (plugins
 * load at runtime), and the plugin's entry exports only its class. The plugin's
 * own cases (`packages/plugins/k8s/src/__tests__/sanitise-slug.spec.ts`) are
 * pinned against this copy in `deploy.facade.work-teardown.spec.ts`: change both
 * together.
 * The teardown itself re-derives the name inside the plugin; this copy only
 * decides which other Works could share it.
 *
 * TODO: move `sanitiseSlug` into `@ever-works/plugin` (which both packages
 * already depend on) and import it in both places, retiring this copy.
 */
export function normaliseObjectName(input: string): string {
    const collapsed = (input ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-');
    let start = 0;
    let end = collapsed.length;
    while (start < end && collapsed[start] === '-') start += 1;
    while (end > start && collapsed[end - 1] === '-') end -= 1;
    return collapsed.slice(start, end).slice(0, 63);
}

/**
 * DeployFacadeService provides a unified interface for deployment operations.
 *
 * It resolves the deployment provider from work.deployProvider and retrieves
 * credentials from plugin settings (user-scoped). This facade implements the
 * IDeployFacade interface from the plugin package.
 *
 * Key differences from other facades:
 * - Uses work.deployProvider instead of capability-based resolution
 * - Tokens are always from plugin settings (user-required configuration mode)
 * - Coordinates with GitFacade for git operations during deployment
 */
@Injectable()
export class DeployFacadeService implements IDeployFacade {
    private readonly logger = new Logger(DeployFacadeService.name);
    private readonly CAPABILITY = PLUGIN_CAPABILITIES.DEPLOYMENT;

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
        private readonly workRepository: WorkRepository,
        private readonly gitFacade: GitFacadeService,
        private readonly domainRepository: WorkCustomDomainRepository,
        private readonly workPluginRepository?: WorkPluginRepository,
        // Task 10 / Path A — the dedicated managed-deploy provider. Optional so
        // the many hand-constructed test fixtures (and any injector that hasn't
        // registered it) keep working; when absent we self-instantiate the
        // stateless provider, which reads `EVER_WORKS_DEPLOY_*` from env at call
        // time. Registered as a real Nest provider in the work + deploy modules.
        @Optional()
        private readonly everWorksDeployProvider: EverWorksK8sDeployProvider = new EverWorksK8sDeployProvider(),
        // APW-06 T26 (plan §8.4) — the App branch of the four domain methods. **Optional and last**,
        // so every existing construction (the 33 specs under `facades/__tests__/`, the account
        // transfer, the internal CLI) keeps compiling and keeps its behaviour: with nothing bound
        // there is no App branch at all. **Unbound in the API today**: no API module provides
        // `AppDomainsService` (only the worker's `TriggerAppRuntimeModule` does), so an App Work's
        // domain calls take the website path. Recorded gap C43 (owner ruling 2026-09-30), kept exact
        // by `OPEN_API_GAPS` in `apps/api/src/app-works-di-reachability.spec.ts`.
        @Optional()
        private readonly appDomains?: AppDomainsService,
        // C43 (lane aw-deploy-2, 2026-10-17) — the API's `FacadesModule` cannot import the module
        // that provides `AppDomainsService` without a cycle, so in the API the App branch reaches
        // it through a non-strict `ModuleRef` lookup (`AppDeployRequestModule` provides it). The
        // worker still gets it by constructor. Optional and last, like the line above.
        @Optional()
        private readonly moduleRef?: ModuleRef,
    ) {}

    resolveProviderId(providerId: string): string {
        return resolvePluginProviderId(providerId);
    }

    getProviderName(providerId: string | undefined): string {
        if (!providerId) return 'Deployment';

        const resolvedProviderId = resolvePluginProviderId(providerId);
        const registered = this.registry.get(resolvedProviderId);
        const plugin = registered?.plugin as IDeploymentPlugin | undefined;

        return plugin?.name || plugin?.providerName || providerId;
    }

    /**
     * Check if deployment is configured for a work
     */
    async isConfigured(options: DeployFacadeOptions): Promise<boolean> {
        try {
            const work = await this.workRepository.findById(options.workId);
            if (!work?.deployProvider) {
                return false;
            }

            const pluginProviderId = resolvePluginProviderId(work.deployProvider);
            const registered = this.registry.get(pluginProviderId);
            if (!registered || registered.state !== 'loaded') {
                return false;
            }

            // Check if user has configured their token
            const token = await this.getTokenFromSettings(
                pluginProviderId,
                options.userId,
                options.workId,
            );
            return !!token;
        } catch {
            return false;
        }
    }

    /**
     * Check whether a specific deployment provider has user credentials.
     * This is used by provider listing/configuration UI where there may be no
     * work selected yet.
     */
    async isProviderConfigured(
        providerId: string,
        userId: string,
        workId?: string,
    ): Promise<boolean> {
        const resolvedProviderId = resolvePluginProviderId(providerId);
        const registered = this.registry.get(resolvedProviderId);
        if (!registered || registered.state !== 'loaded') {
            return false;
        }
        if (!registered.manifest.capabilities.includes(this.CAPABILITY)) {
            return false;
        }
        return !!(await this.getTokenFromSettings(resolvedProviderId, userId, workId));
    }

    /**
     * Get list of available deployment providers
     */
    getAvailableProviders(): DeployProviderInfo[] {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: p.plugin.name || (p.plugin as IDeploymentPlugin).providerName || p.plugin.id,
            enabled: p.state === 'loaded',
            icon: p.manifest.icon,
            description: p.manifest.description,
            homepage: p.manifest.homepage,
        }));
    }

    /**
     * Is this deploy provider an internal one (`visibility: 'hidden'` in its
     * manifest) that a user must not pick for a website Work?
     */
    isHiddenProvider(providerId: string): boolean {
        const registered = this.registry.get(resolvePluginProviderId(providerId));
        return (registered?.manifest?.visibility ?? 'public') === 'hidden';
    }

    /**
     * Get deployment providers with user-scoped credential state.
     *
     * `enabled` means the plugin is loaded. `configured` means this user has
     * supplied the provider's primary credential.
     */
    async getAvailableProvidersForUser(userId: string): Promise<DeployProviderInfo[]> {
        const providers = this.getAvailableProviders();
        return Promise.all(
            providers.map(async (provider) => ({
                ...provider,
                configured: provider.enabled
                    ? await this.isProviderConfigured(provider.id, userId)
                    : false,
            })),
        );
    }

    /**
     * The providers a user may PICK for a Work in the deploy selectors
     * (`GET /api/deploy/providers`: Create-Work, the Deploy tab, the chat's
     * deploy tools): {@link getAvailableProvidersForUser} without the
     * `visibility: 'hidden'` plugins. The only one is `k8s-apps-tier`
     * ("Ever Works Apps (managed)"), which deploys App Works only and is chosen
     * through the App Work's own target picker; listed, a website Work could
     * pick it, the create succeeded and every deploy then failed.
     *
     * Internal callers keep the full list: the App source inspector filters
     * the apps-tier plugin by {@link getAvailableProvidersForUser}.
     */
    async getSelectableProvidersForUser(userId: string): Promise<DeployProviderInfo[]> {
        const providers = await this.getAvailableProvidersForUser(userId);
        return providers.filter((provider) => !this.isHiddenProvider(provider.id));
    }

    /**
     * Validate the user's deployment token
     */
    async validateToken(options: DeployFacadeOptions): Promise<boolean> {
        try {
            const { plugin, token } = await this.resolvePluginAndToken(options);
            if (plugin.validateToken) {
                return plugin.validateToken(token);
            }
            // If no validation method, assume valid if token exists
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get teams/organizations available to the user
     */
    async getTeams(options: DeployFacadeOptions): Promise<DeployFacadeTeam[]> {
        const { plugin, token } = await this.resolvePluginAndToken(options);
        if (plugin.getTeams) {
            return plugin.getTeams(token);
        }
        return [];
    }

    /**
     * Initiate a deployment
     *
     * This method coordinates with GitFacade to set secrets and dispatch workflows.
     * The actual deployment is handled by GitHub Actions.
     */
    async deploy(
        config: { projectName: string; teamScope?: string },
        options: DeployFacadeOptions,
    ): Promise<boolean> {
        const { plugin, token, work } = await this.resolvePluginAndTokenWithWork(options);
        const user = work.user as User;

        // Get git token for repository operations
        const gitToken = await this.gitFacade.getAccessToken({
            userId: user.id,
            providerId: work.gitProvider,
            workId: work.id,
        });

        if (!gitToken) {
            throw new DeployFacadeError('Git provider token not available', 'deploy', plugin.id);
        }

        // The deployment is coordinated through the deploy module/service
        // This facade just returns the plugin and token for the controller to use
        // The actual deployment flow uses VercelService.deploy() which handles:
        // 1. Setting secrets on the repository
        // 2. Dispatching the deployment workflow
        // 3. Triggering the deployment verification

        // For now, we return true to indicate deployment can proceed
        // The actual deployment is handled by the DeployService in the API layer
        return true;
    }

    /**
     * Get status of a deployment
     */
    async getDeploymentStatus(
        deploymentId: string,
        options: DeployFacadeOptions,
    ): Promise<{ status: string; url?: string; error?: string }> {
        const { plugin, token, work } = await this.resolvePluginAndTokenWithWork(options);
        const deploymentContext = await this.resolveDeploymentLookupContext(
            plugin,
            token,
            work,
            options,
        );
        const result = await plugin.getDeploymentStatus(
            deploymentId,
            deploymentContext.token,
            deploymentContext.context,
        );
        return {
            status: result.status,
            url: result.url,
            error: result.error,
        };
    }

    /**
     * Lookup existing deployment for a work
     */
    async lookupExistingDeployment(
        projectName: string,
        options: DeployFacadeOptions,
    ): Promise<DeploymentLookupResult> {
        const { plugin, token, work } = await this.resolvePluginAndTokenWithWork(options);

        if (plugin.lookupExistingDeployment) {
            const lookup = await this.resolveDeploymentLookupContext(plugin, token, work, options);
            const result = await plugin.lookupExistingDeployment(
                projectName,
                lookup.token,
                lookup.teamScope,
                lookup.context,
            );

            // Update work with deployment info if found
            if (result.found && (result.website || result.deploymentState)) {
                await this.workRepository.update(work.id, {
                    website: result.website ?? undefined,
                    deploymentState: result.deploymentState ?? work.deploymentState,
                });
            }

            return result;
        }

        return { found: false };
    }

    /**
     * Get deployment token for a user/work
     * (Used by the deploy service for setting repository secrets)
     */
    async getDeployToken(options: DeployFacadeOptions): Promise<string | null> {
        try {
            const work = await this.workRepository.findById(options.workId);
            if (!work?.deployProvider) {
                return null;
            }
            return this.getTokenFromSettings(
                resolvePluginProviderId(work.deployProvider),
                options.userId,
                options.workId,
            );
        } catch {
            return null;
        }
    }

    /**
     * Get the deployment provider for a work
     */
    async getWorkProvider(workId: string): Promise<string | null> {
        const work = await this.workRepository.findById(workId);
        return work?.deployProvider ?? null;
    }

    /**
     * Set deployment provider for a work
     */
    async setWorkProvider(workId: string, providerId: string): Promise<void> {
        await this.workRepository.update(workId, {
            deployProvider: providerId,
        });
    }

    /**
     * Get the resolved plugin and token for deployment operations
     * (Used by the deploy service/controller)
     */
    async getPluginAndToken(options: DeployFacadeOptions): Promise<{
        plugin: IDeploymentPlugin;
        token: string;
        work: Work;
    }> {
        return this.resolvePluginAndTokenWithWork(options);
    }

    /**
     * Get the resolved plugin, token, work AND raw settings for deployment.
     * Settings include secrets — only the deploy service / orchestrators
     * should call this so it can push plugin-specific secrets via
     * `IDeploymentPlugin.getDeploymentSecrets(settings)`.
     */
    async getPluginAndTokenAndSettings(options: DeployFacadeOptions): Promise<{
        plugin: IDeploymentPlugin;
        token: string;
        work: Work;
        settings: Record<string, unknown>;
        settingSources: Record<string, SettingSource | undefined>;
    }> {
        const result = await this.resolvePluginAndTokenWithWork(options);
        const { settings, settingSources } = await this.getDeploymentSettingsSnapshot(
            result.plugin.id,
            options,
            true,
        );
        return { ...result, settings, settingSources };
    }

    /**
     * Resolve another plugin's user-scoped settings for the same deploy
     * request. The k8s deploy needs to read the GitHub plugin's
     * `readPackagesPat` to mint an imagePullSecret for private GHCR — but
     * the k8s plugin itself has no cross-plugin access. The deploy
     * orchestrator is the right layer to do this stitching, so this method
     * exposes the (already-injected) settings service in a controlled,
     * secret-including form.
     */
    async getOtherPluginSettings(
        pluginId: string,
        options: DeployFacadeOptions,
    ): Promise<Record<string, unknown>> {
        // Security: only allow reading secret settings for plugins the deploy
        // flow legitimately stitches across (currently just `github`). Reject
        // any other pluginId so this method cannot be used to fetch arbitrary
        // plugins' secrets for the request's user.
        if (!CROSS_PLUGIN_SETTINGS_ALLOWLIST.has(pluginId)) {
            throw new DeployFacadeError(
                `Cross-plugin settings access is not permitted for plugin '${pluginId}'`,
                'getOtherPluginSettings',
                pluginId,
            );
        }
        return this.settingsService.getSettings(pluginId, {
            userId: options.userId,
            workId: options.workId,
            includeSecrets: true,
        });
    }

    /**
     * Persist the PostgreSQL DB plugin's per-Work override connection string
     * (its work-scoped `overrideConnectionString`). The Deploy page is the only
     * UI that edits a Work's database, so it writes here to keep the plugin the
     * source of truth for the override. Pass an empty string to clear it (the
     * Work then inherits the account-level Ever Works DB / custom setting).
     * Confined to `postgres-db` via the same allow-list as
     * `getOtherPluginSettings`.
     */
    async setWorkDbOverride(workId: string, connectionString: string): Promise<void> {
        const pluginId = 'postgres-db';
        if (!CROSS_PLUGIN_SETTINGS_ALLOWLIST.has(pluginId)) {
            throw new DeployFacadeError(
                `Cross-plugin settings write is not permitted for plugin '${pluginId}'`,
                'setWorkDbOverride',
                pluginId,
            );
        }
        await this.settingsService.updateWorkSettings(pluginId, workId, {
            overrideConnectionString: connectionString ?? '',
        });
    }

    // Domain management methods
    // DB is the primary source of truth; provider APIs are used for sync and verification.

    /**
     * APW-06 T26 (plan §8.4:1152-1157) — the **early kind-`app` branch** of the four domain methods.
     *
     * §8.4: "`DeployFacadeService.getDomains/addDomain/removeDomain/verifyDomain` and
     * `ManagedSubdomainService` gain an early `if (work.kind === 'app')` branch that delegates to
     * `AppDomainsService`: rows stored as today; verify uses
     * `verifyDomainResolution(domain, runtimeState.ingressAddress)`; success → `updateVerified` +
     * reconcile/onChange; remove → row delete + reconcile."
     *
     * **Inert unless `AppDomainsService` is bound.** Every existing caller — every hand-constructed
     * fixture in `__tests__/deploy.facade.spec.ts` included — passes no seventh argument, so
     * `appDomains` is `undefined`, this returns `null` before it reads anything, and all four methods
     * take exactly the path they took before this branch existed. That is what keeps
     * `deploy.facade.spec.ts` green **unchanged** (`tasks.md:479`), and it is also why the kind check
     * costs no extra read for a non-App Work in a fixture.
     *
     * It is unbound in the API today (recorded gap C43, see the constructor note). Once a slice binds
     * it, the one `findById` below is the price of branching before the provider conversation — a
     * domain operation is a member's explicit click, not a hot path.
     */
    private async appDomainsFor(options: DeployFacadeOptions): Promise<AppDomainsService | null> {
        const appDomains = this.appDomains ?? this.lookupAppDomains();
        if (!appDomains) return null;

        try {
            const work = await this.workRepository.findById(options?.workId);
            // `work.kind` is compared as a string, never narrowed: APW-01 adds `'app'` to the shared
            // union additively and this facade must not care whether it has landed
            // (`app-launcher/managed-host-root.resolver.ts:48-70` is the same rule).
            return String(work?.kind ?? '')
                .trim()
                .toLowerCase() === APP_WORK_KIND
                ? appDomains
                : null;
        } catch (error) {
            // A Work that cannot be read is not an App Work here: the method's own resolution below
            // reports the missing Work with the error its callers already handle.
            this.logger.warn(`Reading work ${options?.workId} for its kind failed: ${error}`);

            return null;
        }
    }

    /** C43 — `AppDomainsService` from anywhere in the container, or `null` (never throws). */
    private lookupAppDomains(): AppDomainsService | null {
        if (!this.moduleRef) return null;
        try {
            return this.moduleRef.get(AppDomainsService, { strict: false }) ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Get domains for a deployed work.
     * Reads from DB, enriches with provider verification data when available.
     */
    async getDomains(options: DeployFacadeOptions): Promise<DeploymentDomain[]> {
        const appDomains = await this.appDomainsFor(options);

        if (appDomains) return appDomains.getDomains(options);

        const dbDomains = await this.domainRepository.findByWork(options.workId);
        const hasCustomDomain = dbDomains.some(
            (domain) => !this.isAutoAssignedDomain(domain.domain),
        );
        const shouldAutoImportProviderDomains = !hasCustomDomain;

        // Try to enrich with provider verification data
        let providerDomains: DeploymentDomain[] = [];
        let providerId: string | undefined;

        try {
            const { plugin, token, work } = await this.resolvePluginAndTokenWithWork(options);
            providerId = plugin.id;
            if (plugin.getDomains) {
                const deploymentContext = await this.resolveDeploymentLookupContext(
                    plugin,
                    token,
                    work,
                    options,
                );
                const projectId = await this.resolveProjectId(
                    plugin,
                    token,
                    work,
                    options,
                    deploymentContext,
                );
                providerDomains = await plugin.getDomains(
                    projectId,
                    deploymentContext.token,
                    deploymentContext.teamScope,
                    deploymentContext.context,
                );
                if (shouldAutoImportProviderDomains) {
                    await this.reconcileProviderDomains(options.workId, plugin.id, providerDomains);
                }
            }
        } catch (error) {
            this.logger.warn(`Failed to fetch provider domains for enrichment: ${error}`);
        }

        // Build a lookup map from provider data
        const providerMap = new Map<string, DeploymentDomain>();
        for (const pd of providerDomains) {
            providerMap.set(pd.name, pd);
        }

        const merged = dbDomains.map((dbDomain) => {
            const providerData = providerMap.get(dbDomain.domain);
            return {
                name: dbDomain.domain,
                verified: providerData?.verified ?? dbDomain.verified,
                verification: providerData?.verification,
            };
        });

        if (shouldAutoImportProviderDomains) {
            const dbDomainNames = new Set(dbDomains.map((domain) => domain.domain));
            for (const providerDomain of providerDomains) {
                if (dbDomainNames.has(providerDomain.name)) continue;

                merged.push({
                    name: providerDomain.name,
                    verified: providerDomain.verified,
                    verification: providerDomain.verification,
                });
            }
        }

        if (providerId && providerDomains.length > 0) {
            this.logger.debug(
                `Resolved ${providerDomains.length} domain(s) from provider ${providerId} for work ${options.workId}`,
            );
        }

        return this.sortDomainsForDisplay(merged);
    }

    private async reconcileProviderDomains(
        workId: string,
        providerId: string,
        providerDomains: DeploymentDomain[],
    ): Promise<void> {
        for (const providerDomain of providerDomains) {
            try {
                const existing = await this.domainRepository.findOne(workId, providerDomain.name);
                if (!existing) {
                    await this.domainRepository.addDomain(workId, providerDomain.name, providerId);
                } else if (existing.provider !== providerId) {
                    await this.domainRepository.updateProvider(
                        workId,
                        providerDomain.name,
                        providerId,
                    );
                }

                await this.domainRepository.updateVerified(
                    workId,
                    providerDomain.name,
                    providerDomain.verified,
                );
            } catch (error) {
                this.logger.warn(
                    `Failed to reconcile provider domain "${providerDomain.name}" for work ${workId}: ${error}`,
                );
            }
        }
    }

    /**
     * Add a domain to a deployed work.
     * Provider state is checked first so domains already attached outside Ever Works are imported.
     */
    async addDomain(domain: string, options: DeployFacadeOptions): Promise<AddDomainResult> {
        // Security: a name equal to or under one of the platform's root domains is never a
        // member's custom domain. The shared cluster would otherwise serve their site on a
        // platform-looking host (`login.ever.works`). Refused here, first, before any read, any
        // plugin call or any DB write, so no caller can skip it, the HTTP route included. That also
        // covers a re-add of a row that already exists: the existing-row return below comes after
        // the provider lookup (`plugin.getDomains`), so it is refused too. The stored row itself
        // is untouched and stays on the Ingress.
        assertNotPlatformHost(domain, config.everWorks.platformRootDomains());

        const appDomains = await this.appDomainsFor(options);

        if (appDomains) return appDomains.addDomain(domain, options);

        const { plugin, token, work } = await this.resolvePluginAndTokenWithWork(options);
        if (!plugin.addDomain) {
            throw new DeployFacadeError(
                'Domain management is not supported by this provider',
                'addDomain',
                plugin.id,
            );
        }

        const deploymentContext = await this.resolveDeploymentLookupContext(
            plugin,
            token,
            work,
            options,
        );
        const projectId = await this.resolveProjectId(
            plugin,
            token,
            work,
            options,
            deploymentContext,
        );
        const existing = await this.domainRepository.findOne(options.workId, domain);

        if (plugin.getDomains) {
            const providerDomain = await this.findProviderDomain(
                plugin,
                projectId,
                deploymentContext,
                domain,
            );

            if (providerDomain) {
                await this.reconcileProviderDomains(options.workId, plugin.id, [providerDomain]);
                await this.promoteVerifiedDomainWebsite(work, providerDomain);
                return {
                    domain: providerDomain,
                    verified: providerDomain.verified,
                };
            }
        }

        if (existing) {
            return {
                domain: {
                    name: existing.domain,
                    verified: existing.verified,
                },
                verified: existing.verified,
            };
        }

        // Push to provider
        let result: AddDomainResult;
        try {
            result = await plugin.addDomain(
                projectId,
                domain,
                deploymentContext.token,
                deploymentContext.teamScope,
                deploymentContext.context,
            );
        } catch (error) {
            throw error;
        }

        await this.domainRepository.addDomain(options.workId, domain, plugin.id);
        if (result.verified) {
            await this.domainRepository.updateVerified(options.workId, domain, true);
            await this.promoteVerifiedDomainWebsite(work, result.domain);
        }

        // EW-741 — in BYO Cloudflare mode (user-scoped DNS plugin with the
        // required settings present), also create the custom-domain DNS
        // record in the user's zone. Best-effort: a failure here logs but
        // never fails the request — matches the fire-and-forget pattern the
        // managed subdomain uses today. When the user is on operator-managed
        // DNS (no user-scoped plugin settings) this is a no-op so existing
        // behavior is preserved (custom-domain DNS stays guidance-only).
        void this.ensureCustomDomainRecordBestEffort(domain, options).catch((cause) => {
            this.logger.warn(
                `EW-741 BYO custom-domain ensureRecord failed for ${domain}: ${(cause as Error).message}`,
            );
        });

        return result;
    }

    /**
     * EW-741 — best-effort: create a DNS record for a newly-added custom
     * domain in the user's own DNS zone, when a user-scoped DNS plugin is
     * resolvable for them. The plugin must:
     *   - declare the four `dns-*` capabilities (full `IDnsProvider` shape),
     *   - have user-scoped settings present for `(userId, workId)` — this is
     *     the operator-managed → BYO discriminator. The operator-managed
     *     `EverWorksDnsService` is wired at the agent level (not the plugin
     *     registry) so it never enters this branch.
     *
     * The LB hostname is read from `EVER_WORKS_DEPLOY_LB_HOSTNAME` (same env
     * the managed subdomain CNAME uses). When unset, this is a no-op — we'd
     * have nothing meaningful to point the record at.
     */
    private async ensureCustomDomainRecordBestEffort(
        domain: string,
        options: DeployFacadeOptions,
    ): Promise<void> {
        const lbTarget = process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME?.trim() ?? '';
        if (!lbTarget) {
            return;
        }
        const dnsProviders = this.registry
            .getByCapability('dns-ensure-record')
            .filter((p) => p.state === 'loaded');
        for (const registered of dnsProviders) {
            const plugin = registered.plugin;
            if (!isDnsProvider(plugin as IDnsProvider)) {
                continue;
            }
            let userSettings: Record<string, unknown> = {};
            try {
                userSettings = await this.settingsService.getSettings(plugin.id, {
                    userId: options.userId,
                    workId: options.workId,
                    includeSecrets: true,
                });
            } catch {
                continue;
            }
            // BYO discriminator: the user must have actively configured this
            // plugin (any non-empty setting). A plugin with no user-scoped
            // settings is operator-managed only and must not be used for
            // per-user custom-domain DNS.
            const hasUserConfig = Object.values(userSettings).some(
                (value) => value !== undefined && value !== null && value !== '',
            );
            if (!hasUserConfig) {
                continue;
            }
            const proxied =
                typeof userSettings.proxied === 'boolean' ? userSettings.proxied : false;
            try {
                await (plugin as IDnsProvider).ensureRecord({
                    host: domain,
                    type: 'CNAME',
                    target: lbTarget,
                    proxied,
                });
                this.logger.log(
                    `EW-741 BYO custom-domain CNAME ensured for ${domain} via ${plugin.id}`,
                );
            } catch (cause) {
                this.logger.warn(
                    `EW-741 BYO custom-domain ensureRecord failed for ${domain} via ${plugin.id}: ${(cause as Error).message}`,
                );
            }
            // Stop after the first resolvable user-scoped DNS plugin — we
            // never fan-out across multiple zones for a single custom domain.
            return;
        }
    }

    private async findProviderDomain(
        plugin: IDeploymentPlugin,
        projectId: string,
        deploymentContext: EffectiveDeploymentOperationContext,
        domain: string,
    ): Promise<DeploymentDomain | undefined> {
        if (!plugin.getDomains) return undefined;

        try {
            const providerDomains = await plugin.getDomains(
                projectId,
                deploymentContext.token,
                deploymentContext.teamScope,
                deploymentContext.context,
            );
            return providerDomains.find((item) => item.name === domain);
        } catch (error) {
            this.logger.warn(
                `Failed to check provider domains before adding "${domain}": ${error}`,
            );
            return undefined;
        }
    }

    private async promoteVerifiedDomainWebsite(
        work: Work,
        domain: DeploymentDomain,
    ): Promise<void> {
        if (!domain.verified) return;

        // Only promote to primary URL if current website is auto-assigned or unset
        const currentHost = this.extractHostname(work.website);
        const isAutoAssigned = !currentHost || this.isAutoAssignedDomain(currentHost);
        if (!isAutoAssigned) return;

        await this.workRepository.update(work.id, {
            website: `https://${domain.name}`,
        });
    }

    private extractHostname(value?: string | null): string | undefined {
        if (!value) return undefined;
        try {
            return new URL(value).hostname.toLowerCase();
        } catch {
            return (
                value
                    .replace(/^https?:\/\//, '')
                    .split('/')[0]
                    ?.toLowerCase() || undefined
            );
        }
    }

    private isAutoAssignedDomain(domain: string): boolean {
        const host = this.extractHostname(domain);
        if (!host) return false;

        const everWorksDomain = (process.env.EVER_WORKS_DOMAIN || 'ever.works')
            .trim()
            .replace(/^\.+|\.+$/g, '')
            .toLowerCase();

        return (
            host.endsWith('.vercel.app') ||
            (Boolean(everWorksDomain) &&
                (host === everWorksDomain || host.endsWith(`.${everWorksDomain}`)))
        );
    }

    private sortDomainsForDisplay(domains: DeploymentDomain[]): DeploymentDomain[] {
        return [...domains].sort((left, right) => {
            const leftAutoAssigned = this.isAutoAssignedDomain(left.name);
            const rightAutoAssigned = this.isAutoAssignedDomain(right.name);

            if (leftAutoAssigned === rightAutoAssigned) {
                return left.name.localeCompare(right.name);
            }

            return leftAutoAssigned ? 1 : -1;
        });
    }

    /**
     * Remove a domain from a deployed work.
     * Removes from provider first, then from DB.
     */
    async removeDomain(domain: string, options: DeployFacadeOptions): Promise<boolean> {
        const appDomains = await this.appDomainsFor(options);

        if (appDomains) return (await appDomains.removeDomain(domain, options)).removed;

        const { plugin, token, work } = await this.resolvePluginAndTokenWithWork(options);
        let deploymentContext: EffectiveDeploymentOperationContext | undefined;
        const getDeploymentContext = async (): Promise<EffectiveDeploymentOperationContext> => {
            deploymentContext ??= await this.resolveDeploymentLookupContext(
                plugin,
                token,
                work,
                options,
            );
            return deploymentContext;
        };

        // If provider supports removal and domain is synced, remove from provider
        const dbRecord = await this.domainRepository.findOne(options.workId, domain);
        if (dbRecord?.provider && plugin.removeDomain) {
            try {
                const effective = await getDeploymentContext();
                const projectId = await this.resolveProjectId(
                    plugin,
                    token,
                    work,
                    options,
                    effective,
                );
                await plugin.removeDomain(
                    projectId,
                    domain,
                    effective.token,
                    effective.teamScope,
                    effective.context,
                );
            } catch (error) {
                this.logger.warn(
                    `Failed to remove domain from provider, removing from DB anyway: ${error}`,
                );
            }
        }

        // Remove from DB
        const removed = await this.domainRepository.removeDomain(options.workId, domain);

        // If the removed domain was the current website URL, re-lookup to update
        if (removed && work.website === `https://${domain}`) {
            try {
                if (plugin.lookupExistingDeployment) {
                    const lookupContext = await getDeploymentContext();
                    const lookup = await plugin.lookupExistingDeployment(
                        work.getWebsiteRepo(),
                        lookupContext.token,
                        lookupContext.teamScope,
                        lookupContext.context,
                    );
                    await this.workRepository.update(work.id, {
                        website: lookup.website ?? undefined,
                    });
                }
            } catch (error) {
                this.logger.warn(`Failed to re-lookup website URL after domain removal: ${error}`);
            }
        }

        return removed;
    }

    /**
     * Verify a domain on a deployed work.
     * Verifies at provider, updates DB with result.
     */
    async verifyDomain(domain: string, options: DeployFacadeOptions): Promise<DeploymentDomain> {
        const appDomains = await this.appDomainsFor(options);

        // §8.4: "verify uses `verifyDomainResolution(domain, runtimeState.ingressAddress)`; success
        // → `updateVerified` + reconcile/onChange" — all of it inside `AppDomainsService`, so the
        // facade keeps its own contract (`DeploymentDomain`) and no provider is asked for an App
        // Work's domain.
        if (appDomains) return (await appDomains.verifyDomain(domain, options)).domain;

        const { plugin, token, work } = await this.resolvePluginAndTokenWithWork(options);
        if (!plugin.verifyDomain) {
            throw new DeployFacadeError(
                'Domain management is not supported by this provider',
                'verifyDomain',
                plugin.id,
            );
        }
        const deploymentContext = await this.resolveDeploymentLookupContext(
            plugin,
            token,
            work,
            options,
        );
        const projectId = await this.resolveProjectId(
            plugin,
            token,
            work,
            options,
            deploymentContext,
        );
        const result = await plugin.verifyDomain(
            projectId,
            domain,
            deploymentContext.token,
            deploymentContext.teamScope,
            deploymentContext.context,
        );

        // Update DB with verification result
        await this.domainRepository.updateVerified(options.workId, domain, result.verified);

        // Only promote to primary URL if current website is auto-assigned or unset
        if (result.verified) {
            const isAutoAssigned = !work.website || work.website.endsWith('.vercel.app');
            if (isAutoAssigned) {
                await this.workRepository.update(work.id, {
                    website: `https://${result.name}`,
                });
            }
        }

        return result;
    }

    /**
     * Prepare the removal of a website Work's platform-held runtime objects
     * (Ingress, Service, Deployment, the Secrets the deploy wrote) for when the
     * Work is deleted.
     *
     * Call it BEFORE the Work row is deleted: the cluster, namespace and
     * kubeconfig are resolved exactly as the deploy resolved them, and that
     * reads the Work's own plugin settings (`clusterSource`, `namespace`), which
     * go with the row. Run the returned step AFTER the row is gone.
     *
     * Only a platform-managed target is prepared: the managed `ever-works`
     * provider, or `k8s` on `k8s-works` / `k8s-works-shared`, and only with the
     * platform's own kubeconfig. A member's own cluster (`custom-kubeconfig`, or
     * the member's kubeconfig the `ever-works` deploy falls back to when the
     * platform holds none) is theirs to clean up, and the platform's view of it
     * may be stale. It is also skipped when another Work deploys, or may deploy,
     * to the same namespace and object name, since those objects then serve that
     * Work too: the objects' labels name the website repository, not the Work,
     * so this check is what tells two Works apart.
     *
     * That check reads only this environment's database, so the whole
     * teardown runs only where `EVER_WORKS_K8S_WORKS_CLUSTER_OWNER=true`
     * (`not_cluster_owner` elsewhere): dev, stage and prod may list the same
     * cluster.
     *
     * Never throws: anything it cannot resolve is `skipped` with the reason.
     */
    async prepareWorkDeploymentTeardown(
        options: DeployFacadeOptions,
    ): Promise<WorkDeploymentTeardownPreparation> {
        try {
            const work = await this.workRepository.findById(options.workId);
            if (!work) {
                return { status: 'skipped', reason: 'not_found' };
            }
            if (
                isAppKind(work) ||
                (work.deployProvider !== EVER_WORKS_DEPLOY_PROVIDER_ID &&
                    work.deployProvider !== KUBERNETES_DEPLOY_PROVIDER_ID)
            ) {
                return { status: 'skipped', reason: 'not_managed' };
            }

            // Same settings the deploy layered (non-secret ones are enough: the
            // cluster source and namespace). A `k8s` Work on the member's own
            // cluster stops here, before any credential is resolved.
            const pluginId = resolvePluginProviderId(work.deployProvider);
            const { settings, settingSources } = await this.getDeploymentSettingsSnapshot(
                pluginId,
                options,
                false,
            );
            if (
                work.deployProvider === KUBERNETES_DEPLOY_PROVIDER_ID &&
                coerceDeploymentClusterSource(settings.clusterSource) === 'custom-kubeconfig'
            ) {
                return { status: 'skipped', reason: 'not_managed' };
            }
            // The platform's clusters may be shared by several environments
            // (dev, stage and prod list the same `k8s-works` credential; a
            // slug-derived namespace ends in that environment's
            // `EVER_WORKS_K8S_WORKS_NAMESPACE_SUFFIX`, but an explicit namespace
            // can still name another environment's). The sharer check below
            // sees only this database, so it decides only in the environment
            // that owns the clusters.
            if (!config.everWorks.deploy.isClusterOwner()) {
                return {
                    status: 'skipped',
                    reason: 'not_cluster_owner',
                    detail: 'EVER_WORKS_K8S_WORKS_CLUSTER_OWNER is not true in this environment',
                };
            }

            let plugin: IDeploymentPlugin;
            let token: string;
            if (work.deployProvider === EVER_WORKS_DEPLOY_PROVIDER_ID) {
                // The platform's kubeconfig only. The deploy falls back to the
                // member's own `k8s` kubeconfig when the platform holds none; the
                // teardown never does, as that would aim it at the member's cluster.
                plugin = this.resolveRegisteredDeployPlugin(work.deployProvider);
                if (typeof plugin.removeWorkDeployment !== 'function') {
                    return { status: 'skipped', reason: 'unsupported' };
                }
                const managedKubeconfig = await this.resolveEverWorksManagedKubeconfig();
                if (!managedKubeconfig) {
                    return {
                        status: 'skipped',
                        reason: 'unresolved',
                        detail: 'no platform kubeconfig for the ever-works provider',
                    };
                }
                token = managedKubeconfig;
            } else {
                // `k8s` on `k8s-works` / `k8s-works-shared`: the resolver below
                // replaces the settings token with the platform's kubeconfig for
                // that cluster source (and fails when it is not configured).
                ({ plugin, token } = await this.resolvePluginAndTokenForWork(work, options));
                if (typeof plugin.removeWorkDeployment !== 'function') {
                    return { status: 'skipped', reason: 'unsupported' };
                }
            }

            const effective = resolveEffectiveDeploymentContext(
                this.effectiveContextInput(work, plugin.id, token, settings, settingSources),
            );
            const namespace = effective.namespace;
            if (!namespace || isReservedDeployNamespace(namespace)) {
                return { status: 'skipped', reason: 'no_namespace' };
            }
            if (!effective.token.trim()) {
                return { status: 'skipped', reason: 'unresolved', detail: 'no cluster credential' };
            }

            const objectName = normaliseObjectName(work.getWebsiteRepo());
            const target = `${namespace}/${objectName}`;
            const sharer = await this.findDeploymentSharer(work, plugin.id, namespace, objectName);
            if (sharer) {
                return {
                    status: 'skipped',
                    reason: 'shared',
                    detail: describeDeploymentSharer(sharer, namespace, target),
                };
            }

            const removeWorkDeployment = plugin.removeWorkDeployment.bind(plugin);
            // The raw website repository, as `deploy()` received it: the plugin
            // sanitises it the same way, so its object names are `objectName`.
            const projectName = work.getWebsiteRepo();
            const credential = effective.token;
            const context = effective.lookupContext;
            const cachedTarget = kubernetesDeploymentId(work.deployProjectId);
            return {
                status: 'ready',
                namespace,
                objectName,
                ...(cachedTarget && cachedTarget !== target ? { staleTarget: cachedTarget } : {}),
                run: () => removeWorkDeployment(projectName, credential, context),
            };
        } catch (error) {
            // An explicit reserved namespace is refused by the resolver itself;
            // it is the same "no usable namespace" case as the check above.
            if (
                error instanceof DeploymentContextResolutionError &&
                error.code === 'RESERVED_NAMESPACE'
            ) {
                return { status: 'skipped', reason: 'no_namespace' };
            }
            // `detail` goes to the server log (`deleteWork` warns with it), so it
            // carries the reason code only, never the error's message.
            return { status: 'skipped', reason: 'unresolved', detail: teardownFailureCode(error) };
        }
    }

    /**
     * Another Work that deploys, or may deploy, to `namespace/objectName`, or
     * `null`. The candidates are:
     *
     * - every Work of the same owner, whatever its provider now: a tenant
     *   namespace is derived from the owner, and a Work moved to another
     *   provider leaves its objects running (they may still serve its custom
     *   domain), with nothing recording where they were. Such a Work counts as
     *   a sharer (`why: 'moved'`);
     * - every `k8s` Work of any owner: a `k8s-works` namespace is set
     *   explicitly or derived from a truncated slug, so it is not tied to an
     *   owner (the set is small: `k8s` is opt-in and `k8s-works` admin-only);
     * - every Kubernetes-family Work with the same slug;
     * - when `namespace` is another tenant's namespace (a `k8s-works` Work can
     *   name one explicitly), every Work of that tenant, whatever its provider,
     *   for the same reason as the owner's. When which tenant cannot be read
     *   back from the name, the teardown is skipped (`why: 'unreadable_tenant'`);
     * - every Work, of any owner and any provider, whose cached
     *   `deployProjectId` is `namespace/objectName`.
     *
     * A Work whose cached `deployProjectId` is `namespace/objectName` is a
     * sharer outright (`why: 'cached_target'`), whatever its website
     * repository, provider or settings say now. That field is set when the
     * platform first looks the deployment up and is not rewritten, so it names
     * where that Work's objects were, not necessarily where they are.
     *
     * Otherwise only Works whose website repository gives the same object name
     * count. Each Kubernetes-family candidate's namespace is worked out with its
     * own settings. One that is explicitly reserved can never be ours (ours is
     * not reserved), so it is skipped. One that cannot be worked out counts as a
     * sharer (`why: 'unresolved'`): leaving the objects is the safe side, so a
     * transient settings error leaves them for an operator, and the skip's
     * detail says which Work could not be read.
     */
    private async findDeploymentSharer(
        work: Work,
        pluginId: string,
        namespace: string,
        objectName: string,
    ): Promise<DeploymentSharer | null> {
        const target = `${namespace}/${objectName}`;
        const ownerId = (work.user as User | undefined)?.id ?? work.userId;
        const foreignTenant = foreignTenantOf(namespace, ownerId);
        if (foreignTenant === 'unreadable') {
            return { why: 'unreadable_tenant' };
        }
        const tenantUserId = foreignTenant?.tenantId;
        const candidates = await this.workRepository.findDeploymentSharerCandidates(
            work.userId,
            work.slug,
            { tenantUserId, deployProjectId: target },
        );
        for (const candidate of candidates) {
            if (candidate.id === work.id || isAppKind(candidate)) continue;
            // Before the name check: its repository may have been renamed since.
            if (kubernetesDeploymentId(candidate.deployProjectId) === target) {
                return { id: candidate.id, why: 'cached_target' };
            }
            if (normaliseObjectName(candidate.getWebsiteRepo()) !== objectName) continue;
            if (!isKubernetesFamilyProvider(candidate.deployProvider)) {
                // Only the owner's and the namespace tenant's Works can have
                // left objects here from a Kubernetes deploy before a move.
                const sameOwner = candidate.userId === work.userId;
                if (!sameOwner && (!tenantUserId || candidate.userId !== tenantUserId)) continue;
                return {
                    id: candidate.id,
                    why: 'moved',
                    provider: candidate.deployProvider ?? null,
                    sameOwner,
                };
            }
            try {
                const { settings, settingSources } = await this.getDeploymentSettingsSnapshot(
                    pluginId,
                    { userId: candidate.userId, workId: candidate.id },
                    false,
                );
                const candidateNamespace = resolveKubernetesDeployNamespace(
                    this.effectiveContextInput(candidate, pluginId, '', settings, settingSources),
                );
                if (candidateNamespace === namespace) {
                    return { id: candidate.id, why: 'resolved' };
                }
            } catch (error) {
                if (
                    error instanceof DeploymentContextResolutionError &&
                    error.code === 'RESERVED_NAMESPACE'
                ) {
                    // Its deploy target is a reserved namespace; ours is not.
                    continue;
                }
                // Unknown namespace (settings unreadable): it may be ours, so it
                // blocks the teardown rather than letting it through.
                return { id: candidate.id, why: 'unresolved' };
            }
        }
        return null;
    }

    /**
     * Report the website deployments on the platform's own clusters that no
     * Work accounts for: what a skipped or failed Work-delete teardown left
     * running. REPORT ONLY: it lists and compares, and never removes anything;
     * removing what it names needs the owner's explicit yes first.
     *
     * It runs only where `EVER_WORKS_K8S_WORKS_CLUSTER_OWNER=true`
     * (`skipped: 'not_cluster_owner'` elsewhere). It compares a whole
     * cluster's deployments with this environment's Works alone, so in an
     * environment that shares the cluster with another, every Work of the
     * other would look orphaned.
     *
     * The clusters are the platform's kubeconfigs (the managed `ever-works`
     * one, `EVER_WORKS_K8S_WORKS_KUBECONFIG`, `EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG`),
     * each listed once, and each list gets at most
     * {@link workDeploymentListTimeoutMs} (a hung one is `failed: 'TIMEOUT'`).
     * A deployment is accounted for when its `namespace/name` is the deploy
     * target of an `ever-works` or `k8s` Work (worked out as the deploy works
     * it out), or the deploy target any Work has cached (`deployProjectId`: a
     * Work that moved off Kubernetes keeps it). The targets are compared across
     * clusters, not per cluster, so an orphan can hide behind a live Work's
     * target on another cluster; never the reverse. A deployment that two
     * credentials both list is named once, with both.
     *
     * Reading a `k8s` Work's settings may let the settings service tidy that
     * Work's stored plugin settings once (`normalizeWorkDefaultShadows`), as a
     * deploy or a teardown does; nothing else is written.
     *
     * Never throws: a failed list is reported per cluster with a reason code.
     */
    async reportOrphanedWorkDeployments(): Promise<WorkDeploymentOrphanReport> {
        const nothing = (
            skipped: NonNullable<WorkDeploymentOrphanReport['skipped']>,
            detail?: string,
        ): WorkDeploymentOrphanReport => ({
            skipped,
            ...(detail ? { detail } : {}),
            clusters: [],
            orphans: [],
            unresolvedWorks: 0,
        });

        if (!config.everWorks.deploy.isClusterOwner()) {
            return nothing('not_cluster_owner');
        }

        let plugin: IDeploymentPlugin;
        try {
            plugin = this.resolveRegisteredDeployPlugin(KUBERNETES_DEPLOY_PROVIDER_ID);
        } catch {
            return nothing('unsupported');
        }
        if (typeof plugin.listWorkDeployments !== 'function') {
            return nothing('unsupported');
        }
        const listWorkDeployments = plugin.listWorkDeployments.bind(plugin);

        let clusters: PlatformClusterCredential[];
        try {
            clusters = await this.platformDeployClusters();
        } catch (error) {
            // The managed kubeconfig lookup is meant not to throw; if it does,
            // there is no credential to list with.
            return nothing('no_cluster', teardownFailureCode(error));
        }
        if (clusters.length === 0) {
            return nothing('no_cluster');
        }

        let known: KnownWorkDeploymentTargets;
        try {
            known = await this.knownWorkDeploymentTargets(plugin.id);
        } catch (error) {
            // Without the Works, every deployment would look orphaned.
            return nothing('works_unreadable', teardownFailureCode(error));
        }

        const listed: Array<WorkDeploymentOrphanReport['clusters'][number]> = [];
        const orphans = new Map<string, { namespace: string; name: string; clusters: string[] }>();
        for (const cluster of clusters) {
            try {
                const refs = await this.withListTimeout<readonly WorkDeploymentRef[]>(
                    listWorkDeployments(cluster.kubeconfig, {
                        settingsOverride: cluster.clusterSource
                            ? { clusterSource: cluster.clusterSource }
                            : {},
                        kubeContextOverride: null,
                    }),
                );
                listed.push({ names: cluster.names, listed: refs.length });
                for (const ref of refs) {
                    const key = `${ref.location}/${ref.name}`;
                    if (known.targets.has(key)) continue;
                    if (known.unresolvedNames.has(ref.name)) continue;
                    const label = cluster.names.join('+');
                    const seen = orphans.get(key);
                    if (seen) {
                        // Another credential reaches the same cluster.
                        if (!seen.clusters.includes(label)) seen.clusters.push(label);
                        continue;
                    }
                    orphans.set(key, {
                        namespace: ref.location,
                        name: ref.name,
                        clusters: [label],
                    });
                }
            } catch (error) {
                listed.push({
                    names: cluster.names,
                    listed: 0,
                    failed: teardownFailureCode(error),
                });
            }
        }
        return {
            clusters: listed,
            orphans: [...orphans.values()].map((orphan) => ({
                cluster: orphan.clusters.join(', '),
                namespace: orphan.namespace,
                name: orphan.name,
            })),
            unresolvedWorks: known.unresolvedWorks,
        };
    }

    /**
     * How long one cluster's list may take in the orphan report. The
     * Kubernetes client sets no request timeout, so a half-open connection
     * would otherwise hold the report, and its daily lock, for hours.
     */
    private readonly workDeploymentListTimeoutMs = 60_000;

    /** `listing`, or a `TIMEOUT` rejection after {@link workDeploymentListTimeoutMs}. */
    private withListTimeout<T>(listing: Promise<T>): Promise<T> {
        // The list is read-only: if it is abandoned, a late failure is dropped.
        listing.catch(() => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(Object.assign(new Error('list timed out'), { code: 'TIMEOUT' })),
                this.workDeploymentListTimeoutMs,
            );
            timer.unref?.();
        });
        return Promise.race([listing, timeout]).finally(() => clearTimeout(timer));
    }

    /**
     * The platform's cluster credentials, each distinct one once (the managed
     * `ever-works` one may BE the shared cluster's: Path B), with the cluster
     * source a `k8s` deploy names it by.
     */
    private async platformDeployClusters(): Promise<PlatformClusterCredential[]> {
        const sources: Array<{
            name: PlatformDeployCluster;
            kubeconfig: string | null | undefined;
            clusterSource?: 'k8s-works' | 'k8s-works-shared';
        }> = [
            {
                name: 'k8s-works',
                kubeconfig: process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG,
                clusterSource: 'k8s-works',
            },
            {
                name: 'k8s-works-shared',
                kubeconfig: process.env.EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG,
                clusterSource: 'k8s-works-shared',
            },
            { name: 'ever-works', kubeconfig: await this.resolveEverWorksManagedKubeconfig() },
        ];
        const clusters: PlatformClusterCredential[] = [];
        for (const source of sources) {
            const kubeconfig = source.kubeconfig?.trim();
            if (!kubeconfig) continue;
            const same = clusters.find((cluster) => cluster.kubeconfig === kubeconfig);
            if (same) {
                same.names.push(source.name);
                continue;
            }
            clusters.push({
                names: [source.name],
                kubeconfig,
                ...(source.clusterSource ? { clusterSource: source.clusterSource } : {}),
            });
        }
        return clusters;
    }

    /**
     * Every `namespace/name` an `ever-works` or `k8s` Work deploys to, every
     * deploy target a Work of any provider has cached (`deployProjectId`), and
     * the object names of the Works whose target could not be worked out. An
     * `ever-works` Work's namespace is its owner's tenant namespace whatever
     * its settings say, so only a `k8s` Work's settings are read. Throws when
     * the Works cannot be loaded.
     */
    private async knownWorkDeploymentTargets(
        pluginId: string,
    ): Promise<KnownWorkDeploymentTargets> {
        const works = await this.workRepository.findWorkDeploymentReportCandidates([
            EVER_WORKS_DEPLOY_PROVIDER_ID,
            KUBERNETES_DEPLOY_PROVIDER_ID,
        ]);
        const targets = new Set<string>();
        const unresolvedNames = new Set<string>();
        let unresolvedWorks = 0;
        for (const work of works) {
            if (isAppKind(work)) continue;
            const cachedTarget = kubernetesDeploymentId(work.deployProjectId);
            if (cachedTarget) targets.add(cachedTarget);
            // A Work on another provider now counts by its cached target only.
            if (!isKubernetesFamilyProvider(work.deployProvider)) continue;
            const objectName = normaliseObjectName(work.getWebsiteRepo());
            if (!objectName) continue;
            try {
                let settings: Record<string, unknown> = {};
                let settingSources: Record<string, SettingSource | undefined> = {};
                if (work.deployProvider === KUBERNETES_DEPLOY_PROVIDER_ID) {
                    ({ settings, settingSources } = await this.getDeploymentSettingsSnapshot(
                        pluginId,
                        { userId: work.userId, workId: work.id },
                        false,
                    ));
                }
                const namespace = resolveKubernetesDeployNamespace(
                    this.effectiveContextInput(work, pluginId, '', settings, settingSources),
                );
                if (namespace) targets.add(`${namespace}/${objectName}`);
            } catch (error) {
                if (
                    error instanceof DeploymentContextResolutionError &&
                    error.code === 'RESERVED_NAMESPACE'
                ) {
                    // A reserved namespace is never a deploy target.
                    continue;
                }
                unresolvedNames.add(objectName);
                unresolvedWorks += 1;
            }
        }
        return { targets, unresolvedNames, unresolvedWorks };
    }

    private effectiveContextInput(
        work: Work,
        pluginId: string,
        resolvedToken: string,
        settings: Record<string, unknown>,
        settingSources: Record<string, SettingSource | undefined>,
    ): EffectiveDeploymentContextInput {
        const owner = work.user as User | undefined;
        return {
            deployProvider: work.deployProvider,
            pluginId,
            resolvedToken,
            settings,
            settingSources,
            websiteOwner: work.getRepoOwner('website'),
            websiteProjectName: work.getWebsiteRepo(),
            workId: work.id,
            workSlug: work.slug,
            managedSubdomain: work.managedSubdomain,
            ownerUserId: owner?.id ?? work.userId,
            isPlatformAdmin: Boolean(owner?.isPlatformAdmin),
        };
    }

    // Private methods

    private async resolvePluginAndToken(options: DeployFacadeOptions): Promise<{
        plugin: IDeploymentPlugin;
        token: string;
    }> {
        const { plugin, token } = await this.resolvePluginAndTokenWithWork(options);
        return { plugin, token };
    }

    private async resolvePluginAndTokenWithWork(options: DeployFacadeOptions): Promise<{
        plugin: IDeploymentPlugin;
        token: string;
        work: Work;
    }> {
        const work = await this.workRepository.findById(options.workId);
        if (!work) {
            throw new DeployFacadeError(`Work not found: ${options.workId}`, 'resolvePlugin');
        }
        return this.resolvePluginAndTokenForWork(work, options);
    }

    private async resolvePluginAndTokenForWork(
        work: Work,
        options: DeployFacadeOptions,
    ): Promise<{
        plugin: IDeploymentPlugin;
        token: string;
        work: Work;
    }> {
        const providerId = work.deployProvider;
        if (!providerId) {
            throw new NoDeployProviderError();
        }

        const pluginProviderId = resolvePluginProviderId(providerId);
        const registered = this.resolveRegisteredDeployment(providerId);

        // Get token from plugin settings (user-required mode)
        let token = await this.getTokenFromSettings(
            pluginProviderId,
            options.userId,
            options.workId,
        );

        // Task 10 (Path A + Path B) — for the managed `ever-works` provider,
        // source the deploy kubeconfig from the platform env (dedicated tenant
        // cluster, or the shared customer cluster) instead of the user's k8s
        // settings. When neither env is provisioned this returns null and we
        // keep the existing sentinel/user-kubeconfig behaviour so nothing
        // regresses and a downstream layer surfaces the clear "not available
        // yet" error rather than crashing.
        if (providerId === EVER_WORKS_DEPLOY_PROVIDER_ID) {
            const managedKubeconfig = await this.resolveEverWorksManagedKubeconfig();
            if (managedKubeconfig) {
                token = managedKubeconfig;
            }
        }

        if (!token) {
            // The plugin may still be a cold lazy proxy, whose `providerName`
            // read is its forwarding wrapper — a function, whose source text
            // ended up in the message. The manifest name then.
            const providerName =
                readPluginString(registered.plugin, 'providerName') || registered.plugin.name;
            throw new NoDeployCredentialsError(providerId, options.userId, providerName);
        }

        return {
            plugin: registered.plugin as IDeploymentPlugin,
            token,
            work,
        };
    }

    /** The loaded deployment plugin registered for `providerId`; throws when there is none. */
    private resolveRegisteredDeployment(providerId: string) {
        const registered = this.registry.get(resolvePluginProviderId(providerId));
        if (!registered || !registered.manifest.capabilities.includes(this.CAPABILITY)) {
            throw new DeployProviderNotFoundError(providerId);
        }
        if (registered.state !== 'loaded') {
            throw new DeployProviderNotFoundError(providerId);
        }
        return registered;
    }

    /** {@link resolveRegisteredDeployment}'s plugin, without resolving any credential. */
    private resolveRegisteredDeployPlugin(providerId: string): IDeploymentPlugin {
        return this.resolveRegisteredDeployment(providerId).plugin as IDeploymentPlugin;
    }

    /**
     * Task 10 — resolve the platform-held kubeconfig for a managed
     * `ever-works` deploy. The owner chose BOTH managed backends; which one is
     * live is decided purely by which env var the infra owner provisioned:
     *
     *   - **Path A (dedicated tenant cluster):**
     *     `EVER_WORKS_DEPLOY_KUBECONFIG` / `EVER_WORKS_DEPLOY_KUBECONFIG_PATH`
     *     — resolved via `EverWorksK8sDeployProvider` (preferred when enabled).
     *   - **Path B (shared customer cluster):**
     *     `EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG` — read directly here as a
     *     fallback when the dedicated cluster is not configured.
     *
     * Returns `null` when neither is configured so the caller keeps the
     * existing behaviour; this method never throws so a not-yet-provisioned
     * managed cluster cannot crash the deploy resolution.
     */
    private async resolveEverWorksManagedKubeconfig(): Promise<string | null> {
        // Path A — dedicated cluster (env-gated via DEPLOY_EVER_WORKS_ENABLED +
        // a configured kubeconfig).
        if (this.everWorksDeployProvider?.isEnabled()) {
            try {
                return await this.everWorksDeployProvider.resolveKubeconfig();
            } catch (error) {
                this.logger.warn(
                    `Ever Works dedicated deploy kubeconfig is enabled but could not be resolved: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        // Path B — shared customer cluster.
        const shared = process.env.EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG?.trim();
        if (shared) {
            return shared;
        }

        return null;
    }

    private async resolveDeploymentLookupContext(
        plugin: IDeploymentPlugin,
        resolvedToken: string,
        work: Work,
        options: DeployFacadeOptions,
    ): Promise<EffectiveDeploymentOperationContext> {
        const { settings, settingSources } = await this.getDeploymentSettingsSnapshot(
            plugin.id,
            options,
            false,
        );
        const owner = work.user as User | undefined;
        const effective = resolveEffectiveDeploymentContext({
            deployProvider: work.deployProvider,
            pluginId: plugin.id,
            resolvedToken,
            settings,
            settingSources,
            websiteOwner: work.getRepoOwner('website'),
            websiteProjectName: work.getWebsiteRepo(),
            workId: work.id,
            workSlug: work.slug,
            managedSubdomain: work.managedSubdomain,
            ownerUserId: owner?.id,
            isPlatformAdmin: Boolean(owner?.isPlatformAdmin),
        });
        return {
            token: effective.token,
            teamScope: effective.settings.defaultTeamScope as string | undefined,
            context: effective.lookupContext,
        };
    }

    private async getDeploymentSettingsSnapshot(
        pluginId: string,
        options: DeployFacadeOptions,
        includeSecrets: boolean,
    ): Promise<{
        settings: Record<string, unknown>;
        settingSources: Record<string, SettingSource | undefined>;
    }> {
        const resolutionOptions = {
            userId: options.userId,
            workId: options.workId,
            includeSecrets,
        };
        const [settings, resolved] = await Promise.all([
            this.settingsService.getSettings(pluginId, resolutionOptions),
            this.settingsService.getResolvedSettings(pluginId, resolutionOptions),
        ]);
        const settingSources: Record<string, SettingSource | undefined> = {};
        for (const [key, value] of Object.entries(resolved)) {
            settingSources[key] = value.source;
        }
        return { settings, settingSources };
    }

    /**
     * Resolve the deployment projectId for a work.
     * Uses the cached deployProjectId when available to avoid redundant API calls.
     */
    private async resolveProjectId(
        plugin: IDeploymentPlugin,
        token: string,
        work: Work,
        options: DeployFacadeOptions,
        effectiveContext?: EffectiveDeploymentOperationContext,
    ): Promise<string> {
        // Use cached value if available
        if (work.deployProjectId) {
            return work.deployProjectId;
        }

        if (plugin.lookupExistingDeployment) {
            const lookupContext =
                effectiveContext ??
                (await this.resolveDeploymentLookupContext(plugin, token, work, options));
            const result = await plugin.lookupExistingDeployment(
                work.getWebsiteRepo(),
                lookupContext.token,
                lookupContext.teamScope,
                lookupContext.context,
            );
            if (result.found && result.projectId) {
                // Cache the projectId for future calls
                await this.workRepository.update(work.id, {
                    deployProjectId: result.projectId,
                });
                return result.projectId;
            }
        }
        throw new DeployFacadeError(
            'Could not resolve project ID. Ensure a deployment exists.',
            'resolveProjectId',
            plugin.id,
        );
    }

    /**
     * Get deployment token from plugin settings
     * For user-required configuration mode, only user settings are checked.
     */
    private async getTokenFromSettings(
        pluginId: string,
        userId: string,
        workId?: string,
    ): Promise<string | null> {
        try {
            const settings = await this.settingsService.getResolvedSettings(pluginId, {
                userId,
                workId,
                includeSecrets: true,
            });

            // EW-616: for the k8s plugin, when the user picked a
            // platform-managed cluster (`k8s-works` / `k8s-works-shared`, or
            // the legacy `k8s-gauzy` alias) the pasted kubeconfig is
            // intentionally empty — `DeployService.resolveDeployToken()`
            // substitutes the platform's kubeconfig from
            // `EVER_WORKS_K8S_*_KUBECONFIG` env vars at deploy time. Return a
            // non-empty sentinel here so the facade considers the work
            // "configured" and lets the deploy proceed; the sentinel is
            // discarded downstream.
            if (pluginId === 'k8s') {
                const clusterSource = settings.clusterSource?.value as string | undefined;
                if (
                    clusterSource === 'k8s-works' ||
                    clusterSource === 'k8s-works-shared' ||
                    clusterSource === 'k8s-gauzy'
                ) {
                    return (
                        (settings.kubeconfig?.value as string) ||
                        PLATFORM_MANAGED_KUBECONFIG_SENTINEL
                    );
                }
            }

            // Look for provider primary credential fields.
            // Vercel uses apiToken; Kubernetes uses kubeconfig; other
            // providers commonly use token/accessToken.
            const token =
                (settings.apiToken?.value as string) ||
                (settings.kubeconfig?.value as string) ||
                (settings.token?.value as string) ||
                (settings.accessToken?.value as string);

            return token || null;
        } catch {
            return null;
        }
    }
}

export { PLATFORM_MANAGED_KUBECONFIG_SENTINEL } from './deployment-context.resolver';
