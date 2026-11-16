import { toEverIdReturnTo } from './ever-id';

/**
 * Ever ID — the rules of the sign-in start address
 * (`GET /api/auth/ever-id/start`, `app/api/auth/ever-id/start/route.ts`).
 *
 * The address lets a link from another Ever app begin "Sign in with Ever ID"
 * directly, instead of landing on the sign-in page. A link is the one thing it
 * is for, and anyone can write a link, so everything here treats the request
 * as untrusted:
 *
 *  - {@link isEverIdStartRouteEnabled}: the switch. Off by default.
 *  - {@link isEverIdStartNavigation}: only a person following a link starts a
 *    sign-in, never a page loading the address in the background.
 *  - {@link readEverIdStartReturnPath}: where to land afterwards, when the link
 *    names a path of this site and nothing else.
 *
 * Nothing here reads a cookie or holds a secret, so the unit spec exercises
 * every rule without a request.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** The web app's switch of the start address (server-side only, never `NEXT_PUBLIC_`). */
export const EVER_ID_START_ROUTE_SWITCH = 'EVER_ID_START_ROUTE_ENABLED';

/**
 * Whether this web app answers the start address. Off by default; only the
 * exact value `true` (any case) turns it on. Read per call, so a change needs a
 * restart of the web app and no new build.
 */
export function isEverIdStartRouteEnabled(env: Env = process.env): boolean {
    return env[EVER_ID_START_ROUTE_SWITCH]?.trim().toLowerCase() === 'true';
}

/** The query key naming where to land after signing in. */
export const EVER_ID_START_RETURN_PARAM = 'return';

/**
 * Whether the request is a person following a link: a `GET` that a browser
 * marks as a top-level navigation.
 *
 * Browsers describe every request they make (`Sec-Fetch-Mode`,
 * `Sec-Fetch-Dest`), and a page cannot forge those headers. A request another
 * site makes in the background (an image, a script, a frame, a `fetch`) or
 * ahead of a click (a prefetch) is therefore told apart from a click and
 * starts nothing: no sign-in transaction, no cookie, no call that counts
 * against the sign-in rate limit. A client that sends none of the headers (an
 * old browser, a command-line check) is taken at its word, as it could send
 * whatever it liked anyway.
 */
export function isEverIdStartNavigation(request: {
    readonly method: string;
    readonly headers: Pick<Headers, 'get'>;
}): boolean {
    if (request.method !== 'GET') return false;

    const mode = request.headers.get('sec-fetch-mode');
    if (mode && mode !== 'navigate') return false;

    const destination = request.headers.get('sec-fetch-dest');
    if (destination && destination !== 'document') return false;

    const purpose = request.headers.get('sec-purpose') ?? request.headers.get('purpose');
    if (purpose && /prefetch|prerender|preview/i.test(purpose)) return false;

    return true;
}

/** How many layers of percent-encoding a return path is unwrapped through. */
const MAX_DECODE_ROUNDS = 4;

/**
 * Characters no path of this site contains: control characters, invisible
 * formatting characters, and line or paragraph separators. Browsers drop some
 * of them (a tab, a line break) while reading an address, which is how
 * `/<tab>/other.example` turns into `//other.example`.
 */
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A stand-in origin: the path is resolved against it the way a browser would. */
const PROBE_ORIGIN = 'https://start.invalid';

/** The part of an address before its query or fragment. */
function pathPart(value: string): string {
    const end = value.search(/[?#]/);
    return end === -1 ? value : value.slice(0, end);
}

/**
 * Whether `value` has a shape that can leave this site, or be read as one that
 * does by something that normalises it: a backslash (browsers read it as a
 * slash), an unsafe character, an empty path segment (`//`), or a `.` / `..`
 * segment.
 */
function hasUnsafeShape(value: string): boolean {
    if (value.includes('\\') || UNSAFE_CHARACTERS.test(value)) return true;

    const path = pathPart(value);
    if (path.includes('//')) return true;

    return path.split('/').some((segment) => segment === '.' || segment === '..');
}

/**
 * A return path of this site, or `undefined`.
 *
 * Stricter than {@link toEverIdReturnTo}, which it ends with, because here the
 * value comes straight from a link anyone can write:
 *
 *  - it is taken exactly as given: surrounding whitespace is not trimmed away;
 *  - no absolute URL, no `//host`, no backslash, no control or invisible
 *    character, no empty or dot segment in the path;
 *  - **the same holds for every percent-decoded form of it.** The value is
 *    decoded until it stops changing, and each layer is checked, so `%2F%2F`,
 *    `%5C`, `%09`, `%2e%2e` and their double-encoded spellings are refused. A
 *    malformed escape, or more than {@link MAX_DECODE_ROUNDS} layers, is
 *    refused too;
 *  - a browser's own URL parser must agree that it stays on the origin it is
 *    resolved against.
 *
 * A refused value is never repaired. The caller falls back to the normal
 * post-sign-in page, exactly as it does when the link names no path.
 */
export function toEverIdStartReturnPath(value: unknown): string | undefined {
    if (typeof value !== 'string' || toEverIdReturnTo(value) !== value) return undefined;

    let layer = value;
    for (let round = 0; ; round += 1) {
        if (hasUnsafeShape(layer)) return undefined;

        let decoded: string;
        try {
            decoded = decodeURIComponent(layer);
        } catch {
            return undefined;
        }
        if (decoded === layer) break;
        if (round === MAX_DECODE_ROUNDS) return undefined;
        layer = decoded;
    }

    try {
        const resolved = new URL(value, PROBE_ORIGIN);
        if (resolved.origin !== PROBE_ORIGIN || resolved.pathname.startsWith('//')) {
            return undefined;
        }
    } catch {
        return undefined;
    }

    return value;
}

/**
 * The return path a start address names: its one `return` value, when that is
 * a path of this site ({@link toEverIdStartReturnPath}). `undefined` when the
 * key is absent, refused, or given more than once (two values are not a value
 * this reads).
 */
export function readEverIdStartReturnPath(query: URLSearchParams): string | undefined {
    const values = query.getAll(EVER_ID_START_RETURN_PARAM);
    return values.length === 1 ? toEverIdStartReturnPath(values[0]) : undefined;
}
