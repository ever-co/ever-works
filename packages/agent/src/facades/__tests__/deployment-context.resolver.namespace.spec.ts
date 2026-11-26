import {
    DeploymentContextResolutionError,
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
