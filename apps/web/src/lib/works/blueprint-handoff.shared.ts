import { REDIRECT_SEARCH_PARAM, ROUTES } from '@/lib/constants';

/**
 * A person who installs a Blueprint listing on Ever Platform's marketplace is
 * sent here to create the App, with an address like
 *
 *     /new?type=app&blueprint=<blueprint id>&ever_org=<Ever organization>&install=<install id>
 *
 * This module is everything that reads that address: which values it may
 * carry, in which spelling, and how they travel on (through sign-in, and from
 * `/new` to the create form on `/works/new`). No directive: the proxy, the two
 * server pages and the create form all read it.
 *
 * Every value is an identifier, checked against the one spelling it can have
 * before it is used for anything; an address that carries no Blueprint, or one
 * that is not spelled like one, is not a hand-off at all and changes nothing.
 * Nothing here is trusted: the API settles the Blueprint, and whether the
 * person may create a Work in an Organization, on its own.
 *
 * **Off by default.** The hand-off is read only with
 * `EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED=true` on the web app
 * ({@link isBlueprintHandoffEnabled}). Without it the three query keys mean
 * nothing: `/new`, `/works/new` and the sign-in gate behave exactly as they
 * did before this module existed.
 */
export interface BlueprintHandoff {
    /** The Blueprint's id in the Apps catalog. */
    readonly blueprint: string;
    /** Ever Platform's id of the install the App is created for, when the address named one. */
    readonly install: string | null;
    /** The Ever organization that installed it (its id or its handle), when the address named one. */
    readonly everOrg: string | null;
}

/**
 * What the App create form is given of a hand-off, once the server looked the
 * Blueprint up in this installation's Apps catalog.
 */
export interface AppBlueprintHandoff {
    /** The Blueprint's id in the Apps catalog. */
    readonly blueprintId: string;
    /**
     * The repository the Blueprint is for, as the catalog names it; `null` when
     * the catalog does not have the Blueprint or could not be read.
     */
    readonly repositoryUrl: string | null;
    /** Ever Platform's id of the install the App is created for, when the address named one. */
    readonly installId: string | null;
}

/** The query keys of the hand-off address. */
export const BLUEPRINT_HANDOFF_PARAMS = ['blueprint', 'install', 'ever_org'] as const;

/** A Blueprint's id in the Apps catalog, as the API reads `blueprintId`. */
const BLUEPRINT_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
/** An install id as Ever Platform issues it (a ULID): 26 Crockford base32 characters. */
const INSTALL_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** An Ever organization: Ever Platform's id of it, or its handle. */
const EVER_ORG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type Query = Readonly<Record<string, string | readonly string[] | undefined>> | URLSearchParams;

type Env = Readonly<Record<string, string | undefined>>;

/** The web app's switch of the hand-off (server-side only, never `NEXT_PUBLIC_`). */
export const BLUEPRINT_HANDOFF_SWITCH = 'EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED';

/**
 * Whether this web app reads a Blueprint hand-off. Off by default; only the
 * exact value `true` (any case) turns it on, as for every Ever Connect switch.
 * Read per call, so a change needs a restart of the web app and no new build.
 */
export function isBlueprintHandoffEnabled(env: Env = process.env): boolean {
    return env[BLUEPRINT_HANDOFF_SWITCH]?.trim().toLowerCase() === 'true';
}

/**
 * The canonical spelling of an install id, or `null` when the value is not one.
 * The runtime twin of `normalizeEverPlatformInstallId` in `@ever-works/contracts`
 * (kept here so the proxy and the browser do not load that package for one
 * pattern); the unit spec pins that the two agree.
 */
export function normalizeInstallId(input: unknown): string | null {
    if (typeof input !== 'string' || input.length > 64) return null;
    const id = input.trim().toUpperCase();
    return INSTALL_ID.test(id) ? id : null;
}

