import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginContext } from '@ever-works/plugin';
import { KubernetesPlugin } from '../k8s.plugin';
import type { KubernetesApiService } from '../k8s-api.service';

/**
 * The Work and environment labels a website deploy stamps on every object it writes
 * (`ever-works.io/work-uuid`, `ever-works.io/environment`), and what the Work-delete
 * teardown does with them.
 *
 * Dev, stage and prod share one cluster and one credential, and two Works can deploy the
 * same website repository, so the repository-name labels alone cannot say whose an object
 * is. The new labels only make the teardown stricter: an object they name for another Work
 * or another environment is kept; an object without them (deployed before they existed) is
 * judged exactly as before. The selectors never change: a Deployment's is immutable, and
 * a Service whose selector changed would orphan the pods.
 */

const VALID = readFileSync(resolve(__dirname, 'fixtures/kubeconfig-valid.yml'), 'utf-8');
const WORK_UUID = '0b6f3c2e-5d1a-4c3b-9f7e-2a1d4c5b6e7f';
const OTHER_UUID = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';
const SLUG = 'awesome-memes-website';
const NS = 'ever-works-tenants-user-1';

const WORK_UUID_LABEL = 'ever-works.io/work-uuid';
const ENVIRONMENT_LABEL = 'ever-works.io/environment';

function createMockContext(settings: Record<string, unknown> = {}): PluginContext {
	return {
		pluginId: 'k8s',
		logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
		cache: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), clear: vi.fn() } as unknown as PluginContext['cache'],
		http: {} as PluginContext['http'],
		env: {} as PluginContext['env'],
		envVars: {} as PluginContext['envVars'],
		services: {} as PluginContext['services'],
		getSettings: vi.fn().mockResolvedValue(settings),
		getResolvedSettings: vi.fn(),
		updateSettings: vi.fn(),
		onEvent: vi.fn(),
		emitEvent: vi.fn(),
		registerCustomCapability: vi.fn(),
		getCustomCapability: vi.fn()
	} as unknown as PluginContext;
}

function makeDeployApi() {
	return {
		listIngressClasses: vi.fn(async () => [
			{ name: 'nginx', controller: 'k8s.io/ingress-nginx', isDefault: true, hasStrategy: true }
		]),
		getDeployment: vi.fn(async () => null),
		applyDeployment: vi.fn(async (_kubeconfig: string, _body: unknown, _context?: string) => undefined),
		applyService: vi.fn(async (_kubeconfig: string, _body: unknown, _context?: string) => undefined),
		applyIngress: vi.fn(async (_kubeconfig: string, _body: unknown, _context?: string) => undefined),
		applyImagePullSecret: vi.fn(async (_kubeconfig: string, _body: unknown, _context?: string) => undefined),
		applySecret: vi.fn(async (_kubeconfig: string, _body: unknown, _context?: string) => undefined),
		ensureNamespace: vi.fn(async () => undefined),
		readIngress: vi.fn(async (..._args: unknown[]): Promise<unknown> => null)
	};
}

type DeployApi = ReturnType<typeof makeDeployApi>;

/** The body each of the five writes applied. */
function written(api: DeployApi) {
	return {
		pullSecret: api.applyImagePullSecret.mock.calls[0]?.[1] as any,
		runtimeEnvSecret: api.applySecret.mock.calls[0]?.[1] as any,
		deployment: api.applyDeployment.mock.calls[0]?.[1] as any,
		service: api.applyService.mock.calls[0]?.[1] as any,
		ingress: api.applyIngress.mock.calls[0]?.[1] as any
	};
}

async function deployWith(options: Record<string, unknown>) {
	const api = makeDeployApi();
	const plugin = new KubernetesPlugin({ api: api as unknown as KubernetesApiService });
	await plugin.onLoad(
		createMockContext({
			kubeconfig: VALID,
			namespace: NS,
			ingressHost: 'memes.ever.works',
			ingressClass: 'nginx',
			// A private image, so the pull Secret is written too.
			registry: { kind: 'github', visibility: 'private' }
		})
	);
	const result = await plugin.deploy(
		{
			projectName: SLUG,
			sourceDir: '.',
			options: {
				gitSha: 'abc1234',
				githubOwner: 'acme',
				githubReadPackagesToken: 'ghp_read_packages',
				runtimeEnv: { AUTH_SECRET: 's3cret' },
				revision: 'rev-1',
				...options
			}
		},
		VALID
	);
	return { api, result };
}

