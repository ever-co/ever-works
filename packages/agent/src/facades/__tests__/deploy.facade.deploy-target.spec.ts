import { DeployFacadeService } from '../deploy.facade';

/**
 * `DeployFacadeService.refreshKubernetesDeployTarget` — the Work's cached deploy target
 * (`deployProjectId`, `namespace/name`) after a Kubernetes deploy applied its objects.
 *
 * The Work-delete teardown names a cached target that differs from the current one
 * (`staleTarget`), its sharer check treats a Work with the target cached as a sharer, and
 * the orphan report counts a cached target as accounted for. Written only once, the cache
 * named where a Work's objects first were, not where its last deploy put them.
 */

function createService() {
    const workRepository = { update: jest.fn().mockResolvedValue(undefined) };
    const service = new DeployFacadeService(
        {} as any,
        {} as any,
        workRepository as any,
        {} as any,
        {} as any,
        undefined,
        undefined,
    );
    return { service, workRepository };
}

function work(fields: { deployProvider?: string | null; deployProjectId?: string | null }) {
    return {
        id: 'work-1',
        deployProvider: fields.deployProvider === undefined ? 'ever-works' : fields.deployProvider,
        deployProjectId: fields.deployProjectId ?? null,
    } as any;
}

describe('DeployFacadeService.refreshKubernetesDeployTarget', () => {
    it.each(['ever-works', 'k8s'])(
        'stores the new namespace/name after a %s deploy to another target',
        async (provider) => {
            const { service, workRepository } = createService();
            const target = work({
                deployProvider: provider,
                deployProjectId: 'ever-works-old-prod/memes-website',
            });

            await expect(
                service.refreshKubernetesDeployTarget(
                    target,
                    'ever-works-tenants-user-1/memes-website',
                ),
            ).resolves.toBe(true);

            expect(workRepository.update).toHaveBeenCalledWith('work-1', {
                deployProjectId: 'ever-works-tenants-user-1/memes-website',
            });
            expect(target.deployProjectId).toBe('ever-works-tenants-user-1/memes-website');
        },
    );

    it('stores the first target of a Work that has none cached yet', async () => {
        const { service, workRepository } = createService();

        await service.refreshKubernetesDeployTarget(
            work({ deployProjectId: null }),
            'ever-works-tenants-user-1/memes-website',
        );

        expect(workRepository.update).toHaveBeenCalledWith('work-1', {
            deployProjectId: 'ever-works-tenants-user-1/memes-website',
        });
    });

    it('writes nothing when the target is the one already cached', async () => {
        const { service, workRepository } = createService();

        await expect(
            service.refreshKubernetesDeployTarget(
                work({ deployProjectId: 'ever-works-tenants-user-1/memes-website' }),
                'ever-works-tenants-user-1/memes-website',
            ),
        ).resolves.toBe(false);

        expect(workRepository.update).not.toHaveBeenCalled();
    });

    it('never touches another provider’s cached id', async () => {
        const { service, workRepository } = createService();

        await expect(
            service.refreshKubernetesDeployTarget(
                work({ deployProvider: 'vercel', deployProjectId: 'prj_123' }),
                'ever-works-tenants-user-1/memes-website',
            ),
        ).resolves.toBe(false);

        expect(workRepository.update).not.toHaveBeenCalled();
    });

    it.each(['', 'memes-website', 'Bad_NS/memes-website', 'ns/', 'a/b/c'])(
        'keeps the cached target when the deploy answered no namespace/name (%p)',
        async (deploymentId) => {
            const { service, workRepository } = createService();

            await expect(
                service.refreshKubernetesDeployTarget(
                    work({ deployProjectId: 'ever-works-tenants-user-1/memes-website' }),
                    deploymentId,
                ),
            ).resolves.toBe(false);

            expect(workRepository.update).not.toHaveBeenCalled();
        },
    );
});
