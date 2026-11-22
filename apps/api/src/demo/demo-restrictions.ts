import { isAppWorkKind } from '@ever-works/contracts';

/**
 * Platform demo mode (`DEMO=true`) — what a demo instance refuses (design §5.2.4 "Blocked in
 * demo" and "Registration"), enforced by `DemoRestrictionsGuard` with `DEMO_DISABLED` (403).
 *
 * - `everyone`: nobody registers or signs in a new identity on a demo host — not a visitor, not
 *   a signed-in operator (operators already exist and log in with their password). The only way
 *   in is `POST /api/auth/demo`, which no row names.
 * - `demo-users`: refused to a demo sandbox (`registrationProvider = 'demo'`) only — features
 *   that spend money, reach the outside world, or change the account. Operators keep them.
 *
 * `path` is matched against the request path Express routes (no query string, trailing slash
 * removed), so it is anchored and case-insensitive (`i`), as Express routing is. `GET` rows also
 * apply to `HEAD`, which Express answers with the GET handler. `when`, if set, narrows a row to
 * the requests it holds for: some features live in the body or headers of a shared route. The
 * DTO fields a `when` reads are pinned by the guard spec, so a renamed field fails a test.
 * `demo-restrictions.routes.spec.ts` checks every row against the routes the API registers.
 */
export interface DemoBlockedRoute {
    readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | '*';
    readonly path: RegExp;
    readonly feature: string;
    readonly scope: 'demo-users' | 'everyone';
    readonly when?: (request: DemoRouteRequest) => boolean;
}

/**
 * What a `when` reads: the parsed body and the headers (guards run after body parsing), and the
 * caller `AuthSessionGuard` put on the request (absent before it has run, or on a public route).
 */
export interface DemoRouteRequest {
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, unknown>>;
    readonly user?: { readonly userId?: unknown; readonly username?: unknown } | null;
}