describe('deploy() labels every object with the Work and the environment', () => {
	it('writes both labels on all five objects and on the pod template, and leaves every selector as it was', async () => {
		const { api, result } = await deployWith({ workUuid: WORK_UUID, environment: 'stage' });

		expect(result.status).toBe('deploying');
		const objects = written(api);
		// The exact selectors, beside the new labels: a Deployment's selector is immutable, and a
		// Service with another selector orphans the pods.
		expect(objects.deployment.spec.selector).toEqual({ matchLabels: { 'app.kubernetes.io/name': SLUG } });
		expect(objects.service.spec.selector).toEqual({ 'app.kubernetes.io/name': SLUG });
		for (const [kind, body] of Object.entries(objects)) {
			expect({ kind, labels: body?.metadata?.labels }).toMatchObject({
				kind,
				labels: {
					[WORK_UUID_LABEL]: WORK_UUID,
					[ENVIRONMENT_LABEL]: 'stage',
					// The labels the teardown already relies on stay as they were.
					'ever-works.io/managed': 'true',
					'ever-works.io/work-id': SLUG,
					'app.kubernetes.io/name': SLUG,
					'app.kubernetes.io/managed-by': 'ever-works-k8s-plugin'
				}
			});
		}
		expect(objects.deployment.spec.template.metadata.labels).toMatchObject({
			[WORK_UUID_LABEL]: WORK_UUID,
			[ENVIRONMENT_LABEL]: 'stage'
		});
	});

	it('never changes a selector: the Deployment and the Service still select on the app name alone', async () => {
		const { api } = await deployWith({ workUuid: WORK_UUID, environment: 'stage' });

		const { deployment, service } = written(api);
		// A Deployment's selector is immutable; a Service with another selector orphans the pods.
		expect(deployment.spec.selector).toEqual({ matchLabels: { 'app.kubernetes.io/name': SLUG } });
		expect(service.spec.selector).toEqual({ 'app.kubernetes.io/name': SLUG });
		expect(deployment.spec.template.spec.topologySpreadConstraints[0].labelSelector).toEqual({
			matchLabels: { 'app.kubernetes.io/name': SLUG }
		});
		// The pods still match the selector they had.
		expect(deployment.spec.template.metadata.labels).toMatchObject({ 'app.kubernetes.io/name': SLUG });
	});

	it('writes neither label when the caller gives no Work id or environment (an older caller)', async () => {
		const { api } = await deployWith({});

		for (const body of Object.values(written(api))) {
			expect(body.metadata.labels).not.toHaveProperty(WORK_UUID_LABEL);
			expect(body.metadata.labels).not.toHaveProperty(ENVIRONMENT_LABEL);
		}
	});

	it('leaves out a value Kubernetes would refuse as a label value, rather than failing the deploy', async () => {
		const tooLong = await deployWith({ workUuid: WORK_UUID, environment: 'x'.repeat(64) });
		const notALabel = await deployWith({ workUuid: 'not a uuid!', environment: 'dev' });

		expect(tooLong.result.status).toBe('deploying');
		expect(notALabel.result.status).toBe('deploying');
		for (const body of Object.values(written(tooLong.api))) {
			expect(body.metadata.labels[WORK_UUID_LABEL]).toBe(WORK_UUID);
			expect(body.metadata.labels).not.toHaveProperty(ENVIRONMENT_LABEL);
		}
		for (const body of Object.values(written(notALabel.api))) {
			expect(body.metadata.labels).not.toHaveProperty(WORK_UUID_LABEL);
			expect(body.metadata.labels[ENVIRONMENT_LABEL]).toBe('dev');
		}
	});
});

