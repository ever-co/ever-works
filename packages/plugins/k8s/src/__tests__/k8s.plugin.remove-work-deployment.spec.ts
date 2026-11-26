import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KubernetesPlugin } from '../k8s.plugin';
import type { KubernetesApiService } from '../k8s-api.service';
import { K8sPluginError } from '../errors';

/**
 * `KubernetesPlugin.removeWorkDeployment` — what a deleted website Work leaves
 * behind on the cluster.
 *
 * The objects are the five `deploy()` writes (Ingress, Service, Deployment, the
 * `-runtime-env` and `-pull` Secrets), named after the website repository in the
 * enforced namespace. Each one is deleted only when its labels prove the plugin
 * created it for that name; the namespace and anything holding data are never
 * touched.
 */

const VALID = readFileSync(resolve(__dirname, 'fixtures/kubeconfig-valid.yml'), 'utf-8');
const NS = 'ever-works-tenants-user-1';
const SLUG = 'awesome-memes-website';

type Live = { metadata?: { labels?: Record<string, string> } } | null;

function ownedLabels(slug = SLUG, workId = slug): Record<string, string> {
	return {
		'ever-works.io/managed': 'true',
		'ever-works.io/work-id': workId,
		'app.kubernetes.io/name': slug,
		'app.kubernetes.io/managed-by': 'ever-works-k8s-plugin'
	};
}

/** A cluster of objects keyed `Kind/name`; reads answer them, deletes record the call. */
function makeApi(objects: Record<string, Live>, overrides: Partial<Record<string, unknown>> = {}) {
	const readObject = vi.fn(
		async (_kc: string, _apiVersion: string, kind: string, _ns: string, name: string) =>
			objects[`${kind}/${name}`] ?? null
	);
	const deleteObject = vi.fn(
		async (
			_kc: string,
			_apiVersion: string,
			_kind: string,
			_ns: string,
			_name: string,
			_propagationPolicy?: string,
			_context?: string
		): Promise<void> => undefined
	);
	const api = { readObject, deleteObject, ...overrides } as unknown as KubernetesApiService;
	return { api, readObject, deleteObject };
}

function allOwned(slug = SLUG): Record<string, Live> {
	const labels = { metadata: { labels: ownedLabels(slug) } };
	return {
		[`Ingress/${slug}`]: labels,
		[`Service/${slug}`]: labels,
		[`Deployment/${slug}`]: labels,
		[`Secret/${slug}-runtime-env`]: labels,
		[`Secret/${slug}-pull`]: labels
	};
}

const CONTEXT = {
	namespaceOverride: NS,
	projectNameOverride: SLUG,
	kubeContextOverride: null
};

