/**
 * About page — the pure rules behind what `/about` shows: which environment
 * this deployment is, which API address to show a reader, whether the web and
 * API builds agree, and the project's public links.
 *
 * Everything here is a plain function of its inputs (no `process.env` reads),
 * so the page decides WHAT to pass and the rules stay unit-testable.
 */

/** The named environments of the develop → stage → main cascade, plus a local run. */
export type DeploymentEnvironment = 'local' | 'dev' | 'stage' | 'prod';

const KNOWN_ENVIRONMENTS: readonly DeploymentEnvironment[] = ['local', 'dev', 'stage', 'prod'];

/** Canonical repository; `NEXT_PUBLIC_GITHUB_REPO_URL` overrides it for forks. */
export const DEFAULT_REPO_URL = 'https://github.com/ever-co/ever-works';

/** Map a free-form environment label (`production`, `staging`, `development`, …) to a known name. */
export function normalizeEnvironmentName(
    value: string | undefined | null,
): DeploymentEnvironment | null {
    const name = value?.trim().toLowerCase();
    if (!name) return null;
    if ((KNOWN_ENVIRONMENTS as readonly string[]).includes(name))
        return name as DeploymentEnvironment;
    if (name === 'production' || name === 'main' || name === 'master' || name === 'latest')
        return 'prod';
    if (name === 'staging') return 'stage';
    if (name === 'develop' || name === 'development') return 'dev';
    return null;
}

/**
 * The environment a build ref belongs to: `develop` → dev, `stage` → stage,
 * `main` / `master` / a release tag (`v1.2.3`) → prod. Each environment runs
 * the image built from its own branch, so the ref names the environment.
 */
export function environmentFromBuildRef(
    ref: string | undefined | null,
): DeploymentEnvironment | null {
    const value = ref?.trim();
    if (!value) return null;
    if (/^v\d+\.\d+/.test(value)) return 'prod';
    const name = normalizeEnvironmentName(value);
    return name === 'local' ? null : name;
}

function hostOf(url: string | undefined | null): string | null {
    if (!url) return null;
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
}

function isLocalHost(host: string): boolean {
    return (
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '[::1]' ||
        host.endsWith('.localhost')
    );
}

/**
 * Only the signals a hostname states outright: a local address, or a
 * `dev` / `stage` label in its first part (`app-dev.ever.works`,
 * `appstage.ever.works`). A host with no such label says nothing — a
 * production domain looks like any self-hosted one.
 */
export function environmentFromWebUrl(
    url: string | undefined | null,
): DeploymentEnvironment | null {
    const host = hostOf(url);
    if (!host) return null;
    if (isLocalHost(host)) return 'local';
    const firstLabel = host.split('.')[0] ?? '';
    if (/(^|-)(stage|staging)$|^appstage$/.test(firstLabel)) return 'stage';
    if (/(^|-)(dev|develop)$|^appdev$/.test(firstLabel)) return 'dev';
    return null;
}

export interface EnvironmentInputs {
    /** An explicit override (`NEXT_PUBLIC_APP_ENV`). */
    override?: string;
    /** The address this web app is served at (`WEB_URL`). */
    webUrl?: string;
    /** The branch or tag the web bundle was built from (`NEXT_PUBLIC_BUILD_REF`). */
    buildRef?: string;
}

/**
 * Which environment this deployment is. An explicit override wins, then what
 * the web address says, then the build ref. `null` when nothing says.
 */
export function resolveDeploymentEnvironment({
    override,
    webUrl,
    buildRef,
}: EnvironmentInputs): DeploymentEnvironment | null {
    return (
        normalizeEnvironmentName(override) ??
        environmentFromWebUrl(webUrl) ??
        environmentFromBuildRef(buildRef)
    );
}

function trimApiUrl(url: string): string {
    return url.trim().replace(/\/+$/, '');
}

/**
 * A host only the server can reach: a bare Kubernetes service name
 * (`ever-works-api`) or a cluster-internal domain. Showing it to a reader
 * would be useless, and it describes the cluster's layout.
 */
function isClusterInternalHost(host: string): boolean {
    return (
        (!host.includes('.') && !isLocalHost(host)) ||
        host.endsWith('.svc') ||
        host.endsWith('.cluster.local') ||
        host.includes('.svc.')
    );
}

export interface ApiAddressInputs {
    /** The browser-facing API URL (`NEXT_PUBLIC_API_URL`). */
    publicApiUrl?: string;
    /** The URL the web server calls (`API_URL`); can be cluster-internal. */
    serverApiUrl?: string;
    /** The address this web app is served at (`WEB_URL`). */
    webUrl?: string;
}

/**
 * The API address to show a reader. The browser-facing URL when one is set;
 * otherwise the server's own URL unless it is cluster-internal; otherwise the
 * `api` sibling of the web host (`app-dev.ever.works` → `api-dev.ever.works`),
 * which is how every Ever Works environment is laid out. `null` when none of
 * these yields a public address.
 */