describe('a custom-domain change keeps the Work and environment labels', () => {
	const deployLabels = {
		'ever-works.io/managed': 'true',
		'ever-works.io/work-id': SLUG,
		'app.kubernetes.io/name': SLUG,
		'app.kubernetes.io/managed-by': 'ever-works-k8s-plugin',
		[WORK_UUID_LABEL]: WORK_UUID,
		[ENVIRONMENT_LABEL]: 'prod'
	};

	it.each(['addDomain', 'removeDomain'] as const)(
		'%s re-applies both labels from the live Ingress',
		async (method) => {
			const api = makeDeployApi();
			api.readIngress.mockResolvedValue({
				metadata: { name: SLUG, labels: deployLabels },
				spec: {
					ingressClassName: 'nginx',
					rules: [{ host: 'memes.ever.works' }, { host: 'tools.example.com' }],
					tls: []
				}
			} as never);
			const plugin = new KubernetesPlugin({ api: api as unknown as KubernetesApiService });
			await plugin.onLoad(createMockContext({}));

			await (plugin as any)[method](
				`${NS}/${SLUG}`,
				method === 'addDomain' ? 'new.example.com' : 'tools.example.com',
				VALID,
				undefined,
				{ namespaceOverride: NS, projectNameOverride: SLUG, settingsOverride: { ingressClass: 'nginx' } }
			);

			const body = api.applyIngress.mock.calls[0]?.[1] as { metadata: { labels?: Record<string, string> } };
			expect(body.metadata.labels).toEqual(deployLabels);
		}
	);
});

type Live = { metadata?: { labels?: Record<string, string>; uid?: string } } | null;

function legacyLabels(): Record<string, string> {
	return {
		'ever-works.io/managed': 'true',
		'ever-works.io/work-id': SLUG,
		'app.kubernetes.io/name': SLUG,
		'app.kubernetes.io/managed-by': 'ever-works-k8s-plugin'
	};
}

function labelled(extra: Record<string, string>): Live {
	return { metadata: { labels: { ...legacyLabels(), ...extra } } };
}

function cluster(ingress: Live, rest: Live = labelled({ [WORK_UUID_LABEL]: WORK_UUID, [ENVIRONMENT_LABEL]: 'prod' })) {
	const objects: Record<string, Live> = {
		[`Ingress/${SLUG}`]: ingress,
		[`Service/${SLUG}`]: rest,
		[`Deployment/${SLUG}`]: rest,
		[`Secret/${SLUG}-runtime-env`]: rest,
		[`Secret/${SLUG}-pull`]: rest
	};
	const readObject = vi.fn(
		async (_kc: string, _apiVersion: string, kind: string, _ns: string, name: string) =>
			objects[`${kind}/${name}`] ?? null
	);
	const deleteObject = vi.fn(async (..._args: unknown[]): Promise<void> => undefined);
	const api = { readObject, deleteObject } as unknown as KubernetesApiService;
	return { plugin: new KubernetesPlugin({ api }), deleteObject };
}

const TEARDOWN_CONTEXT = {
	namespaceOverride: NS,
	projectNameOverride: SLUG,
	kubeContextOverride: null,
	workUuid: WORK_UUID,
	environment: 'prod'
};

