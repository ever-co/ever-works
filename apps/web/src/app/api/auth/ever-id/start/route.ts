import { NextRequest, NextResponse } from 'next/server';
import { getLocale } from 'next-intl/server';
import { EVER_ID_ERROR_CODE_WIRE_VALUES } from '@ever-works/contracts';
import { getPathname } from '@/i18n/navigation';
import { everIdAPI, EverIdRequestError, toEverIdFailure } from '@/lib/api/ever-id';
import { getAuthFromCookie, getRedirectCookie } from '@/lib/auth';
import { everIdErrorPageHref, toEverIdReturnTo } from '@/lib/auth/ever-id';
import { setEverIdTransaction } from '@/lib/auth/ever-id-cookies';
import {
    isEverIdStartNavigation,
    isEverIdStartRouteEnabled,
    readEverIdStartReturnPath,
} from '@/lib/auth/ever-id-start';
import { getEverIdAvailability } from '@/lib/auth/providers';
import { ROUTES } from '@/lib/constants';
import { EVER_ID_ANONYMOUS_DISTINCT_ID, isEverIdOffered } from '@/lib/feature-flags/ever-id';

/**
 * Ever ID — a link that begins "Sign in with Ever ID" directly.
 *
 *     GET /api/auth/ever-id/start[?return=/a/path/of/this/site]
 *
 * Another Ever app that links here ("Open Ever Works") lands a person in the
 * sign-in flow instead of on the sign-in page. It starts exactly what the
 * "Sign in with Ever ID" button starts (`startEverIdSignIn`,
 * `app/actions/ever-id.ts`): the API mints the `state` and the PKCE pair for
 * this one request (`POST /auth/ever-id/authorize`), the sealed transaction is
 * kept in the same two cookies (`setEverIdTransaction`), and the browser goes
 * to the provider's authorization address. The callback route finishes the
 * sign-in as it does for the button and re-validates the return path.
 *
 * | Request                                    | Answer                                   |
 * | ------------------------------------------ | ---------------------------------------- |
 * | switch off (the default)                   | `404`, nothing read, nothing called      |
 * | not a top-level `GET` navigation           | `404`, nothing called                    |
 * | any other method                           | `404`, nothing called                    |
 * | Ever ID not offered on the sign-in page    | `404`                                    |
 * | already signed in                          | the destination, no new authorization    |
 * | signed out                                 | the provider's authorization address     |
 * | the sign-in cannot start (limit, outage)   | the auth error page, with a code only    |
 *
 * The destination is the `return` path when it is a path of this site
 * (`readEverIdStartReturnPath`), otherwise the normal post-sign-in page. A
 * refused `return` is ignored, never repaired, and never an error: the person
 * still signs in.
 *
 * **Safe as a cross-site link.** A `GET` anyone can link to must change
 * nothing by itself:
 *
 *  - it signs nobody in: that takes the person's own sign-in at the provider
 *    and the callback's `state` / PKCE check against this browser's cookie;
 *  - a signed-in person is only sent to a path of this site, as a plain link to
 *    that path would;
 *  - nothing another site loads in the background starts a transaction
 *    (`isEverIdStartNavigation`);
 *  - the API's limit on `authorize` applies, because this is the same call
 *    through the same client; a `429` lands on the error page with the wait;
 *  - every answer is `Cache-Control: no-store` and carries the Referrer-Policy
 *    of the sign-in page, and no address built here holds a token, the `state`
 *    or the transaction.
 *
 * Under `/api` because the app's other Ever ID addresses live here and the
 * proxy leaves `/api` alone: with the switch off the path answers `404` to
 * everyone, as any unknown `/api` path does, and nothing else in the app
 * changes.
 */

/**
 * Answered per request, never from a build or a cache: the switch, the cookies
 * and the transaction all belong to the one request.
 */
export const dynamic = 'force-dynamic';

/**
 * The app-wide Referrer-Policy, the one the sign-in page is served with
 * (`next.config.ts` and `proxy.ts`; the unit spec fails if they stop agreeing).
 */
const REFERRER_POLICY = 'strict-origin-when-cross-origin';

