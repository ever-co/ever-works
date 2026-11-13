/**
 * From a Work and its deployments to what the apps mirror sends: pure
 * functions, so what leaves the installation is in one reviewable place.
 *
 * The mirror carries identifiers and status only:
 *
 * - of a Work: its id, kind, name, slug and lifecycle status, with the tenant
 *   id and the Organization's id as Ever Platform holds them for the link;
 * - of a deployment: where it runs (target, provider, shape, who manages it),
 *   the environment, its state and its public address.
 *
 * Never anything else: no Work content or items, no repository (not even its
 * address), no prompt, memory, agent, budget, approval, credit, environment
 * value, secret, build log, error text, commit, branch, pull request, member or
 * e-mail address. Each function below builds its object field by field from
 * the few columns it is given; there is no spread of an entity anywhere.
 */

/** The integration the mirror runs under (an Ever Platform key, not copy). */
export const APP_SYNC_KEY = 'app_sync';

/** The outbox event of a Work whose mirror row is owed. */
export const APP_SYNC_OUTBOX_EVENT = 'app_sync';

/**
 * The first scope version of `app_sync` that lists what the mirror's contract
 * requires of an app (its name and slug) and of a deployment (its environment
 * and state). A link whose consent is older moves nothing.
 */
export const APP_SYNC_MIN_SCOPE_VERSION = 2;

/** The most operations Ever Platform reads in one batch. */
export const APP_SYNC_MAX_OPS = 500;

/** One operation of a mirror batch, as the contract spells it. */
export interface AppSyncOp {
    op: 'upsert' | 'delete';
    kind: 'app' | 'deployment';
    external_id: string;
    external_version: number;
    occurred_at: string;
    app_external_id?: string;
    data?: AppSyncAppData | AppSyncDeploymentData;
}

export interface AppSyncAppData {
    product_tenant_id: string;
    product_org_id: string;
    kind: 'app' | 'work';
    work_kind?: string;
    name: string;
    slug: string;
    base_kind: 'none';
    status: string;
}

export interface AppSyncDeploymentData {
    target: string;
    provider?: string;
    shape?: string;
    managed_by: 'ever' | 'customer' | 'third_party';
    environment: 'production' | 'preview';
    url?: string;
    status: string;
}

/** What the mirror reads of a Work. */
export interface WorkFacts {
    readonly id: string;
    readonly name: string | null;
    readonly slug: string | null;
    readonly kind: string | null;
    readonly status: string | null;
    readonly updatedAt?: Date | string | null;
}

/** What the mirror reads of a deployment row. */
export interface DeploymentFacts {
    readonly workId: string;
    readonly environment: string | null;
    readonly provider: string | null;
    readonly appTarget?: string | null;
    readonly state: string | null;
    readonly website?: string | null;
    readonly updatedAt?: Date | string | null;
}

/** The link an operation acts for, as Ever Platform holds it. */
export interface LinkFacts {
    readonly tenantId: string;
    /** The Organization's id as Ever Platform was given it when the link was made. */
    readonly productOrgRef: string;
}

/** An id Ever Platform accepts: letters, digits and `._:-`, 1 to 64 characters. */
const EXTERNAL_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** A word of the open vocabulary: lower-case letters, digits and `_.-`, at most 40. */
const VOCAB = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
/** A reference Ever Platform accepts for a tenant or an organization. */
const REFERENCE = /^[A-Za-z0-9._:/-]{1,64}$/;

/** A Work's lifecycle status, as Ever Platform reads Works' own words. */
const APP_STATUSES: ReadonlySet<string> = new Set(['draft', 'active', 'registered', 'archived']);

/**
 * A Work's kind in Ever Platform's vocabulary. A kind it has no word for is
 * sent without one rather than under another kind's name.
 */
const WORK_KINDS: Readonly<Record<string, string>> = {
    website: 'website',
    'landing-page': 'website',
    blog: 'blog',
    directory: 'directory',
    'awesome-repo': 'awesome',
    company: 'company',
    campaign: 'campaign',
    default: 'default',
};

/** A deployment's external id: one per Work and environment (the current deployment). */
export function deploymentExternalId(workId: string, environment: 'production' | 'preview') {
    return `${workId}:${environment}`;
}

export function isExternalId(value: unknown): value is string {
    return typeof value === 'string' && EXTERNAL_ID.test(value);
}

/** Plain display text: no control character, trimmed, at most `max` characters; `null` when empty. */
function displayText(value: string | null | undefined, max: number): string | null {
    if (typeof value !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
    if (!cleaned) return null;
    return Array.from(cleaned).slice(0, max).join('').trim() || null;
}

function isoOf(value: Date | string | null | undefined, now: Date): string {
    const date = value ? new Date(value) : now;
    const time = date.getTime();
    // Never later than now: Ever Platform reads it as when the change happened.
    return new Date(
        Number.isFinite(time) ? Math.min(time, now.getTime()) : now.getTime(),
    ).toISOString();
}

/**
 * The upsert of a Work, or `null` when it cannot be told in the contract's
 * words (an id, a status or a link reference outside them): such a Work is not
 * mirrored rather than sent wrong.
 */
export function appUpsert(
    work: WorkFacts,
    link: LinkFacts,
    version: number,
    now: Date,
): AppSyncOp | null {
    if (!isExternalId(work.id)) return null;
    if (!REFERENCE.test(link.tenantId) || !REFERENCE.test(link.productOrgRef)) return null;
    const status = typeof work.status === 'string' ? work.status : '';
    if (!APP_STATUSES.has(status)) return null;
    const slug = displayText(work.slug, 128);
    const name = displayText(work.name, 200) ?? slug;
    if (!name || !slug) return null;
    const kind = work.kind === 'app' ? 'app' : 'work';
    const workKind = kind === 'work' ? WORK_KINDS[work.kind ?? 'default'] : undefined;
    const data: AppSyncAppData = {
        product_tenant_id: link.tenantId,
        product_org_id: link.productOrgRef,
        kind,
        name,
        slug,
        base_kind: 'none',
        status,
    };
    if (workKind) data.work_kind = workKind;
    return {
        op: 'upsert',
        kind: 'app',
        external_id: work.id,
        external_version: version,
        occurred_at: isoOf(work.updatedAt, now),
        data,
    };
}

/** The delete of a Work that no longer exists here. */
export function appDelete(workId: string, version: number, now: Date): AppSyncOp | null {
    if (!isExternalId(workId)) return null;
    return {
        op: 'delete',
        kind: 'app',
        external_id: workId,
        external_version: version,
        occurred_at: now.toISOString(),
    };
}

/** Where a deployment runs, in Ever Platform's open vocabulary. */
export interface DeployTarget {
    target: string;
    provider?: string;
    shape?: string;
    managed_by: 'ever' | 'customer' | 'third_party';
}

/** A provider id as a word of the open vocabulary, or `null` when it cannot be one. */
function vocabWord(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const word = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, '-')
        .replace(/^[^a-z0-9]+/, '')
        .slice(0, 40)
        .replace(/[^a-z0-9]+$/, '');
    return VOCAB.test(word) ? word : null;
}

