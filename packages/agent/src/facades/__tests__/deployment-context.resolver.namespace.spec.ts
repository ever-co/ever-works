import { Logger } from '@nestjs/common';
import {
    DeploymentContextResolutionError,
    deriveK8sWorksNamespace,
    isReservedDeployNamespace,
    resolveEffectiveDeploymentContext,
    resolveKubernetesDeployNamespace,
    type EffectiveDeploymentContextInput,
} from '../deployment-context.resolver';

/**
 * `resolveKubernetesDeployNamespace` is the namespace rule of
 * `resolveEffectiveDeploymentContext`, extracted so the Work-delete teardown can
 * answer it for another Work without holding that Work's kubeconfig. Each case
 * pins the expected namespace AND that the full resolver still answers the same
 * one, so the deploy path cannot drift from the teardown's sharer check.
 */

const ENV = {
    EVER_WORKS_K8S_WORKS_KUBECONFIG: 'internal',
    EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG: 'shared',
};

function input(
    overrides: Partial<EffectiveDeploymentContextInput> = {},
): EffectiveDeploymentContextInput {
    return {
        deployProvider: 'k8s',
        pluginId: 'k8s',
        resolvedToken: 'member-kubeconfig',
        settings: {},
        websiteOwner: 'ever-works',
        websiteProjectName: 'awesome-memes-website',
        workId: 'work-1',
        workSlug: 'awesome-memes',
        ownerUserId: 'user-1',
        isPlatformAdmin: true,
        env: ENV as NodeJS.ProcessEnv,
        ...overrides,
    };
}

describe('resolveKubernetesDeployNamespace', () => {
    it.each<[string, Partial<EffectiveDeploymentContextInput>, string | undefined]>([
        [
            'the managed ever-works provider: the tenant namespace',
            { deployProvider: 'ever-works' },
            'ever-works-tenants-user-1',
        ],
        [
            'k8s-works-shared: the tenant namespace',
            { settings: { clusterSource: 'k8s-works-shared' } },
            'ever-works-tenants-user-1',
        ],
        [
            'the tenant base from EVER_WORKS_DEPLOY_NAMESPACE',
            {
                deployProvider: 'ever-works',
                env: { ...ENV, EVER_WORKS_DEPLOY_NAMESPACE: 'ew-t' } as NodeJS.ProcessEnv,
            },
            'ew-t-user-1',
        ],
        [
            'no owner: the tenant falls back to the Work id',
            { deployProvider: 'ever-works', ownerUserId: null },
            'ever-works-tenants-work-1',
        ],
        [
            'k8s-works: derived from the slug',
            { settings: { clusterSource: 'k8s-works' } },
            'ever-works-awesome-memes-prod',
        ],
        [
            'k8s-works with an explicit namespace: that namespace',
            { settings: { clusterSource: 'k8s-works', namespace: 'my-ns' } },
            'my-ns',
        ],
        [
            'k8s-works with a schema-default namespace: still derived from the slug',
            {
                settings: { clusterSource: 'k8s-works', namespace: 'ever-works' },
                settingSources: { namespace: 'default' },
            },
            'ever-works-awesome-memes-prod',
        ],
        [
            'a member cluster with the schema default: kept for BYOC',
            {
                // A member cluster is refused for a repository in an Ever Works org.
                websiteOwner: 'acme',
                settings: { clusterSource: 'custom-kubeconfig', namespace: 'ever-works' },
                settingSources: { namespace: 'default' },
            },
            'ever-works',
        ],
        [
            'a member cluster with no namespace: the plugin setting applies',
            { websiteOwner: 'acme', settings: { clusterSource: 'custom-kubeconfig' } },
            undefined,
        ],
    ])('%s', (_label, overrides, expected) => {
        const value = input(overrides);

        expect(resolveKubernetesDeployNamespace(value)).toBe(expected);
        expect(resolveEffectiveDeploymentContext(value).namespace).toBe(expected);
    });

    it('throws RESERVED_NAMESPACE for an explicit reserved namespace, exactly like the full resolver', () => {
        const value = input({ settings: { clusterSource: 'k8s-works', namespace: 'kube-system' } });

        const fromRule = (() => {
            try {
                resolveKubernetesDeployNamespace(value);
            } catch (error) {
                return error;
            }
            return null;
        })();
        expect(fromRule).toBeInstanceOf(DeploymentContextResolutionError);
        expect((fromRule as DeploymentContextResolutionError).code).toBe('RESERVED_NAMESPACE');
        expect(() => resolveEffectiveDeploymentContext(value)).toThrow(
            expect.objectContaining({ code: 'RESERVED_NAMESPACE' }),
        );
    });

    it('needs no kubeconfig: a Work whose credential is not held still gets its namespace', () => {
        expect(
            resolveKubernetesDeployNamespace(
                input({ resolvedToken: '', settings: { clusterSource: 'k8s-works' } }),
            ),
        ).toBe('ever-works-awesome-memes-prod');
    });
});

