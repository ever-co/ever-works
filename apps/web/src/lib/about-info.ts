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

/** A loopback name or address: `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`. */
function isLocalHost(host: string): boolean {
    return (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        /^127(\.\d{1,3}){3}$/.test(host) ||
        host === '[::1]' ||
        host === '::1'
    );
}

/** A parsed `http:` / `https:` URL, or `null` for anything else. */
function parseHttpUrl(value: string | undefined | null): URL | null {
    const text = value?.trim();
    if (!text) return null;
    try {
        const url = new URL(text);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
    } catch {
        return null;
    }
}

/** `origin + path` without credentials, query, fragment or trailing slash. */
function displayUrl(url: URL): string {
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
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

export interface ApiAddressInputs {
    /** The browser-facing API URL (`NEXT_PUBLIC_API_URL`). */
    publicApiUrl?: string;
    /** The URL the web server calls (`API_URL`); can be cluster-internal. */
    serverApiUrl?: string;
    /** The address this web app is served at (`WEB_URL`). */
    webUrl?: string;
}

/**
 * The first label of an Ever-hosted web app (`app`, `app-dev`, `appstage`, …)
 * and its API sibling (`api`, `api-dev`, `apistage`, …).
 */
const EVER_APP_LABEL = /^app(-[a-z0-9]+|dev|stage)?$/;

/**
 * The API address to show a reader, or `null` when there is none that is
 * safe and meaningful to show:
 *  1. the browser-facing URL (`NEXT_PUBLIC_API_URL`), when set;
 *  2. on Ever's own hosted app, the `api` sibling of the web host
 *     (`app-dev.ever.works` → `https://api-dev.ever.works/api`), which is how
 *     every Ever Works environment is laid out;
 *  3. the server's own URL only when it is a loopback address (local
 *     development).
 * The server's `API_URL` is otherwise never shown: in a cluster it is an
 * internal address (`http://ever-works-api:3100`, a namespace-qualified
 * service, a private IP) that describes the cluster's layout and that no
 * reader can use. Whatever is shown carries no credentials, query or fragment.
 */
export function resolveDisplayApiAddress({
    publicApiUrl,
    serverApiUrl,
    webUrl,
}: ApiAddressInputs): string | null {
    const publicUrl = parseHttpUrl(publicApiUrl);
    if (publicUrl) return displayUrl(publicUrl);

    const web = parseHttpUrl(webUrl);
    if (web && isEverHostedDeployment(web.href)) {
        const [first, ...rest] = web.hostname.toLowerCase().split('.');
        if (first && EVER_APP_LABEL.test(first)) {
            return `https://${[first.replace(/^app/, 'api'), ...rest].join('.')}/api`;
        }
    }

    const server = parseHttpUrl(serverApiUrl);
    if (server && isLocalHost(server.hostname.toLowerCase())) return displayUrl(server);
    return null;
}

/** The build coordinates both sides report. */
export interface BuildCoordinates {
    gitSha: string;
}

/** One build as the About page shows it: the web bundle's, or the API's from `GET /api/version`. */
export interface AboutBuild {
    version: string;
    shortSha: string;
    gitRef: string;
    buildTime: string;
    /** A link to the commit; only ever an `https:` URL. */
    commitUrl: string | null;
}

function textField(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Build info made safe to render. The API's answer is parsed JSON from
 * another service, so every field is checked: non-strings become empty, and
 * `commitUrl` survives only as an `https:` URL (it becomes a link). `null`
 * for anything that is not an object.
 */
export function toAboutBuild(value: unknown): AboutBuild | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const info = value as Record<string, unknown>;
    const commit = parseHttpUrl(textField(info.commitUrl));
    return {
        version: textField(info.version),
        shortSha: textField(info.shortSha),
        gitRef: textField(info.gitRef),
        buildTime: textField(info.buildTime),
        commitUrl: commit && commit.protocol === 'https:' ? commit.href : null,
    };
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

/**
 * The project's GitHub pages, built from the repository URL. An override
 * (`NEXT_PUBLIC_GITHUB_REPO_URL`, for forks) is used only when it is an
 * http(s) URL that does not point at an Ever-owned host; anything else falls
 * back to the canonical repository.
 */
export function buildGitHubLinks(repoUrl: string | undefined | null): GitHubLinks {
    const override = parseHttpUrl(repoUrl);
    const repository =
        override && !isEverOwnedUrl(override.href) ? displayUrl(override) : DEFAULT_REPO_URL;
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
