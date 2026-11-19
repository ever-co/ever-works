import { describe, it, expect, vi } from 'vitest';
import { createImageDigestResolver } from '../image-digest';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function fakeRegistry(opts: { tokenStatus?: number; manifestStatus?: number; digest?: string | null } = {}) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const href = String(url);
		calls.push({ url: href, init });
		if (href.includes('/token?')) {
			return new Response(JSON.stringify({ token: 'tok' }), { status: opts.tokenStatus ?? 200 });
		}
		const headers = new Headers();
		const digest = opts.digest === undefined ? DIGEST : opts.digest;
		if (digest) headers.set('docker-content-digest', digest);
		return new Response(null, { status: opts.manifestStatus ?? 200, headers });
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

describe('createImageDigestResolver', () => {
	it('resolves a GHCR tag to its digest with a pull-scoped token', async () => {
		const { fetchImpl, calls } = fakeRegistry();
		const resolve = createImageDigestResolver(fetchImpl);
		const digest = await resolve('ghcr.io/ever-works/awesome-mcp-servers-website:prod', {
			username: 'x-access-token',
			password: 'secret'
		});
		expect(digest).toBe(DIGEST);
		expect(calls[0].url).toBe(
			'https://ghcr.io/token?scope=repository%3Aever-works%2Fawesome-mcp-servers-website%3Apull&service=ghcr.io'
		);
		expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
			`Basic ${Buffer.from('x-access-token:secret').toString('base64')}`
		);
		expect(calls[1].url).toBe('https://ghcr.io/v2/ever-works/awesome-mcp-servers-website/manifests/prod');
		expect(calls[1].init?.method).toBe('HEAD');
		expect((calls[1].init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
	});

	it('asks for an anonymous token for a public image', async () => {
		const { fetchImpl, calls } = fakeRegistry();
		expect(await createImageDigestResolver(fetchImpl)('ghcr.io/acme/site:prod')).toBe(DIGEST);
		expect((calls[0].init?.headers as Record<string, string>).Authorization).toBeUndefined();
	});

	it('returns null when the token, the manifest or the digest is not right', async () => {
		const image = 'ghcr.io/acme/site:prod';
		expect(await createImageDigestResolver(fakeRegistry({ tokenStatus: 401 }).fetchImpl)(image)).toBeNull();
		expect(await createImageDigestResolver(fakeRegistry({ manifestStatus: 404 }).fetchImpl)(image)).toBeNull();
		expect(await createImageDigestResolver(fakeRegistry({ digest: null }).fetchImpl)(image)).toBeNull();
		expect(await createImageDigestResolver(fakeRegistry({ digest: 'sha256:short' }).fetchImpl)(image)).toBeNull();
	});

	it('returns null on a network error and for a reference it cannot parse', async () => {
		const failing = vi.fn(async () => {
			throw new Error('TLS handshake timeout');
		}) as unknown as typeof fetch;
		expect(await createImageDigestResolver(failing)('ghcr.io/acme/site:prod')).toBeNull();
		const { fetchImpl } = fakeRegistry();
		expect(await createImageDigestResolver(fetchImpl)('ghcr.io/acme/site@sha256:abc')).toBeNull();
		expect(await createImageDigestResolver(fetchImpl)('not an image')).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