function bodyOf(request: DemoRouteRequest): Record<string, unknown> {
    const body = request.body;
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

/** A body field that is there and not empty (`undefined`, `null`, `''`, `{}`, `[]` are empty). */
function isGiven(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
}

/**
 * An enable that also writes settings: `EnableUserPluginDto` / `EnableWorkPluginDto` carry
 * `settings` and `secretSettings`, which reach the same settings write as the settings routes
 * (BYOK keys among them). A plain enable, with neither, stays open.
 */
function writesPluginSettings(request: DemoRouteRequest): boolean {
    const { settings, secretSettings } = bodyOf(request);
    return isGiven(settings) || isGiven(secretSettings);
}

/**
 * A shared-view settings change (`UpdateSharedViewDto`) that publishes something: turning
 * sharing on (any `status` but `paused`), publishing a section or knowledge classes, or letting
 * crawlers index the page. Only a change that spells everything it sends out as "off" stays
 * open: `status: 'paused'`, `sections` whose every value is `false`, `knowledgeClasses: []`
 * and `searchIndexable: false`. That is not every narrowing: a shorter but non-empty
 * `knowledgeClasses` list still publishes those classes and is refused, as is a `sections`
 * entry left `true`. Any other value counts as publishing (fail closed).
 */
function publishesSharedView(request: DemoRouteRequest): boolean {
    const { status, sections, knowledgeClasses, searchIndexable } = bodyOf(request);
    if (status !== undefined && status !== 'paused') return true;
    if (sections !== undefined) {
        if (!sections || typeof sections !== 'object') return true;
        if (Object.values(sections).some((published) => published !== false)) return true;
    }
    if (knowledgeClasses !== undefined) {
        if (!Array.isArray(knowledgeClasses) || knowledgeClasses.length > 0) return true;
    }
    return searchIndexable !== undefined && searchIndexable !== false;
}

/**
 * A profile save that changes the username (`UpdateProfileDto.username`): a demo sandbox's
 * `demo-` repository prefix derives from it. Compared with the caller's current username; with
 * no caller on the request yet, any username counts as a change.
 */
function changesUsername(request: DemoRouteRequest): boolean {
    const username = bodyOf(request).username;
    if (typeof username !== 'string') return false;
    const current = request.user?.username;
    return typeof current !== 'string' || username !== current;
}

/**
 * A create that asks for an App Work: `kind: 'app'`, normalised as the create path does. Quick
 * create accepts the kind too (it cannot carry the repository an App Work needs, today).
 */
function createsAppWork(request: DemoRouteRequest): boolean {
    const kind = bodyOf(request).kind;
    return typeof kind === 'string' && isAppWorkKind(kind);
}

/**
 * A Work update that names where its repositories live: an `owner`, or an organization. The web
 * sends `organization: false` and no owner when the owner is not being chosen.
 */
function namesRepositoryOwner(request: DemoRouteRequest): boolean {
    const { owner, organization } = bodyOf(request);
    return (typeof owner === 'string' && owner.trim() !== '') || organization === true;
}

/** Same test as `UploadsController.hasSuppliedCredential`: without one, presign mints a user. */
function mintsAnonymousUser(request: DemoRouteRequest): boolean {
    const headers = request.headers ?? {};
    return ![headers.authorization, headers['x-api-key']].some((value) =>
        Array.isArray(value)
            ? value.some((entry) => typeof entry === 'string' && entry.trim().length > 0)
            : typeof value === 'string' && value.trim().length > 0,
    );
}

// prettier-ignore
export const DEMO_BLOCKED_ROUTES: ReadonlyArray<DemoBlockedRoute> = [
    // Registration and new identities — everyone.
    { method: 'POST', path: /^\/api\/auth\/register$/i, feature: 'registration', scope: 'everyone' },
    { method: 'POST', path: /^\/api\/register-work$/i, feature: 'registration', scope: 'everyone' },
    { method: 'POST', path: /^\/api\/auth\/anonymous$/i, feature: 'anonymous sign-in', scope: 'everyone' },
    { method: 'POST', path: /^\/api\/auth\/magic-link$/i, feature: 'magic link sign-in', scope: 'everyone' },
    { method: 'POST', path: /^\/api\/auth\/magic-link\/redeem$/i, feature: 'magic link sign-in', scope: 'everyone' },
    { method: 'GET', path: /^\/api\/oauth\/[^/]+\/url$/i, feature: 'social sign-in', scope: 'everyone' },
    { method: 'GET', path: /^\/api\/oauth\/[^/]+\/callback$/i, feature: 'social sign-in', scope: 'everyone' },
    // Saving an anonymous account with GitHub / Google signs in a new identity too; a demo
    // sandbox is anonymous, so this also keeps it from leaving the sweeper's reach.
    { method: 'POST', path: /^\/api\/oauth\/[^/]+\/claim$/i, feature: 'social sign-in', scope: 'everyone' },
    { method: 'GET', path: /^\/api\/github-app\/(setup|callback)$/i, feature: 'GitHub App sign-in', scope: 'everyone' },
    { method: 'POST', path: /^\/api\/auth\/ever-id\/(authorize|callback|sign-up\/confirm)$/i, feature: 'Ever ID sign-in', scope: 'everyone' },
    { method: 'POST', path: /^\/api\/auth\/ever-id\/session$/i, feature: 'Ever ID sign-in', scope: 'everyone' },
    { method: 'POST', path: /^\/api\/uploads\/anonymous(\/file)?$/i, feature: 'anonymous uploads', scope: 'everyone' },
    { method: 'POST', path: /^\/api\/uploads\/presign$/i, feature: 'anonymous uploads', scope: 'everyone', when: mintsAnonymousUser },

    // Money: keys of your own, model accounts — demo users. The OpenAI-compatible
    // `POST /api/v1/chat/completions` stays open (R39): the web's assistant chat calls it, and the
    // AI facade forces OpenRouter, a `:free` model and the demo quota on every call to it. Without
    // an API key of its own (minting one is refused below) a sandbox reaches it only with its own
    // session, inside that quota.
    { method: 'PATCH', path: /^\/api\/plugins\/[^/]+\/settings$/i, feature: 'plugin settings', scope: 'demo-users' },
    { method: 'PATCH', path: /^\/api\/works\/[^/]+\/plugins\/[^/]+\/settings$/i, feature: 'plugin settings', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/plugins\/[^/]+\/enable$/i, feature: 'plugin settings', scope: 'demo-users', when: writesPluginSettings },
    { method: 'POST', path: /^\/api\/works\/[^/]+\/plugins\/[^/]+\/enable$/i, feature: 'plugin settings', scope: 'demo-users', when: writesPluginSettings },
    { method: 'PUT', path: /^\/api\/fleet\/runners\/jobs\/watched$/i, feature: 'plugin settings', scope: 'demo-users' },
    { method: 'PUT', path: /^\/api\/deploy\/works\/[^/]+\/runtime-env$/i, feature: 'runtime environment', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/auth\/api-keys(\/integration)?$/i, feature: 'API keys', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/auth\/api-keys\/[^/]+\/rotate$/i, feature: 'API keys', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/model-accounts$/i, feature: 'model accounts', scope: 'demo-users' },
    { method: 'PATCH', path: /^\/api\/model-accounts\/[^/]+$/i, feature: 'model accounts', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/model-accounts\/[^/]+\/credentials$/i, feature: 'model account credentials', scope: 'demo-users' },

    // The outside world: webhooks, channels, MCP, connected accounts, deploys — demo users.
    { method: 'POST', path: /^\/api\/webhooks$/i, feature: 'webhooks', scope: 'demo-users' },
    { method: 'PATCH', path: /^\/api\/webhooks\/[^/]+$/i, feature: 'webhooks', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/notification-channels$/i, feature: 'notification channels', scope: 'demo-users' },
    { method: 'PATCH', path: /^\/api\/notification-channels\/[^/]+$/i, feature: 'notification channels', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/mcp-connections$/i, feature: 'MCP connections', scope: 'demo-users' },
    { method: 'PATCH', path: /^\/api\/mcp-connections\/[^/]+$/i, feature: 'MCP connections', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/plugins\/composio\/(connect|triggers)$/i, feature: 'Composio', scope: 'demo-users' },
    { method: 'GET', path: /^\/api\/oauth\/[^/]+\/(read-packages\/)?connect\/url$/i, feature: 'connected accounts', scope: 'demo-users' },
    { method: 'GET', path: /^\/api\/oauth\/[^/]+\/callback\/plugins(\/read-packages)?$/i, feature: 'connected accounts', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/auth\/ever-id\/connect\/(authorize|confirm)$/i, feature: 'connected accounts', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/device-auth\/[^/]+\/start$/i, feature: 'device sign-in', scope: 'demo-users' },
    { method: 'GET', path: /^\/api\/device-auth\/[^/]+\/status$/i, feature: 'device sign-in', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/deploy\/works\/[^/]+(\/rollback)?$/i, feature: 'deploy', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/deploy\/batch$/i, feature: 'deploy', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/works\/[^/]+\/deploy$/i, feature: 'deploy', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/deploy\/works\/[^/]+\/domains$/i, feature: 'custom domains', scope: 'demo-users' },
    { method: 'PUT', path: /^\/api\/deploy\/works\/[^/]+\/subdomain$/i, feature: 'subdomains', scope: 'demo-users' },
    { method: 'PUT', path: /^\/api\/works\/[^/]+\/repositories\/visibility$/i, feature: 'repository visibility', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/deploy\/works\/[^/]+\/db\/test$/i, feature: 'custom databases', scope: 'demo-users' },
    // Screenshots are off on a demo (R41): each of these has a screenshot provider fetch a URL the
    // caller names. The image proxy (`GET /api/screenshot/image/:file`) and the availability
    // check stay open; generation's image step skips on its own (`image-capture.step.ts`).
    { method: 'POST', path: /^\/api\/screenshot\/(capture|get-url)$/i, feature: 'screenshots', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/works\/[^/]+\/bulk-capture-images$/i, feature: 'screenshots', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/works(\/quick-create)?$/i, feature: 'App Works', scope: 'demo-users', when: createsAppWork },
    { method: 'PUT', path: /^\/api\/works\/[^/]+$/i, feature: 'Work repository owner', scope: 'demo-users', when: namesRepositoryOwner },
    { method: 'PATCH', path: /^\/api\/works\/[^/]+$/i, feature: 'Work repository owner', scope: 'demo-users', when: namesRepositoryOwner },
    { method: 'POST', path: /^\/api\/organizations\/[^/]+\/invitations$/i, feature: 'invitations by email', scope: 'demo-users' },
    // Every Work invitation: a member invitation is mailed (the API requires the email), and an
    // `owner-claim` link hands the Work to whoever redeems it, whose acceptance moves the Work's
    // repositories out of the demo org to their git login (`ClaimController`), beyond the sweeper.
    { method: 'POST', path: /^\/api\/works\/[^/]+\/invitations$/i, feature: 'Work invitations and transfer', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/works\/[^/]+\/members$/i, feature: 'invitations by email', scope: 'demo-users' },
    // Accepting one (R42 d): a sandbox never joins another account's Work. An operator's mailed
    // member invitation would make a demo user a member of the operator's Work, and the sandbox
    // purge deletes rows by the sandbox's `userId` across every table, that membership included.
    // The claim page's public preview stays open.
    { method: 'POST', path: /^\/api\/claim\/accept$/i, feature: 'accepting a Work invitation', scope: 'demo-users' },

    // Public pages: a share link publishes the workspace's board on the demo host (R38). Turning
    // sharing off, deleting the share and the owner's own preview stay open.
    { method: 'POST', path: /^\/api\/organizations\/[^/]+\/shared-view(\/regenerate)?$/i, feature: 'public share link', scope: 'demo-users' },
    { method: 'PATCH', path: /^\/api\/organizations\/[^/]+\/shared-view$/i, feature: 'public share link', scope: 'demo-users', when: publishesSharedView },

    // Repositories brought in from elsewhere — demo users. A demo Work's only repository is the
    // `demo-` one the platform provisions (create / Generate), within the sandbox's Works cap and
    // the sweeper's reach; an import, onboarding or template copy would make Works or
    // repositories outside both.
    { method: 'POST', path: /^\/api\/works\/import$/i, feature: 'importing a repository', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/github-app\/installations\/[^/]+\/repositories\/[^/]+\/onboard$/i, feature: 'importing a repository', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/templates\/(fork|custom-from-base)$/i, feature: 'copying a template repository', scope: 'demo-users' },

    // The account itself (the sweeper deletes a sandbox) and its data — demo users.
    { method: 'POST', path: /^\/api\/auth\/claim$/i, feature: 'account claim', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/auth\/update-password$/i, feature: 'password change', scope: 'demo-users' },
    { method: 'PUT', path: /^\/api\/auth\/profile$/i, feature: 'username change', scope: 'demo-users', when: changesUsername },
    { method: 'POST', path: /^\/api\/account-deletion\/me$/i, feature: 'account deletion', scope: 'demo-users' },
    { method: 'GET', path: /^\/api\/account\/export$/i, feature: 'data export', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/account\/backups$/i, feature: 'data export', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/account\/sync\/(configure|push)$/i, feature: 'data export', scope: 'demo-users' },
    // A backup import, or a company package import, makes Works outside the create path: outside
    // the sandbox's Works cap, its forced storage and the shape the seeder gives it.
    { method: 'POST', path: /^\/api\/account\/import\/(preview|apply)$/i, feature: 'account import', scope: 'demo-users' },
    { method: 'POST', path: /^\/api\/organizations\/import-company$/i, feature: 'company import', scope: 'demo-users' },
];
