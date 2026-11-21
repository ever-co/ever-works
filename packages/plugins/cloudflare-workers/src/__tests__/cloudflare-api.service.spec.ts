import { describe, it, expect, vi } from 'vitest';
import { CloudflareApiClient, CloudflareApiError } from '../cloudflare-api.service';

const ACCOUNT = 'a'.repeat(32);

const json = (status: number, body: unknown): Response =>
	({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body)
	}) as unknown as Response;

function client(fetchImpl: ReturnType<typeof vi.fn>) {
	return new CloudflareApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0 });
}

describe('CloudflareApiClient', () => {
	it('verifies an account-owned token on the account endpoint with a bearer header', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(json(200, { success: true, result: { status: 'active' } }));
		await expect(client(fetchImpl).verifyAccountToken('tok', ACCOUNT)).resolves.toBe(true);

		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/tokens/verify`);
		expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
	});

	it('answers false for a rejected token instead of throwing', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(json(401, { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] }));
		await expect(client(fetchImpl).verifyAccountToken('bad', ACCOUNT)).resolves.toBe(false);
		await expect(client(fetchImpl).verifyUserToken('bad')).resolves.toBe(false);
	});

	it('returns null deployments for a Worker that does not exist', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(json(404, { success: false, errors: [{ code: 10007, message: 'not found' }] }));
		await expect(client(fetchImpl).getWorkerDeployments('tok', ACCOUNT, 'ew-crm')).resolves.toBeNull();
		expect(fetchImpl.mock.calls[0][0]).toBe(
			`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/ew-crm/deployments`
		);
	});

	it('returns the deployments of an existing Worker', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			json(200, {
				success: true,
				result: { deployments: [{ id: 'd1', created_on: '2026-11-20T00:00:00Z' }] }
			})
		);
		await expect(client(fetchImpl).getWorkerDeployments('tok', ACCOUNT, 'ew-crm')).resolves.toHaveLength(1);
	});

	it('filters Worker domains by service and hostname, also client-side', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			json(200, {
				success: true,
				result: [
					{ id: '1', hostname: 'crm.ever.works', service: 'ew-crm' },
					{ id: '2', hostname: 'other.ever.works', service: 'ew-other' }
				],
				result_info: { page: 1, total_pages: 1 }
			})
		);
		const domains = await client(fetchImpl).listWorkerDomains('tok', ACCOUNT, {
			service: 'ew-crm',
			hostname: 'crm.ever.works'
		});
		expect(domains.map((d) => d.id)).toEqual(['1']);
		const url = new URL(fetchImpl.mock.calls[0][0] as string);
		expect(url.pathname).toBe(`/client/v4/accounts/${ACCOUNT}/workers/domains`);
		expect(url.searchParams.get('service')).toBe('ew-crm');
		expect(url.searchParams.get('hostname')).toBe('crm.ever.works');
	});

	it('attaches a domain with PUT and a JSON body', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			json(200, {
				success: true,
				result: { id: 'x', hostname: 'www.acme.com', service: 'ew-crm', zone_id: 'z' }
			})
		);
		const result = await client(fetchImpl).attachWorkerDomain('tok', ACCOUNT, {
			hostname: 'www.acme.com',
			service: 'ew-crm',
			zoneId: 'z'
		});
		expect(result.id).toBe('x');
		const init = fetchImpl.mock.calls[0][1] as RequestInit;
		expect(init.method).toBe('PUT');
		expect(JSON.parse(init.body as string)).toEqual({ hostname: 'www.acme.com', service: 'ew-crm', zone_id: 'z' });
	});

	it('treats a detach that answers result: null as success, and 404 as already gone', async () => {
		const ok = vi.fn().mockResolvedValue(json(200, { success: true, result: null }));
		await expect(client(ok).detachWorkerDomain('tok', ACCOUNT, 'dom1')).resolves.toBe(true);
		expect((ok.mock.calls[0][1] as RequestInit).method).toBe('DELETE');

		const gone = vi.fn().mockResolvedValue(json(404, { success: false }));
		await expect(client(gone).detachWorkerDomain('tok', ACCOUNT, 'dom1')).resolves.toBe(false);
	});

	it('finds a zone by exact name within the account', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(json(200, { success: true, result: [{ id: 'z1', name: 'ever.works' }] }));
		await expect(client(fetchImpl).findZone('tok', ACCOUNT, 'ever.works')).resolves.toEqual({
			id: 'z1',
			name: 'ever.works'
		});
		const url = new URL(fetchImpl.mock.calls[0][0] as string);
		expect(url.searchParams.get('name')).toBe('ever.works');
		expect(url.searchParams.get('account.id')).toBe(ACCOUNT);
	});

	it('retries once on a 5xx and then succeeds', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(json(502, {}))
			.mockResolvedValueOnce(json(200, { success: true, result: { deployments: [] } }));
		await expect(client(fetchImpl).getWorkerDeployments('tok', ACCOUNT, 'ew-crm')).resolves.toEqual([]);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('throws a sanitised CloudflareApiError without the token on a hard failure', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				json(403, { success: false, errors: [{ code: 10000, message: 'Authentication\nerror' }] })
			);
		const error = await client(fetchImpl)
			.countWorkerScripts('secret-token', ACCOUNT)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CloudflareApiError);
		expect((error as CloudflareApiError).status).toBe(403);
		expect((error as CloudflareApiError).codes).toEqual([10000]);
		expect((error as Error).message).toContain('Authentication error');
		expect((error as Error).message).not.toContain('secret-token');
	});

	it('wraps a network failure after the retry', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
		await expect(client(fetchImpl).verifyUserToken('tok')).rejects.toThrow(/ECONNRESET/);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
});
