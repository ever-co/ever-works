import type { IngressStrategy } from './ingress/strategy.js';
import type { ManifestRenderInputs } from './types.js';

/**
 * Field manager used by server-side apply. Editing this string is a
 * breaking change for users who SSA-conflict on hand-edited fields.
 */
export const FIELD_MANAGER = 'ever-works-k8s-plugin';

/**
 * A run-as uid / gid is only trustworthy when it is a positive integer: 0 would contradict
 * `runAsNonRoot`, and anything else would render an invalid pod spec.
 */
function nonRootId(value: number | undefined): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

const COMMON_LABELS = (workId: string, slug: string): Record<string, string> => ({
	'ever-works.io/managed': 'true',
	'ever-works.io/work-id': workId,
	'app.kubernetes.io/name': slug,
	'app.kubernetes.io/managed-by': FIELD_MANAGER
});

const SELECTOR_LABELS = (slug: string): Record<string, string> => ({
	'app.kubernetes.io/name': slug
});

/**
 * Build the Deployment manifest for a work.
 */
export function buildDeployment(input: ManifestRenderInputs): Record<string, unknown> {
	const labels = COMMON_LABELS(input.workId, input.workSlug);
	const selector = SELECTOR_LABELS(input.workSlug);

	// Every site gets the parts that are safe for a process that starts as root: no SA token,
	// RuntimeDefault seccomp and no privilege escalation (no_new_privs does not stop a root nginx
	// master's setuid to its workers). Non-root + drop ALL is a SEAM: enforced only when a caller
	// passes the image's numeric `runAsUser`, and no production caller does today. Forcing a uid
	// from what a deploy believes about an image is unsafe while the image is a MUTABLE branch alias:
	// the minimal (Astro) templates serve stock `nginx:<ver>-alpine` as root, which crash-loops under
	// a forced uid (no write to /var/cache/nginx or its pid file) or with ALL capabilities dropped (no
	// setuid to its workers), and every Work repo carries its own Dockerfile copy. Enforcing it needs
	// digest-pinned deploys plus templates with a numeric USER first.
	const runAsUser = nonRootId(input.runAsUser);
	const runAsGroup = runAsUser === undefined ? undefined : (nonRootId(input.runAsGroup) ?? runAsUser);
	const podSecurityContext: Record<string, unknown> =
		runAsUser === undefined
			? { seccompProfile: { type: 'RuntimeDefault' } }
			: { runAsNonRoot: true, runAsUser, runAsGroup, seccompProfile: { type: 'RuntimeDefault' } };
	const containerSecurityContext: Record<string, unknown> =
		runAsUser === undefined
			? { allowPrivilegeEscalation: false }
			: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } };

	const podSpec: Record<string, unknown> = {
		// Prefer spreading replicas across failure domains when the cluster has
		// them. This stays soft: older clusters do not understand
		// nodeTaintsPolicy, and a hard constraint can count an untolerated
		// control-plane as an empty domain and strand the next replica.
		topologySpreadConstraints: [
			{
				maxSkew: 1,
				topologyKey: 'kubernetes.io/hostname',
				whenUnsatisfiable: 'ScheduleAnyway',
				labelSelector: { matchLabels: selector }
			}
		],
		// A Work site never calls the Kubernetes API, so it gets no ServiceAccount token.
		automountServiceAccountToken: false,
		securityContext: podSecurityContext,
		containers: [
			{
				name: 'app',
				image: input.image,
				// The server-side path pins a MUTABLE branch alias (:dev/:stage/:prod)
				// that CI republishes, so a node with a cached layer would keep
				// serving the old build forever under IfNotPresent. Callers that
				// side-load an image (the kind-based e2e runbook) opt back out.
				imagePullPolicy: input.imagePullPolicy ?? 'Always',
				ports: [{ containerPort: input.containerPort, name: 'http' }],
				// Never privilege escalation; no capability at all when non-root is enforced (the site listens
				// on an unprivileged port). The root filesystem stays WRITABLE on purpose: the Next.js server
				// writes its cache under `.next/` at runtime (the image declares `.next/cache` a VOLUME) and
				// nginx writes /var/cache/nginx; read-only needs those paths mapped first.
				securityContext: containerSecurityContext,
				// A directory Work renders its whole catalogue on first request, so
				// the default 1s probe timeout could never pass on a large one — the
				// pod stayed 0/1 forever while the app was healthy. Readiness stays
				// comparatively tight (an unready pod must leave the Service), but it
				// gets a realistic timeout; a startupProbe absorbs the cold start so
				// liveness never kills a warming container and loses its cache.
				startupProbe: {
					// The cheap health route, not the homepage: a cold homepage renders the
					// whole catalogue, and on a busy node that render (with the template's
					// start-up content sync) outlasted the 10 s timeout for minutes, so pods
					// were restarted while only warming up (mcpserver.ever.works, Nov 2026).
					// The template warms its content in the background at start-up instead
					// (directory-web-template Spec 061 R15).
					httpGet: { path: '/api/health', port: 'http' },
					periodSeconds: 10,
					timeoutSeconds: 10,
					failureThreshold: input.startupFailureThreshold ?? 30
				},
				// A busy site (a cold catalogue read, a content sync) can hold its event loop for
				// seconds; liveness restarting it then loses its warm caches and, with a mutable
				// image tag, needs the registry to come back (timetrack.ever.works, 2026-11-18). So
				// liveness waits 30 s per check and ~5 minutes in all; readiness, which only takes a
				// pod out of the Service, stays quicker.
				readinessProbe: {
					httpGet: { path: '/api/health', port: 'http' },
					periodSeconds: 10,
					timeoutSeconds: 15,
					failureThreshold: 3
				},
				livenessProbe: {
					httpGet: { path: '/api/health', port: 'http' },
					periodSeconds: 20,
					timeoutSeconds: 30,
					failureThreshold: 15
				},
				// 512Mi OOM-killed a real catalogue — the mcp-servers Work restarted
				// 4x and never served. Measured usage of the seven live Works:
				// 441Mi / 487 / 567 / 586 / 616 / 1557, and mcp-servers at 3980Mi.
				//
				// The limit must FIT a node: requests are small enough that a pod with
				// a larger limit schedules happily and then gets OOM-killed climbing
				// toward a ceiling that does not physically exist. 2Gi was chosen when
				// the k8s-works workers had ~3.72Gi allocatable. They now have ~7Gi
				// (k8s-works-shared ~7.6Gi). On 2026-11-17 a 2Gi site OOM-looped and
				// six more were raised to 3Gi by hand, so the default is now 3Gi
				// (DEFAULT_MEMORY_LIMIT in k8s.plugin.ts). A deploy also keeps a
				// larger value it finds on the live Deployment (keepLiveCapacity).
				//
				// A 512Mi admission floor stops several roughly 500Mi processes from
				// being advertised as 256Mi pods. It is NOT a sufficiency claim for
				// sites measured in the 0.4–0.8Gi range: heavier catalogues still need
				// an explicit measured per-Work request. All four values remain
				// configurable through plugin settings.
				resources: {
					requests: {
						cpu: input.cpuRequest ?? '100m',
						// Managed deployments pass their 512Mi floor explicitly; BYOC
						// keeps this provider-neutral historical fallback.
						memory: input.memoryRequest ?? '256Mi'
					},
					limits: {
						cpu: input.cpuLimit ?? '2',
						memory: input.memoryLimit ?? '3Gi'
					}
				},
				// Server-side deploys (EW — platform-managed clusters) mount the
				// per-work runtime-env Secret the platform applied just before
				// this manifest. `optional: true` keeps the pod schedulable when
				// the Secret is absent (older works, custom clusters) — the app
				// then boots on its baked-in defaults exactly as before.
				...(input.envFromSecretName
					? {
							envFrom: [{ secretRef: { name: input.envFromSecretName, optional: true } }]
						}
					: {})
			}
		]
	};

	if (input.pullSecretName) {
		podSpec.imagePullSecrets = [{ name: input.pullSecretName }];
	}

	return {
		apiVersion: 'apps/v1',
		kind: 'Deployment',
		metadata: { name: input.workSlug, namespace: input.namespace, labels },
		spec: {
			replicas: input.replicas,
			selector: { matchLabels: selector },
			// Surge first, at every replica count: start the new pod, wait until it
			// is Ready, and only then stop an old one. The site never drops below
			// its replica count during a deploy.
			//
			// This used to be { maxSurge: 0, maxUnavailable: 1 } for one replica, to
			// avoid briefly holding two pods' memory on a 3.72Gi worker. That made
			// every deploy of a one-pod site an outage (the old pod stopped first and
			// a Next.js catalogue takes a while to warm), and the workers now have
			// ~7Gi allocatable. If the extra pod cannot be scheduled, the rollout
			// waits with the old pod still serving instead of going dark.
			strategy: {
				type: 'RollingUpdate',
				rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
			},
			template: {
				// Without a per-deploy annotation the rendered Deployment is
				// byte-identical between deploys of the same branch (the tag is a
				// fixed alias), so server-side apply produces no generation bump,
				// no new ReplicaSet and no rollout — the deploy reports success and
				// nothing changes. Re-applying the runtime-env Secret does not help
				// either: envFrom is materialised at container start.
				metadata: {
					labels: { ...selector, ...labels },
					...(input.podAnnotations && Object.keys(input.podAnnotations).length
						? { annotations: input.podAnnotations }
						: {})
				},
				spec: podSpec
			}
		}
	};
}

