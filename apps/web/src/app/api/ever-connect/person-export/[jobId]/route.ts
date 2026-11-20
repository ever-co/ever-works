import { NextRequest, NextResponse } from 'next/server';
import { API_URL, REDIRECT_SEARCH_PARAM, ROUTES } from '@/lib/constants';
import { bffProxy } from '@/lib/api/bff-proxy';
import { getAuthAccessCookie } from '@/lib/auth/cookies';

/**
 * A person's export for an Ever Platform request: the address Ever Works gave
 * Ever Platform in its `exported` answer, opened by the person.
 *
 * Signed out: to the sign-in page (open the address again once signed in).
 * Signed in: the API's `GET /api/ever-connect/person-exports/:jobId`, which
 * answers the signed-in account's own data only, as a download. Everything else
 * the API answers (the switch off, an unknown or old address) is a plain `404`
 * here, so the address tells nothing.
 *
 * The token travels in the `Authorization` header `bffProxy` builds, never in a
 * URL. The export belongs to the person, not to a workspace: no scope is sent.
 */
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ jobId: string }> };

/** A platform job id (a ULID). */
const JOB_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

const download = bffProxy<RouteContext>(
    async ({ headers }, ctx) => {
        const { jobId } = await ctx.params;
        if (!JOB_ID.test(jobId)) return notFound();
        headers.set('Accept', 'application/json');
        let upstream: Response;
        try {
            upstream = await fetch(`${API_URL}/ever-connect/person-exports/${jobId}`, {
                headers,
                cache: 'no-store',
            });
        } catch {
            return new NextResponse(null, { status: 502, headers: NO_STORE });
        }
        if (upstream.status === 429) {
            return new NextResponse(null, { status: 429, headers: NO_STORE });
        }
        if (!upstream.ok) return notFound();
        return new NextResponse(upstream.body, {
            status: 200,
            headers: {
                ...NO_STORE,
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Disposition': 'attachment; filename="ever-works-person-data.json"',
            },
        });
    },
    {
        scope: 'none',
        reason: "A person's own data export: it belongs to the account, not to a workspace.",
    },
);

export async function GET(request: NextRequest, ctx: RouteContext): Promise<Response> {
    if (!(await getAuthAccessCookie())) {
        const { jobId } = await ctx.params;
        if (!JOB_ID.test(jobId)) return notFound();
        return signIn(jobId);
    }
    return download(request, ctx);
}

/**
 * To the sign-in page, which brings the person back to this address once they are signed in
 * (`redirect_uri`, a path of this site). `Location` is a path, sent as given: behind the
 * ingress the request's own URL names the pod (`https://<pod>:3000/...`), never the public
 * address, so an absolute address built from it would send the person nowhere.
 */
function signIn(jobId: string): Response {
    const back = `/api/ever-connect/person-export/${jobId}`;
    const query = new URLSearchParams([[REDIRECT_SEARCH_PARAM, back]]);
    return new NextResponse(null, {
        status: 307,
        headers: { ...NO_STORE, Location: `${ROUTES.AUTH_LOGIN}?${query.toString()}` },
    });
}

function notFound(): Response {
    return new NextResponse(null, { status: 404, headers: NO_STORE });
}