const RESPONSE_HEADERS = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': REFERRER_POLICY,
} as const;

/** What an unknown path answers: a `404` with no body. */
function notFound(): NextResponse {
    return new NextResponse(null, { status: 404, headers: RESPONSE_HEADERS });
}

/**
 * A temporary redirect, as `redirect()` answers in a route handler (`307`), with
 * this route's headers. `location` is a path of this site (sent as given, so it
 * never depends on what the server believes its own origin is) or the
 * provider's authorization address.
 */
function redirectTo(location: string): NextResponse {
    return new NextResponse(null, {
        status: 307,
        headers: { ...RESPONSE_HEADERS, Location: location },
    });
}

/**
 * The provider address the API returned, checked to be an absolute http(s) URL
 * (http only matters for a local provider in development): the check
 * `startEverIdSignIn` applies before it navigates. Here the address goes into a
 * `Location` header, so it is sent as the URL parser writes it, which is always
 * a valid header value (and the same text for any well-formed address).
 */
function toProviderUrl(value: unknown): string {
    if (typeof value === 'string') {
        try {
            const url = new URL(value);
            if (url.protocol === 'https:' || url.protocol === 'http:') {
                return url.href;
            }
        } catch {
            // fall through
        }
    }
    throw new Error('Ever ID answered without a usable provider address');
}

export async function GET(request: NextRequest) {
    if (!isEverIdStartRouteEnabled() || !isEverIdStartNavigation(request)) {
        return notFound();
    }

    // The gate of the "Sign in with Ever ID" button on the sign-in page: an
    // administrator turned Ever ID on, and the rollout flag is on for a
    // signed-out visitor (asked only when the first holds).
    const availability = await getEverIdAvailability();
    if (!(await isEverIdOffered(availability, EVER_ID_ANONYMOUS_DISTINCT_ID))) {
        return notFound();
    }

    const locale = await getLocale();
    const returnPath = readEverIdStartReturnPath(request.nextUrl.searchParams);

    // Already signed in (checked the way the sign-in page checks it, so a
    // session the API no longer accepts does not count): straight to the
    // destination, and no authorization is started. A check that fails outright
    // reads as signed out: the person then signs in, which is always safe.
    if (await getAuthFromCookie().catch(() => null)) {
        return redirectTo(getPathname({ locale, href: returnPath ?? ROUTES.DASHBOARD }));
    }

    // As the button: an explicit return path wins; otherwise a relative
    // destination the app stored before sign-in (an invitation, say).
    const target = returnPath ?? toEverIdReturnTo(await getRedirectCookie());

    let authorizationUrl: string;
    try {
        const response = await everIdAPI.authorize(target ? { returnTo: target } : {});
        authorizationUrl = toProviderUrl(response.authorizationUrl);
        await setEverIdTransaction(response.transaction, 'sign-in');
    } catch (error) {
        // Turned off between the check above and this call: still not an address.
        if (
            error instanceof EverIdRequestError &&
            error.code === EVER_ID_ERROR_CODE_WIRE_VALUES.everIdDisabled
        ) {
            return notFound();
        }

        // Anyone can request this address, so a refusal is logged as its status
        // and code only, never as the answer's body.
        console.error(
            'Ever ID sign-in could not start:',
            error instanceof EverIdRequestError ? error.message : error,
        );
        const failure = toEverIdFailure(error, 'provider_unavailable');
        return redirectTo(
            getPathname({
                locale,
                href: everIdErrorPageHref(failure.code, failure.retryAfterSeconds),
            }),
        );
    }

    return redirectTo(authorizationUrl);
}

/**
 * The address is a link: a `GET`, and nothing else. Every other method gets the
 * `404` of a path that does not exist, whatever the switch says, in place of
 * the `405` and the `Allow` list that would tell a route is here while it is
 * off. (`HEAD` is answered through `GET`, which refuses it the same way.)
 */
async function notALink(): Promise<NextResponse> {
    return notFound();
}

export const POST = notALink;
export const PUT = notALink;
export const PATCH = notALink;
export const DELETE = notALink;
export const OPTIONS = notALink;
