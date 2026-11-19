import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The person-export address an installation answers Ever Platform with
 * (`GET /api/ever-connect/person-export/:jobId`), signed out: to the sign-in
 * page by a path of this site, never by an address built from the request's own
 * URL (behind the ingress that URL names the pod), with the way back to this
 * address. Signed in, the download itself is the API's (`person-data-export`).
 */

const { accessCookie, fetchMock } = vi.hoisted(() => ({
    accessCookie: { value: undefined as string | undefined },
    fetchMock: vi.fn(),
}));

vi.mock('@/lib/auth/cookies', () => ({ getAuthAccessCookie: async () => accessCookie.value }));
vi.mock('@/lib/api/bff-proxy', () => ({
    bffProxy:
        (handler: (init: { headers: Headers }, ctx: unknown) => Promise<Response>) =>
        (_request: unknown, ctx: unknown) =>
            handler({ headers: new Headers() }, ctx),
}));

const JOB = '01JABCDEFGHJKMNPQRSTVWXYZ0';
/** The request as it reaches the route behind the ingress: its URL names the pod. */
function request(jobId: string) {
    return {
        url: `https://ever-works-web-7d46d9dc6-74fpr:3000/api/ever-connect/person-export/${jobId}`,
        nextUrl: new URL(
            `https://ever-works-web-7d46d9dc6-74fpr:3000/api/ever-connect/person-export/${jobId}`,
        ),
        headers: new Headers(),
    } as unknown as import('next/server').NextRequest;
}
async function run(jobId: string): Promise<Response> {
    const { GET } = await import('./route');
    return GET(request(jobId), { params: Promise.resolve({ jobId }) });
}

beforeEach(() => {
    accessCookie.value = undefined;
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('GET /api/ever-connect/person-export/:jobId, signed out', () => {
    it('sends the person to the sign-in page by a path, with the way back, and calls nothing', async () => {
        const response = await run(JOB);
        expect(response.status).toBe(307);
        const location = response.headers.get('Location')!;
        expect(location.startsWith('/login?')).toBe(true);
        expect(location).not.toContain('ever-works-web');
        expect(location).not.toContain('://');
        expect(new URLSearchParams(location.split('?')[1]).get('redirect_uri')).toBe(
            `/api/ever-connect/person-export/${JOB}`,
        );
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers 404 for an address that is not a job, without a sign-in detour', async () => {
        for (const bad of ['not-a-job', `${JOB}x`, '..%2F..%2Flogin']) {
            const response = await run(bad);
            expect(response.status).toBe(404);
            expect(response.headers.get('Location')).toBeNull();
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('GET /api/ever-connect/person-export/:jobId, signed in', () => {
    it("streams the API's document as a download", async () => {
        accessCookie.value = 'session';
        fetchMock.mockResolvedValue(
            new Response('{"format":"ever-works.person-data"}', { status: 200 }),
        );
        const response = await run(JOB);
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Disposition')).toContain('attachment');
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});