/**
 * Build the per-work runtime-env Secret the app container `envFrom`s.
 *
 * Server-side (platform-managed) deploys only: the platform assembles the
 * runtime environment it used to push as GitHub Actions secrets and applies
 * it directly to the target namespace instead — no cluster credential and no
 * runtime value ever lands in the website repo. `stringData` so the values
 * are written verbatim (the API server base64-encodes on persist).
 */
export function buildRuntimeEnvSecret(input: {
	name: string;
	namespace: string;
	workId: string;
	workSlug: string;
	env: Record<string, string>;
}): Record<string, unknown> {
	return {
		apiVersion: 'v1',
		kind: 'Secret',
		metadata: {
			name: input.name,
			namespace: input.namespace,
			labels: COMMON_LABELS(input.workId, input.workSlug)
		},
		type: 'Opaque',
		stringData: input.env
	};
}

/**
 * Build the Service manifest. Always ClusterIP on port 80 → containerPort.
 */
export function buildService(input: ManifestRenderInputs): Record<string, unknown> {
	const labels = COMMON_LABELS(input.workId, input.workSlug);
	const selector = SELECTOR_LABELS(input.workSlug);
	return {
		apiVersion: 'v1',
		kind: 'Service',
		metadata: { name: input.workSlug, namespace: input.namespace, labels },
		spec: {
			type: 'ClusterIP',
			selector,
			ports: [{ name: 'http', port: 80, targetPort: input.containerPort, protocol: 'TCP' }]
		}
	};
}