export function resolveDisplayApiAddress({
    publicApiUrl,
    serverApiUrl,
    webUrl,
}: ApiAddressInputs): string | null {
    if (publicApiUrl?.trim()) return trimApiUrl(publicApiUrl);

    const serverHost = hostOf(serverApiUrl);
    if (serverApiUrl && serverHost && !isClusterInternalHost(serverHost)) {
        return trimApiUrl(serverApiUrl);
    }

    const webHost = hostOf(webUrl);
    if (webUrl && webHost && /^app/.test(webHost) && !isLocalHost(webHost)) {
        const url = new URL(webUrl);
        url.hostname = webHost.replace(/^app/, 'api');
        return `${url.origin}/api`;
    }
    return null;
}

/** The build coordinates both sides report. */
export interface BuildCoordinates {
    gitSha: string;
}

function isRealSha(sha: string | undefined | null): sha is string {
    return typeof sha === 'string' && /^[0-9a-f]{7,40}$/i.test(sha);
}

/**
 * Whether the web bundle and the API were built from the same commit:
 * `in-sync` when they were, `different` when they were not, `unknown` when
 * either side has no real commit (a local build, or the API did not answer).
 */
export type BuildSyncState = 'in-sync' | 'different' | 'unknown';

export function compareBuilds(
    web: BuildCoordinates | null | undefined,
    api: BuildCoordinates | null | undefined,
): BuildSyncState {
    if (!web || !api || !isRealSha(web.gitSha) || !isRealSha(api.gitSha)) return 'unknown';
    const a = web.gitSha.toLowerCase();
    const b = api.gitSha.toLowerCase();
    // A short SHA on one side still matches the full SHA on the other.
    return a.startsWith(b) || b.startsWith(a) ? 'in-sync' : 'different';
}

export interface GitHubLinks {
    repository: string;
    releases: string;
    issues: string;
    pullRequests: string;
    contributors: string;
    contributingGuide: string;
    license: string;
}

/** The project's GitHub pages, built from the repository URL. */
export function buildGitHubLinks(repoUrl: string | undefined | null): GitHubLinks {
    const repository = (repoUrl?.trim() || DEFAULT_REPO_URL).replace(/\/+$/, '');
    return {
        repository,
        releases: `${repository}/releases`,
        issues: `${repository}/issues`,
        pullRequests: `${repository}/pulls`,
        contributors: `${repository}/graphs/contributors`,
        contributingGuide: `${repository}/blob/develop/.github/CONTRIBUTING.MD`,
        license: `${repository}/blob/develop/LICENSE`,
    };
}

/**
 * Domains owned by Ever, each matching itself and every name under it. Mirrors
 * the `ever_owned` list of the egress audit (`@ever-co/connect-tools`,
 * `egress-audit/ever-hosts.json`).
 */
export const EVER_OWNED_DOMAINS: readonly string[] = [
    'ever.co',
    'ever.team',
    'gauzy.co',
    'ever.works',
    'rec.so',
    'traduora.co',
    'everdemand.co',
    'ever.sh',
    'githands.com',
];

/** Whether a URL points at a domain Ever owns. */
export function isEverOwnedUrl(url: string | undefined | null): boolean {
    const host = hostOf(url);
    if (!host) return false;
    return EVER_OWNED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Whether this web app is Ever's own hosted Ever Works (`app.ever.works`, `app-dev.ever.works`, …). */
export function isEverHostedDeployment(webUrl: string | undefined | null): boolean {
    const host = hostOf(webUrl);
    return host === 'ever.works' || (host?.endsWith('.ever.works') ?? false);
}

export const EVER_WORKS_WEBSITE_URL = 'https://ever.works';
export const EVER_WORKS_DOCS_URL = 'https://docs.ever.works';
export const EVER_CO_URL = 'https://ever.co';

export interface LearnMoreLink {
    id: 'website' | 'docs' | 'company';
    href: string;
    /** Shown instead of the translated label (an operator's own company name). */
    label?: string;
}

export interface LearnMoreInputs {
    /** The address this web app is served at (`WEB_URL`). */
    webUrl?: string;
    /** The operator's own site (`NEXT_PUBLIC_COMPANY_OWNER_WEBSITE`). */
    companyOwnerWebsite?: string;
    /** The operator's own name (`NEXT_PUBLIC_COMPANY_OWNER`). */
    companyOwnerName?: string;
}

/**
 * The "Learn more" links. Ever's own hosted app links to ever.works,
 * docs.ever.works and Ever Co. A self-hosted installation renders NO link to
 * an Ever host — the egress audit's browser leg fails on any new one
 * (`tools/egress-audit/README.md`, "The DOM baseline") — so it shows only
 * its operator's own site, when one is set; it may then have no links at all.
 */
export function buildLearnMoreLinks({
    webUrl,
    companyOwnerWebsite,
    companyOwnerName,
}: LearnMoreInputs): LearnMoreLink[] {
    if (isEverHostedDeployment(webUrl)) {
        return [
            { id: 'website', href: EVER_WORKS_WEBSITE_URL },
            { id: 'docs', href: EVER_WORKS_DOCS_URL },
            { id: 'company', href: EVER_CO_URL },
        ];
    }
    const ownerSite = companyOwnerWebsite?.trim();
    if (
        !ownerSite ||
        !/^https?:\/\//i.test(ownerSite) ||
        !hostOf(ownerSite) ||
        isEverOwnedUrl(ownerSite)
    ) {
        return [];
    }
    const label = companyOwnerName?.trim();
    return [{ id: 'company', href: ownerSite, ...(label ? { label } : {}) }];
}