describe('KubernetesPlugin.removeWorkDeployment', () => {
	it('deletes the five objects deploy() created, Ingress first, in the enforced namespace', async () => {
		const { api, deleteObject } = makeApi(allOwned());
		const plugin = new KubernetesPlugin({ api });

		const result = await plugin.removeWorkDeployment(SLUG, VALID, CONTEXT);

		expect(deleteObject.mock.calls.map((call) => [call[2], call[4]])).toEqual([
			['Ingress', SLUG],
			['Service', SLUG],
			['Deployment', SLUG],
			['Secret', `${SLUG}-runtime-env`],
			['Secret', `${SLUG}-pull`]
		]);
		for (const call of deleteObject.mock.calls) {
			// kubeconfig, apiVersion, kind, namespace, name, propagationPolicy, context
			expect(call[0]).toBe(VALID);
			expect(call[3]).toBe(NS);
			expect(call[5]).toBe('Background');
			expect(call[6]).toBeUndefined();
		}
		expect(result).toEqual({
			location: NS,
			removed: [
				{ kind: 'Ingress', name: SLUG },
				{ kind: 'Service', name: SLUG },
				{ kind: 'Deployment', name: SLUG },
				{ kind: 'Secret', name: `${SLUG}-runtime-env` },
				{ kind: 'Secret', name: `${SLUG}-pull` }
			],
			absent: [],
			kept: [],
			failed: []
		});
	});

	it('uses the right API group for each kind', async () => {
		const { api, deleteObject } = makeApi(allOwned());
		const plugin = new KubernetesPlugin({ api });

		await plugin.removeWorkDeployment(SLUG, VALID, CONTEXT);

		expect(deleteObject.mock.calls.map((call) => `${call[1]} ${call[2]}`)).toEqual([
			'networking.k8s.io/v1 Ingress',
			'v1 Service',
			'apps/v1 Deployment',
			'v1 Secret',
			'v1 Secret'
		]);
	});

	it('never deletes a Namespace, a PersistentVolumeClaim or any other kind', async () => {
		const { api, readObject, deleteObject } = makeApi(allOwned());
		const plugin = new KubernetesPlugin({ api });

		await plugin.removeWorkDeployment(SLUG, VALID, CONTEXT);

		const kinds = new Set([...readObject.mock.calls, ...deleteObject.mock.calls].map((call) => call[2]));
		expect([...kinds].sort()).toEqual(['Deployment', 'Ingress', 'Secret', 'Service']);
	});

	it('is idempotent: objects already gone are reported absent and nothing is deleted', async () => {
		const { api, deleteObject } = makeApi({});
		const plugin = new KubernetesPlugin({ api });

		const result = await plugin.removeWorkDeployment(SLUG, VALID, CONTEXT);

		expect(deleteObject).not.toHaveBeenCalled();
		expect(result.removed).toEqual([]);
		expect(result.absent.map((o) => `${o.kind}/${o.name}`)).toEqual([
			`Ingress/${SLUG}`,
			`Service/${SLUG}`,
			`Deployment/${SLUG}`,
			`Secret/${SLUG}-runtime-env`,
			`Secret/${SLUG}-pull`
		]);
	});

	it.each<[string, Record<string, string> | undefined, string]>([
		['no labels at all', undefined, 'no_labels'],
		['not marked managed', { ...ownedLabels(), 'ever-works.io/managed': 'false' }, 'not_managed'],
		[
			'another field manager (ArgoCD, by hand)',
			{ ...ownedLabels(), 'app.kubernetes.io/managed-by': 'argocd' },
			'other_manager'
		],
		['another app name', { ...ownedLabels(), 'app.kubernetes.io/name': 'web' }, 'other_name'],
		['another Work id', { ...ownedLabels(), 'ever-works.io/work-id': 'a-different-website' }, 'other_work']
	])('keeps an object under the name that is not provably this Work’s (%s)', async (_label, labels, reason) => {
		const objects = allOwned();
		objects[`Ingress/${SLUG}`] = { metadata: { labels } };
		const { api, deleteObject } = makeApi(objects);
		const plugin = new KubernetesPlugin({ api });

		const result = await plugin.removeWorkDeployment(SLUG, VALID, CONTEXT);

		expect(result.kept).toEqual([{ kind: 'Ingress', name: SLUG, reason }]);
		expect(deleteObject.mock.calls.some((call) => call[2] === 'Ingress')).toBe(false);
		// The rest is still this Work's and still goes.
		expect(result.removed).toHaveLength(4);
	});

	it('accepts the unsanitised project name deploy() stamps in the work-id label', async () => {
		const objects = allOwned();
		objects[`Ingress/${SLUG}`] = { metadata: { labels: ownedLabels(SLUG, 'Awesome_Memes-Website') } };
		const { api } = makeApi(objects);
		const plugin = new KubernetesPlugin({ api });

		const result = await plugin.removeWorkDeployment('Awesome_Memes-Website', VALID, {
			namespaceOverride: NS,
			projectNameOverride: 'Awesome_Memes-Website'
		});

		expect(result.kept).toEqual([]);
		expect(result.removed[0]).toEqual({ kind: 'Ingress', name: SLUG });
	});

	it('keeps going after one failure, so a failed Service delete cannot leave the Deployment behind', async () => {
		const { api, deleteObject } = makeApi(allOwned());
		deleteObject.mockImplementation(async (_kc, _v, kind) => {
			if (kind === 'Service') throw new K8sPluginError('APPLY_FAILED', 'services is forbidden');
		});
		const plugin = new KubernetesPlugin({ api });

		const result = await plugin.removeWorkDeployment(SLUG, VALID, CONTEXT);

		expect(result.failed).toEqual([{ kind: 'Service', name: SLUG, error: 'services is forbidden' }]);
		expect(result.removed.map((o) => o.kind)).toEqual(['Ingress', 'Deployment', 'Secret', 'Secret']);
	});

	it('reports a failed read as failed, without deleting that object', async () => {
		const { api, readObject, deleteObject } = makeApi(allOwned());
		readObject.mockImplementation(async (_kc, _v, kind: string, _ns, name: string) => {
			if (kind === 'Ingress') throw new K8sPluginError('UNAUTHORIZED', 'Kubernetes credentials were rejected.');
			return allOwned()[`${kind}/${name}`] ?? null;
		});
		const plugin = new KubernetesPlugin({ api });

		const result = await plugin.removeWorkDeployment(SLUG, VALID, CONTEXT);

		expect(result.failed).toEqual([
			{ kind: 'Ingress', name: SLUG, error: 'Kubernetes credentials were rejected.' }
		]);
		expect(deleteObject.mock.calls.some((call) => call[2] === 'Ingress')).toBe(false);
	});

	it('scrubs the kubeconfig out of a failure message', async () => {
		const { api, deleteObject } = makeApi(allOwned());
		deleteObject.mockImplementation(async () => {
			throw new Error(`request failed with config ${VALID}`);
		});
		const plugin = new KubernetesPlugin({ api });

		const result = await plugin.removeWorkDeployment(SLUG, VALID, CONTEXT);

		for (const failure of result.failed) {
			expect(failure.error).not.toContain(VALID.trim());
		}
	});

	it('names the objects after the authoritative project name, not a stale positional one', async () => {
		const { api, readObject } = makeApi({});
		const plugin = new KubernetesPlugin({ api });

		await plugin.removeWorkDeployment('stale-sibling-repo', VALID, CONTEXT);

		expect(readObject.mock.calls.map((call) => call[4])).toEqual([
			SLUG,
			SLUG,
			SLUG,
			`${SLUG}-runtime-env`,
			`${SLUG}-pull`
		]);
	});

	it('refuses an invalid namespace override instead of guessing a namespace', async () => {
		const { api, readObject } = makeApi(allOwned());
		const plugin = new KubernetesPlugin({ api });

		await expect(
			plugin.removeWorkDeployment(SLUG, VALID, { namespaceOverride: '../kube-system' })
		).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
		expect(readObject).not.toHaveBeenCalled();
	});

	it('refuses an empty project name', async () => {
		const { api, readObject } = makeApi(allOwned());
		const plugin = new KubernetesPlugin({ api });

		await expect(plugin.removeWorkDeployment('---', VALID, { namespaceOverride: NS })).rejects.toMatchObject({
			code: 'NOT_CONFIGURED'
		});
		expect(readObject).not.toHaveBeenCalled();
	});
});