/**
 * The deploy target of a deployment row:
 *
 * | Works                                          | target            | provider     | shape               | managed by    |
 * | ---------------------------------------------- | ----------------- | ------------ | ------------------- | ------------- |
 * | an App on the owner's cluster (`your-cluster`) | `your-cluster`    | `k8s`        | `custom-kubeconfig` | `customer`    |
 * | an App on the shared apps cluster              | `ever-works-apps` | `k8s`        | `k8s-works-shared`  | `ever`        |
 * | a site on Ever Works hosting                   | `ever-works`      | `ever-works` | `k8s-works-shared`  | `ever`        |
 * | a site on Kubernetes, the owner's kubeconfig   | `k8s`             | `k8s`        | `custom-kubeconfig` | `customer`    |
 * | a site on Kubernetes, an Ever Works cluster    | `k8s`             | `k8s`        | the cluster source  | `ever`        |
 * | any other deploy provider plugin (its id)      | the id            | the id       | `provider-plugin`   | `third_party` |
 *
 * `clusterSource` is the Kubernetes plugin's setting for the Work, when the
 * caller could read it; without it a site on Kubernetes is told as the plugin's
 * own default (the owner's kubeconfig).
 */
export function deployTarget(
    deployment: Pick<DeploymentFacts, 'provider' | 'appTarget'>,
    clusterSource?: string | null,
): DeployTarget | null {
    if (deployment.appTarget === 'your-cluster') {
        return {
            target: 'your-cluster',
            provider: 'k8s',
            shape: 'custom-kubeconfig',
            managed_by: 'customer',
        };
    }
    if (deployment.appTarget === 'ever-works-apps') {
        return {
            target: 'ever-works-apps',
            provider: 'k8s',
            shape: 'k8s-works-shared',
            managed_by: 'ever',
        };
    }
    const provider = vocabWord(deployment.provider);
    if (!provider) return null;
    if (provider === 'ever-works') {
        return {
            target: 'ever-works',
            provider: 'ever-works',
            shape: 'k8s-works-shared',
            managed_by: 'ever',
        };
    }
    if (provider === 'k8s') {
        const source = vocabWord(clusterSource);
        const managed = source === 'k8s-works' || source === 'k8s-works-shared';
        return {
            target: 'k8s',
            provider: 'k8s',
            shape: managed ? source : 'custom-kubeconfig',
            managed_by: managed ? 'ever' : 'customer',
        };
    }
    return { target: provider, provider, shape: 'provider-plugin', managed_by: 'third_party' };
}

/**
 * A deployment's public address as Ever Platform stores one: `http` or
 * `https`, with a host, without credentials, a query or a fragment (those
 * parts are dropped, never sent). `null` when there is none to send.
 */
export function publicAddress(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw || raw.length > 2048) return null;
    let url: URL;
    try {
        url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.username || url.password) return null;
    url.search = '';
    url.hash = '';
    const clean = url.toString();
    return clean.length <= 2048 ? clean : null;
}

/** A deployment row's state, in the words Ever Platform reads (Works' own, or `pending`). */
export function deploymentStatus(state: string | null | undefined): string {
    return typeof state === 'string' && /^[A-Z_]{1,32}$/.test(state) ? state : 'pending';
}

/**
 * The upsert of a Work's current deployment in one environment, or `null` when
 * where it runs cannot be told in the contract's words.
 */
export function deploymentUpsert(
    deployment: DeploymentFacts,
    version: number,
    now: Date,
    clusterSource?: string | null,
): AppSyncOp | null {
    if (!isExternalId(deployment.workId)) return null;
    const environment = deployment.environment === 'preview' ? 'preview' : 'production';
    const where = deployTarget(deployment, clusterSource);
    if (!where) return null;
    const data: AppSyncDeploymentData = {
        target: where.target,
        managed_by: where.managed_by,
        environment,
        status: deploymentStatus(deployment.state),
    };
    if (where.provider) data.provider = where.provider;
    if (where.shape) data.shape = where.shape;
    const url = publicAddress(deployment.website);
    if (url) data.url = url;
    const externalId = deploymentExternalId(deployment.workId, environment);
    if (!isExternalId(externalId)) return null;
    return {
        op: 'upsert',
        kind: 'deployment',
        external_id: externalId,
        external_version: version,
        occurred_at: isoOf(deployment.updatedAt, now),
        app_external_id: deployment.workId,
        data,
    };
}
