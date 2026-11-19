/**
 * Resolves a tagged image reference (`ghcr.io/owner/name:prod`) to the digest the tag points at
 * now, through the Docker Registry v2 token flow GHCR uses: a pull-scoped bearer token from
 * `/token`, then `HEAD /v2/<name>/manifests/<tag>` for `Docker-Content-Digest`.
 *
 * A site Deployment pinned to that digest can run with `imagePullPolicy: IfNotPresent`: a
 * restart (an OOM kill, a liveness failure) starts from the image already on the node instead of
 * pulling the mutable tag again, which failed for whole sites when the cluster could not reach
 * GHCR (timetrack.ever.works, 2026-11-18). A new deploy resolves the tag again and changes the
 * image field, which rolls the pods.
 *
 * Any failure (network, auth, an unexpected answer) returns `null`; callers keep the tag.
 */
export type ImageDigestResolver = (
	image: string,
	credentials?: { username: string; password: string }
) => Promise<string | null>;

const IMAGE_REF = /^([a-z0-9.-]+(?::\d+)?)\/([a-z0-9._/-]+):([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MANIFEST_TYPES = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json'
].join(', ');

export function createImageDigestResolver(
	fetchImpl: typeof fetch = fetch,
	timeoutMs = 10_000
): ImageDigestResolver {
	return async (image, credentials) => {
		const match = IMAGE_REF.exec(image);
		if (!match) return null;
		const [, host, name, tag] = match;
		try {
			const tokenHeaders: Record<string, string> = {};
			if (credentials?.password) {
				const basic = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
				tokenHeaders.Authorization = `Basic ${basic}`;
			}
			const scope = encodeURIComponent(`repository:${name}:pull`);
			const tokenResponse = await fetchImpl(
				`https://${host}/token?scope=${scope}&service=${encodeURIComponent(host)}`,
				{ headers: tokenHeaders, signal: AbortSignal.timeout(timeoutMs) }
			);
			if (!tokenResponse.ok) return null;
			const body = (await tokenResponse.json()) as { token?: unknown };
			if (typeof body.token !== 'string' || !body.token) return null;

			const manifest = await fetchImpl(`https://${host}/v2/${name}/manifests/${tag}`, {
				method: 'HEAD',
				headers: { Authorization: `Bearer ${body.token}`, Accept: MANIFEST_TYPES },
				signal: AbortSignal.timeout(timeoutMs)
			});
			if (!manifest.ok) return null;
			const digest = manifest.headers.get('docker-content-digest');
			return digest && DIGEST.test(digest) ? digest : null;
		} catch {
			return null;
		}
	};
}

export const resolveImageDigest: ImageDigestResolver = createImageDigestResolver();