/**
 * Build the Ingress manifest. Returns `null` when no hosts are configured.
 */
export function buildIngress(input: ManifestRenderInputs, strategy: IngressStrategy): Record<string, unknown> | null {
	if (input.hosts.length === 0) return null;

	const labels = COMMON_LABELS(input.workId, input.workSlug);
	const annotations = strategy.annotations({
		hosts: input.hosts,
		tlsIssuer: input.tlsIssuer,
		className: input.ingressClass
	});
	const tls = strategy.tls({
		hosts: input.hosts,
		tlsIssuer: input.tlsIssuer,
		className: input.ingressClass
	});

	const spec: Record<string, unknown> = {
		ingressClassName: input.ingressClass,
		rules: input.hosts.map((host) => ({
			host,
			http: {
				paths: [
					{
						path: '/',
						pathType: 'Prefix',
						backend: {
							service: { name: input.workSlug, port: { number: 80 } }
						}
					}
				]
			}
		}))
	};

	if (tls.length > 0) {
		spec.tls = tls;
	}

	return {
		apiVersion: 'networking.k8s.io/v1',
		kind: 'Ingress',
		metadata: {
			name: input.workSlug,
			namespace: input.namespace,
			labels,
			annotations
		},
		spec
	};
}

/**
 * Build a `kubernetes.io/dockerconfigjson` Secret used as imagePullSecret.
 */
export function buildImagePullSecret(args: {
	name: string;
	namespace: string;
	server: string;
	username: string;
	password: string;
	workId: string;
	workSlug: string;
}): Record<string, unknown> {
	const auth = Buffer.from(`${args.username}:${args.password}`).toString('base64');
	const dockerConfig = {
		auths: {
			[args.server]: {
				username: args.username,
				password: args.password,
				auth
			}
		}
	};
	const dockerConfigJson = Buffer.from(JSON.stringify(dockerConfig)).toString('base64');

	return {
		apiVersion: 'v1',
		kind: 'Secret',
		type: 'kubernetes.io/dockerconfigjson',
		metadata: {
			name: args.name,
			namespace: args.namespace,
			labels: COMMON_LABELS(args.workId, args.workSlug)
		},
		data: {
			'.dockerconfigjson': dockerConfigJson
		}
	};
}

/**
 * Conventional pull-secret name for a work.
 */
export function pullSecretNameFor(workSlug: string): string {
	return `${workSlug}-pull`;
}
