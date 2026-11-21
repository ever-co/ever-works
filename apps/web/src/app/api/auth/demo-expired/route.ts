import { getLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { DEMO_EXPIRED_HREF, getAuthFromCookieOnSignIn } from '@/lib/auth';
import { getDemoConfig } from '@/lib/feature-flags/demo';

/**
 * Platform demo mode — the stop between a demo session the API rejected (the sandbox expired,
 * or the sweeper took it) and `/login?demo=expired`.
 *
 * `getAuthFromCookie` notices the expiry while a page RENDERS, where Next.js refuses to change a
 * cookie, so the stale session cookie used to survive the redirect: every other page that reads
 * the session then asked the API again, got a 401 and sent the visitor back to the sign-in page,
 * until they started a new demo. A route handler may write cookies, so it sends the visitor
 * here first.
 *
 * The cookie goes only when the API rejects it: the session is checked once more through the
 * sign-in page's variant of the check, which removes a rejected cookie (as it does everywhere
 * the write is legal) and never redirects. A session the API still accepts keeps its cookie,
 * so a link to this address signs no one out; the sign-in page then sends that visitor on to
 * the dashboard.
 *
 * Demo off: nothing redirects here, and the address answers 404 without reading or touching
 * any cookie, as before it existed.
 */
export async function GET(): Promise<Response> {
    if (!(await getDemoConfig()).enabled) {
        return new Response(null, { status: 404 });
    }

    try {
        await getAuthFromCookieOnSignIn();
    } catch (error) {
        // The API could not answer (a 5xx): the cookie stays, and the sign-in page asks again.
        console.warn('Could not check the expired demo session; leaving its cookie', error);
    }

    const locale = await getLocale();
    // `localePrefix: 'never'` — the plain path is the whole URL.
    return redirect({ locale, href: DEMO_EXPIRED_HREF });
}