describe('removeWorkDeployment() with the Work and environment labels', () => {
	it('removes an object whose labels name this Work and this environment', async () => {
		const { plugin, deleteObject } = cluster(
			labelled({ [WORK_UUID_LABEL]: WORK_UUID, [ENVIRONMENT_LABEL]: 'prod' })
		);

		const result = await plugin.removeWorkDeployment(SLUG, VALID, TEARDOWN_CONTEXT);

		expect(result.kept).toEqual([]);
		expect(result.removed).toHaveLength(5);
		expect(deleteObject.mock.calls.some((call) => call[2] === 'Ingress')).toBe(true);
	});

	it('keeps an object another Work deployed under the same name', async () => {
		const { plugin, deleteObject } = cluster(
			labelled({ [WORK_UUID_LABEL]: OTHER_UUID, [ENVIRONMENT_LABEL]: 'prod' })
		);

		const result = await plugin.removeWorkDeployment(SLUG, VALID, TEARDOWN_CONTEXT);

		expect(result.kept).toEqual([{ kind: 'Ingress', name: SLUG, reason: 'other_work_uuid' }]);
		expect(deleteObject.mock.calls.some((call) => call[2] === 'Ingress')).toBe(false);
		expect(result.removed).toHaveLength(4);
	});

	it('keeps an object another environment deployed (dev, stage and prod share the cluster)', async () => {
		const { plugin, deleteObject } = cluster(
			labelled({ [WORK_UUID_LABEL]: WORK_UUID, [ENVIRONMENT_LABEL]: 'dev' })
		);

		const result = await plugin.removeWorkDeployment(SLUG, VALID, TEARDOWN_CONTEXT);

		expect(result.kept).toEqual([{ kind: 'Ingress', name: SLUG, reason: 'other_environment' }]);
		expect(deleteObject.mock.calls.some((call) => call[2] === 'Ingress')).toBe(false);
	});

	it('keeps an object labelled for another environment even when it names no Work', async () => {
		const { plugin } = cluster(labelled({ [ENVIRONMENT_LABEL]: 'stage' }));

		const result = await plugin.removeWorkDeployment(SLUG, VALID, TEARDOWN_CONTEXT);

		expect(result.kept).toEqual([{ kind: 'Ingress', name: SLUG, reason: 'other_environment' }]);
	});

	it('judges a legacy object without the new labels exactly as before: removed when the old labels match', async () => {
		const { plugin } = cluster(labelled({}), labelled({}));

		const result = await plugin.removeWorkDeployment(SLUG, VALID, TEARDOWN_CONTEXT);

		expect(result.kept).toEqual([]);
		expect(result.removed).toHaveLength(5);
	});

	it('judges a legacy object without the new labels exactly as before: kept when the old labels do not match', async () => {
		const { plugin } = cluster({
			metadata: { labels: { ...legacyLabels(), 'ever-works.io/work-id': 'other-website' } }
		});

		const result = await plugin.removeWorkDeployment(SLUG, VALID, TEARDOWN_CONTEXT);

		// The old reason, not a new one: the old labels are still checked first.
		expect(result.kept).toEqual([{ kind: 'Ingress', name: SLUG, reason: 'other_work' }]);
	});

	it('keeps a labelled object when the caller cannot say which Work or environment it is deleting', async () => {
		const { plugin } = cluster(
			labelled({ [WORK_UUID_LABEL]: WORK_UUID, [ENVIRONMENT_LABEL]: 'prod' }),
			labelled({})
		);

		const result = await plugin.removeWorkDeployment(SLUG, VALID, {
			namespaceOverride: NS,
			projectNameOverride: SLUG
		});

		expect(result.kept).toEqual([{ kind: 'Ingress', name: SLUG, reason: 'work_uuid_unverified' }]);
		// The legacy objects are judged as before.
		expect(result.removed).toHaveLength(4);
	});
});

describe('listWorkDeployments() names the environment an Ingress was deployed from', () => {
	let listManagedIngresses: ReturnType<typeof vi.fn>;
	let plugin: KubernetesPlugin;

	beforeEach(() => {
		listManagedIngresses = vi.fn(async () => [
			{ name: SLUG, namespace: NS, labels: { ...legacyLabels(), [ENVIRONMENT_LABEL]: 'dev' } },
			{
				name: 'legacy-website',
				namespace: NS,
				labels: {
					...legacyLabels(),
					'ever-works.io/work-id': 'legacy-website',
					'app.kubernetes.io/name': 'legacy-website'
				}
			}
		]);
		plugin = new KubernetesPlugin({ api: { listManagedIngresses } as unknown as KubernetesApiService });
	});

	it('adds the environment label when there is one, and nothing when there is not', async () => {
		const refs = await plugin.listWorkDeployments(VALID);

		expect(refs).toEqual([
			{ location: NS, name: SLUG, environment: 'dev' },
			{ location: NS, name: 'legacy-website' }
		]);
		expect(refs[1]).not.toHaveProperty('environment');
	});
});