/**
 * dev, stage and prod deploy `k8s-works` Works to one cluster with one credential.
 * `EVER_WORKS_K8S_WORKS_NAMESPACE_SUFFIX` is the last label of the slug-derived
 * namespace, so each environment gets its own (`ever-works-<slug>-<suffix>`). Unset,
 * it is `prod`: prod's existing namespaces stay exactly what they are.
 */
describe('deriveK8sWorksNamespace (EVER_WORKS_K8S_WORKS_NAMESPACE_SUFFIX)', () => {
    const SUFFIX_ENV = 'EVER_WORKS_K8S_WORKS_NAMESPACE_SUFFIX';
    /** 49 characters: the namespace keeps the first 40. */
    const LONG_SLUG = 'awesome-time-tracking-tools-for-remote-teams-2026';
    /** RFC 1123 label: what Kubernetes accepts as a namespace name. */
    const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

    let warn: jest.SpyInstance;

    beforeEach(() => {
        warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        warn.mockRestore();
    });

    function withSuffix(suffix: string | undefined): NodeJS.ProcessEnv {
        const env: Record<string, string> = { ...ENV };
        if (suffix !== undefined) env[SUFFIX_ENV] = suffix;
        return env as NodeJS.ProcessEnv;
    }

    function k8sWorks(
        suffix: string | undefined,
        overrides: Partial<EffectiveDeploymentContextInput> = {},
    ): EffectiveDeploymentContextInput {
        return input({
            settings: { clusterSource: 'k8s-works' },
            env: withSuffix(suffix),
            ...overrides,
        });
    }

    it('unset: ever-works-<slug>-prod, with the slug cut at 40 characters exactly as before', () => {
        const expected = 'ever-works-awesome-time-tracking-tools-for-remote-t-prod';
        const value = k8sWorks(undefined, { workSlug: LONG_SLUG });

        expect(deriveK8sWorksNamespace(LONG_SLUG, withSuffix(undefined))).toBe(expected);
        expect(resolveKubernetesDeployNamespace(value)).toBe(expected);
        const effective = resolveEffectiveDeploymentContext(value);
        expect(effective.namespace).toBe(expected);
        expect(effective.settings.namespace).toBe(expected);
        expect(effective.lookupContext?.namespaceOverride).toBe(expected);
        expect(warn).not.toHaveBeenCalled();
    });

    it('`prod` set explicitly gives the same namespace as unset', () => {
        expect(deriveK8sWorksNamespace(LONG_SLUG, withSuffix('prod'))).toBe(
            deriveK8sWorksNamespace(LONG_SLUG, withSuffix(undefined)),
        );
        expect(warn).not.toHaveBeenCalled();
    });

    it.each([
        ['stage', 'ever-works-awesome-memes-stage'],
        ['dev', 'ever-works-awesome-memes-dev'],
        // Trimmed and lowercased before it is checked.
        ['  Stage ', 'ever-works-awesome-memes-stage'],
    ])('%j gives %s, on the deploy path too', (suffix, expected) => {
        const value = k8sWorks(suffix);

        expect(deriveK8sWorksNamespace('awesome-memes', withSuffix(suffix))).toBe(expected);
        expect(resolveKubernetesDeployNamespace(value)).toBe(expected);
        const effective = resolveEffectiveDeploymentContext(value);
        expect(effective.namespace).toBe(expected);
        expect(effective.settings.namespace).toBe(expected);
        expect(effective.lookupContext?.namespaceOverride).toBe(expected);
        expect(warn).not.toHaveBeenCalled();
    });

    it('stage keeps the 40-character slug cut', () => {
        expect(deriveK8sWorksNamespace(LONG_SLUG, withSuffix('stage'))).toBe(
            'ever-works-awesome-time-tracking-tools-for-remote-t-stage',
        );
    });

    it.each([
        // Up to 11 characters the slug keeps its 40; past that it gives way.
        ['abcdefghijk', 'ever-works-awesome-time-tracking-tools-for-remote-t-abcdefghijk'],
        ['abcdefghijkl', 'ever-works-awesome-time-tracking-tools-for-remote--abcdefghijkl'],
        ['preview-12345678', 'ever-works-awesome-time-tracking-tools-for-rem-preview-12345678'],
    ])('a long suffix (%s) keeps the name within 63 characters and valid', (suffix, expected) => {
        const namespace = deriveK8sWorksNamespace(LONG_SLUG, withSuffix(suffix));

        expect(namespace).toBe(expected);
        expect(namespace!.length).toBeLessThanOrEqual(63);
        expect(namespace).toMatch(DNS_1123_LABEL);
        expect(namespace!.endsWith(`-${suffix}`)).toBe(true);
    });

    it('every valid suffix length (1 to 16) stays within 63 characters and valid', () => {
        for (let length = 1; length <= 16; length += 1) {
            const suffix = 's'.repeat(length);
            const namespace = deriveK8sWorksNamespace(LONG_SLUG, withSuffix(suffix));
            expect(namespace!.length).toBeLessThanOrEqual(63);
            expect(namespace).toMatch(DNS_1123_LABEL);
            expect(namespace!.endsWith(`-${suffix}`)).toBe(true);
        }
        expect(warn).not.toHaveBeenCalled();
    });

    it.each([
        ['an uppercase value with punctuation', 'Prod!'],
        ['a blank value', ' '],
        ['a 30-character value', 'abcdefghijklmnopqrstuvwxyz0123'],
        ['a leading dash', '-stage'],
        ['an underscore', 'my_stage'],
    ])('%s falls back to prod with one warning', (_label, suffix) => {
        const value = k8sWorks(suffix);

        expect(deriveK8sWorksNamespace('awesome-memes', withSuffix(suffix))).toBe(
            'ever-works-awesome-memes-prod',
        );
        // Every deploy and every sharer candidate resolves it; it warns once.
        expect(resolveKubernetesDeployNamespace(value)).toBe('ever-works-awesome-memes-prod');
        expect(resolveEffectiveDeploymentContext(value).namespace).toBe(
            'ever-works-awesome-memes-prod',
        );
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain(SUFFIX_ENV);
        expect(String(warn.mock.calls[0][0])).toContain('-prod');
    });

    it('still refuses an explicit reserved namespace when a suffix is set', () => {
        const value = k8sWorks('stage', {
            settings: { clusterSource: 'k8s-works', namespace: 'kube-system' },
        });

        expect(() => resolveKubernetesDeployNamespace(value)).toThrow(
            expect.objectContaining({ code: 'RESERVED_NAMESPACE' }),
        );
        expect(() => resolveEffectiveDeploymentContext(value)).toThrow(
            expect.objectContaining({ code: 'RESERVED_NAMESPACE' }),
        );
    });

    it('a slug that names a reserved namespace still derives a namespace that is not reserved', () => {
        for (const slug of ['kube-system', 'ever-works', 'default', 'argocd']) {
            const namespace = deriveK8sWorksNamespace(slug, withSuffix('stage'));
            expect(namespace).toBe(`ever-works-${slug}-stage`);
            expect(isReservedDeployNamespace(namespace!)).toBe(false);
        }
    });

    it('a slug with nothing left after cleaning derives no namespace', () => {
        expect(deriveK8sWorksNamespace('---', withSuffix('stage'))).toBeUndefined();
    });

    it('reads process.env when no env is passed, as the teardown and the orphan report do', () => {
        const saved = process.env[SUFFIX_ENV];
        try {
            process.env[SUFFIX_ENV] = 'stage';
            expect(deriveK8sWorksNamespace('awesome-memes')).toBe('ever-works-awesome-memes-stage');
            expect(
                resolveKubernetesDeployNamespace(
                    input({ settings: { clusterSource: 'k8s-works' }, env: undefined }),
                ),
            ).toBe('ever-works-awesome-memes-stage');
        } finally {
            if (saved === undefined) delete process.env[SUFFIX_ENV];
            else process.env[SUFFIX_ENV] = saved;
        }
    });
});