function valueOf(query: Query, key: string): string {
    const raw = query instanceof URLSearchParams ? query.get(key) : query[key];
    // A key given twice is not a value this reads.
    return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * The hand-off an address carries, or `null` when it carries none: no
 * `blueprint`, or one that is not spelled like a Blueprint id. An install or an
 * Ever organization that is not spelled like one is left out (the App can still
 * be created); neither means anything without the Blueprint.
 */
export function readBlueprintHandoff(query: Query): BlueprintHandoff | null {
    const blueprint = valueOf(query, 'blueprint');
    if (!BLUEPRINT_ID.test(blueprint)) return null;
    const everOrg = valueOf(query, 'ever_org');
    return {
        blueprint,
        install: normalizeInstallId(valueOf(query, 'install')),
        everOrg: EVER_ORG.test(everOrg) ? everOrg : null,
    };
}

/**
 * {@link readBlueprintHandoff} for the pages: `null` while the switch is off
 * ({@link isBlueprintHandoffEnabled}), whatever the address carries.
 */
export function readEnabledBlueprintHandoff(
    query: Query,
    env: Env = process.env,
): BlueprintHandoff | null {
    return isBlueprintHandoffEnabled(env) ? readBlueprintHandoff(query) : null;
}

/** The hand-off as query entries, in a fixed order: only what was read, never the address as it came. */
export function blueprintHandoffEntries(handoff: BlueprintHandoff): Array<[string, string]> {
    const entries: Array<[string, string]> = [['blueprint', handoff.blueprint]];
    if (handoff.everOrg) entries.push(['ever_org', handoff.everOrg]);
    if (handoff.install) entries.push(['install', handoff.install]);
    return entries;
}

/**
 * The create form's address for a hand-off (`/works/new`, the App form, the
 * Blueprint preselected). Unprefixed: the caller adds the workspace it is in.
 */
export function blueprintHandoffFormHref(handoff: BlueprintHandoff): string {
    const query = new URLSearchParams([
        ['mode', 'manual'],
        ['kind', 'app'],
        ...blueprintHandoffEntries(handoff),
    ]);
    return `${ROUTES.DASHBOARD_WORKS_NEW}?${query.toString()}`;
}

/** The path without a leading `/org/<slug>` workspace prefix. */
function withoutWorkspacePrefix(pathname: string): string {
    return pathname.replace(/^\/org\/[^/]+(?=\/|$)/, '') || '/';
}

/**
 * Where a signed-out visitor of a hand-off address is sent: the sign-in page,
 * told to come back to the same hand-off. `null` for every other address, and
 * for every address while the switch is off (the caller then redirects to
 * sign-in as it always did).
 *
 * The address to come back to is rebuilt from the values that were read: the
 * path the visitor asked for (`/new` or `/works/new`, with its workspace prefix
 * when it has a well-formed one) and the hand-off's own entries. Nothing else
 * of the query travels on, so a hand-off cannot be used to carry anything
 * through sign-in but itself, and the target is always a path of this site.
 */
export function blueprintHandoffSignInHref(
    pathname: string,
    query: URLSearchParams,
    env: Env = process.env,
): string | null {
    if (!isBlueprintHandoffEnabled(env)) return null;
    const page = withoutWorkspacePrefix(pathname);
    if (page !== ROUTES.DASHBOARD_NEW && page !== ROUTES.DASHBOARD_WORKS_NEW) return null;
    // A well-formed path of this site only: a single leading slash, no backslash.
    if (!/^\/(?:org\/[a-z0-9]+(?:-[a-z0-9]+)*\/)?(?:new|works\/new)$/.test(pathname)) return null;
    // Only the App hand-off: `/new?type=app&blueprint=…` or `/works/new?kind=app&blueprint=…`.
    const kind = valueOf(query, page === ROUTES.DASHBOARD_NEW ? 'type' : 'kind').toLowerCase();
    if (kind !== 'app') return null;
    const handoff = readBlueprintHandoff(query);
    if (!handoff) return null;

    const back = new URLSearchParams(
        page === ROUTES.DASHBOARD_NEW
            ? [['type', 'app'], ...blueprintHandoffEntries(handoff)]
            : [['mode', 'manual'], ['kind', 'app'], ...blueprintHandoffEntries(handoff)],
    );
    const signIn = new URLSearchParams([[REDIRECT_SEARCH_PARAM, `${pathname}?${back.toString()}`]]);
    return `${ROUTES.AUTH_LOGIN}?${signIn.toString()}`;
}

/** One of the person's Organizations, with what its link to an Ever organization says. */
export interface LinkedOrganization {
    readonly slug: string;
    readonly everOrgId: string | null;
    readonly handle: string | null;
}

/**
 * The Organization linked to the Ever organization a hand-off names, among the
 * person's own: by Ever Platform's id of it, else by its handle (case does not
 * matter in a handle). `null` when none is, or when two would match.
 */
export function organizationOfEverOrg(
    everOrg: string,
    organizations: readonly LinkedOrganization[],
): LinkedOrganization | null {
    const byId = organizations.filter((organization) => organization.everOrgId === everOrg);
    if (byId.length === 1) return byId[0];
    if (byId.length > 1) return null;
    const handle = everOrg.toLowerCase();
    const byHandle = organizations.filter(
        (organization) => (organization.handle ?? '').toLowerCase() === handle,
    );
    return byHandle.length === 1 ? byHandle[0] : null;
}
