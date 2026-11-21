import { DEMO_EXPIRED_HREF, getAuthFromCookieOnSignIn } from '@/lib/auth';
import { getDemoConfig } from '@/lib/feature-flags/demo';

/**
 * Platform demo mode — the stop between a demo session the API rejected (the sandbox expired,
 * or the sweeper took it) and `/login?demo=expired`.
 *
 * `getAuthFromCookie` notices the expiry while a page RENDERS, where Next.js refuses to change a
 * cookie, so the stale session cookie used to survive the redirect: every other page that reads
 * the session then asked the API again, got a 401 and sent the visitor back to the sign-in page,
 * until they started a new demo. A route handler may write cookies, so a render sends the
 * visitor here first (a Server Action removes the cookie itself and skips this stop).
 *
 * The cookie goes only when the API rejects it: the session is checked once more through the
 * sign-in page's variant of the check, which removes a rejected cookie (as it does everywhere
 * the write is legal) and never redirects. A session the API still accepts keeps its cookie,
 * so a link to this address signs no one out; the sign-in page then sends that visitor on to
 * the dashboard.
 *
 * Demo off: nothing redirects here, and the address answers 404 without reading or touching
 * any cookie, as before it existed.
 *
 * Both answers are `Cache-Control: no-store`: one depends on the visitor's own cookie and may
 * remove it, so no shared cache (a CDN's "cache everything" rule, say) may ever keep either.
 */
const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(): Promise<Response> {
    if (!(await getDemoConfig()).enabled) {
        return new Response(null, { status: 404, headers: NO_STORE });
    }

    try {
        await getAuthFromCookieOnSignIn();
    } catch (error) {
        // The API could not answer (a 5xx): the cookie stays, and the sign-in page asks again.
        console.warn('Could not check the expired demo session; leaving its cookie', error);
    }

    // A relative Location, as `redirect()` sends one: `localePrefix: 'never'`, so the plain path
    // is the whole URL, and no host taken from the request (which can be an internal one behind
    // a proxy) ends up in it. The cookie removal above rides on this response.
    return new Response(null, {
        status: 307,
        headers: { ...NO_STORE, location: DEMO_EXPIRED_HREF },
    });
}
