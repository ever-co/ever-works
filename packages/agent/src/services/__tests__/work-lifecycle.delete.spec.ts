jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));
jest.mock('@src/generators/markdown-generator/markdown-generator.service', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-generator.service', () => ({
    WebsiteGeneratorService: class WebsiteGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-update.service', () => ({
    WebsiteUpdateService: class WebsiteUpdateService {},
}));

import { BadRequestException } from '@nestjs/common';
import { WorkLifecycleService } from '../work-lifecycle.service';
import type { User } from '@src/entities/user.entity';
import type { DeleteWorkDto } from '@src/items-generator/dto';

/**
 * `WorkLifecycleService.deleteWork` — which repositories a delete may reach.
 *
 * The P1 this pins (self-build slice D, EW-766): a Repository Work's data
 * repository is the user's own code repository, and its `work` / `website`
 * roles were never provisioned — but the entity's derived fallbacks
 * (`<slug>`, `<slug>-website`) resolve to real names under the third-party
 * owner. Deleting the Work row must therefore never call the git provider's
 * delete for the kind, whatever the DTO says, and must never `rm` a local
 * checkout it did not make. Every other kind keeps today's behaviour, with
 * one refinement: a role the kind never provisions is skipped instead of
 * attempted against a repository that does not exist.
 */
const user = { id: 'owner-1', username: 'owner' } as User;

interface Mocks {
    workRepository: {
        delete: jest.Mock;
        findByManagedSubdomain: jest.Mock;
        findByDeployProvidersForUserOrSlug: jest.Mock;
    };
    dataGenerator: { removeRepository: jest.Mock; cleanup: jest.Mock };
    markdownGenerator: { removeRepository: jest.Mock; cleanup: jest.Mock };
    websiteGenerator: { removeRepository: jest.Mock; cleanup: jest.Mock };
    everWorksDns: { removeWorkSubdomain: jest.Mock };
    deployFacade: { prepareWorkDeploymentTeardown: jest.Mock };
}

function makeService(work: Record<string, unknown>): {
    service: WorkLifecycleService;
    mocks: Mocks;
} {
    const mocks: Mocks = {
        workRepository: {
            delete: jest.fn().mockResolvedValue(undefined),
            findByManagedSubdomain: jest.fn().mockResolvedValue(null),
            findByDeployProvidersForUserOrSlug: jest.fn().mockResolvedValue([]),
        },
        dataGenerator: {
            removeRepository: jest.fn().mockResolvedValue(undefined),
            cleanup: jest.fn().mockResolvedValue(undefined),
        },
        markdownGenerator: {
            removeRepository: jest.fn().mockResolvedValue(undefined),
            cleanup: jest.fn().mockResolvedValue(undefined),
        },
        websiteGenerator: {
            removeRepository: jest.fn().mockResolvedValue(undefined),
            cleanup: jest.fn().mockResolvedValue(undefined),
        },
        everWorksDns: { removeWorkSubdomain: jest.fn().mockResolvedValue(undefined) },
        deployFacade: {
            prepareWorkDeploymentTeardown: jest
                .fn()
                .mockResolvedValue({ status: 'skipped', reason: 'not_managed' }),
        },
    };
    const ownership = { ensureIsOwner: jest.fn().mockResolvedValue({ work }) };

    const service = new WorkLifecycleService(
        mocks.workRepository as never,
        {} as never,
        mocks.dataGenerator as never,
        mocks.markdownGenerator as never,
        mocks.websiteGenerator as never,
        {} as never,
        ownership as never,
        mocks.deployFacade as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        mocks.everWorksDns as never,
        {} as never,
        { emit: jest.fn(), emitAsync: jest.fn() } as never,
        {} as never,
        {} as never,
    );
    return { service, mocks };
}

/**
 * The shape `applyRepositoryWorkSource` persists for
 * `https://github.com/ever-works/ever-works`, with the slug the web form
 * derives by default — i.e. the case where `getMainRepo()`'s `<slug>`
 * fallback names the wrapped repository itself.
 */
function repositoryWork(): Record<string, unknown> {
    return {
        id: 'w-repo',
        kind: 'repo',
        name: 'Platform',
        slug: 'ever-works',
        owner: 'ever-works',
        userId: user.id,
        gitProvider: 'github',
        deployProvider: null,
        sourceRepository: {
            type: 'link_existing',
            owner: 'ever-works',
            repo: 'ever-works',
            relatedRepositories: { data: { owner: 'ever-works', repo: 'ever-works' } },
        },
        getRepoOwner: () => 'ever-works',
        getDataRepo: () => 'ever-works',
        getMainRepo: () => 'ever-works',
        getWebsiteRepo: () => 'ever-works-website',
    };
}

function directoryWork(kind = 'directory'): Record<string, unknown> {
    return {
        id: 'w-dir',
        kind,
        name: 'Best Tools',
        slug: 'best-tools',
        owner: 'acme',
        userId: user.id,
        gitProvider: 'github',
        deployProvider: 'vercel',
        getRepoOwner: () => 'acme',
        getDataRepo: () => 'best-tools-data',
        getMainRepo: () => 'best-tools',
        getWebsiteRepo: () => 'best-tools-website',
    };
}

const ALL_ON: DeleteWorkDto = {
    delete_data_repository: true,
    delete_markdown_repository: true,
    delete_website_repository: true,
};

describe('WorkLifecycleService.deleteWork — Repository Work never reaches the git provider', () => {
    it.each<[string, DeleteWorkDto]>([
        ['an empty DTO (the MCP delete_work default)', {}],
        [
            'every flag explicitly false',
            {
                ...ALL_ON,
                delete_data_repository: false,
                delete_markdown_repository: false,
                delete_website_repository: false,
            },
        ],
        [
            'the work + website flags on (data left unticked)',
            { delete_markdown_repository: true, delete_website_repository: true },
        ],
    ])(
        'deletes only the row with %s — zero removeRepository calls, zero cleanup',
        async (_label, dto) => {
            const { service, mocks } = makeService(repositoryWork());

            const result = await service.deleteWork('w-repo', dto, user);

            expect(result.status).toBe('success');
            expect(result.deleted_repositories).toEqual([]);
            expect(mocks.workRepository.delete).toHaveBeenCalledWith('w-repo');
            expect(mocks.dataGenerator.removeRepository).not.toHaveBeenCalled();
            expect(mocks.markdownGenerator.removeRepository).not.toHaveBeenCalled();
            expect(mocks.websiteGenerator.removeRepository).not.toHaveBeenCalled();
            // The shared `owner/repo` checkout is not this Work's to remove.
            expect(mocks.dataGenerator.cleanup).not.toHaveBeenCalled();
            expect(mocks.markdownGenerator.cleanup).not.toHaveBeenCalled();
            expect(mocks.websiteGenerator.cleanup).not.toHaveBeenCalled();
            // `deployProvider` is null for the kind, so no CNAME teardown either.
            expect(mocks.everWorksDns.removeWorkSubdomain).not.toHaveBeenCalled();
        },
    );

    it('refuses an EXPLICIT delete_data_repository with a 400 before deleting anything', async () => {
        const { service, mocks } = makeService(repositoryWork());

        await expect(
            service.deleteWork('w-repo', { delete_data_repository: true }, user),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(mocks.dataGenerator.removeRepository).not.toHaveBeenCalled();
        expect(mocks.markdownGenerator.removeRepository).not.toHaveBeenCalled();
        expect(mocks.websiteGenerator.removeRepository).not.toHaveBeenCalled();
        expect(mocks.workRepository.delete).not.toHaveBeenCalled();
    });

    it('names the wrapped repository in the refusal so the caller knows what was protected', async () => {
        const { service } = makeService(repositoryWork());

        await expect(
            service.deleteWork('w-repo', { delete_data_repository: true }, user),
        ).rejects.toMatchObject({
            response: expect.objectContaining({
                message: expect.stringMatching(/is a Repository Work.*ever-works\/ever-works/),
            }),
        });
    });
});

describe('WorkLifecycleService.deleteWork — other kinds keep their behaviour', () => {
    it('a directory Work still deletes all three repositories when asked and cleans up its checkouts', async () => {
        const { service, mocks } = makeService(directoryWork());

        const result = await service.deleteWork('w-dir', ALL_ON, user);

        expect(result.deleted_repositories).toEqual([
            'acme/best-tools-data',
            'acme/best-tools',
            'acme/best-tools-website',
        ]);
        expect(mocks.dataGenerator.removeRepository).toHaveBeenCalledTimes(1);
        expect(mocks.markdownGenerator.removeRepository).toHaveBeenCalledTimes(1);
        expect(mocks.websiteGenerator.removeRepository).toHaveBeenCalledTimes(1);
        expect(mocks.dataGenerator.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.markdownGenerator.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.websiteGenerator.cleanup).toHaveBeenCalledTimes(1);
    });

    it('the awesome-repo kind is NOT a Repository Work — its data repository is deletable', async () => {
        // Guards against a lazy substring check on the kind name.
        const { service, mocks } = makeService(directoryWork('awesome-repo'));

        await service.deleteWork('w-dir', { delete_data_repository: true }, user);

        expect(mocks.dataGenerator.removeRepository).toHaveBeenCalledTimes(1);
    });

    it('skips a role the kind never provisions instead of deleting a derived name (company → no website repo)', async () => {
        const { service, mocks } = makeService(directoryWork('company'));

        const result = await service.deleteWork('w-dir', ALL_ON, user);

        expect(mocks.dataGenerator.removeRepository).toHaveBeenCalledTimes(1);
        expect(mocks.markdownGenerator.removeRepository).toHaveBeenCalledTimes(1);
        expect(mocks.websiteGenerator.removeRepository).not.toHaveBeenCalled();
        expect(result.deleted_repositories).toEqual(['acme/best-tools-data', 'acme/best-tools']);
    });
});

/**
 * A managed-hosting Work's site is served by its Ingress on the works cluster.
 * Since the `ever.works` zone carries a proxied `*.ever.works` wildcard routed to
 * that ingress, removing the Work's DNS record alone leaves the site public; the
 * delete must also remove its Kubernetes objects. Best effort, like the DNS
 * removal: nothing in the teardown may block or fail the delete.
 */
describe('WorkLifecycleService.deleteWork — managed hosting removes the cluster objects', () => {
    function managedWork(
        deployProvider: 'ever-works' | 'k8s' = 'ever-works',
    ): Record<string, unknown> {
        return { ...directoryWork(), id: 'w-managed', slug: 'best-tools', deployProvider };
    }

    function readyTeardown(run: jest.Mock) {
        return {
            status: 'ready',
            namespace: 'ever-works-tenants-owner-1',
            objectName: 'best-tools-website',
            run,
        };
    }

    const removedAll = {
        location: 'ever-works-tenants-owner-1',
        removed: [
            { kind: 'Ingress', name: 'best-tools-website' },
            { kind: 'Service', name: 'best-tools-website' },
            { kind: 'Deployment', name: 'best-tools-website' },
        ],
        absent: [],
        kept: [],
        failed: [],
    };

    it.each(['ever-works', 'k8s'] as const)(
        'a %s Work: resolves the target before the row goes, removes the DNS record after it, then the objects',
        async (provider) => {
            const { service, mocks } = makeService(managedWork(provider));
            const order: string[] = [];
            const run = jest.fn(async () => {
                order.push('teardown');
                return removedAll;
            });
            mocks.deployFacade.prepareWorkDeploymentTeardown.mockImplementation(async () => {
                order.push('prepare');
                return readyTeardown(run);
            });
            mocks.workRepository.delete.mockImplementation(async () => {
                order.push('row-deleted');
            });
            mocks.everWorksDns.removeWorkSubdomain.mockImplementation(async () => {
                order.push('dns');
            });

            const result = await service.deleteWork('w-managed', {}, user);

            expect(result.status).toBe('success');
            expect(mocks.deployFacade.prepareWorkDeploymentTeardown).toHaveBeenCalledWith({
                userId: user.id,
                workId: 'w-managed',
            });
            expect(run).toHaveBeenCalledTimes(1);
            // The DNS step first: it does not wait on the cluster, which may be slow.
            expect(order).toEqual(
                provider === 'ever-works'
                    ? ['prepare', 'row-deleted', 'dns', 'teardown']
                    : ['prepare', 'row-deleted', 'teardown'],
            );
        },
    );

    it('does not hold the delete on a cluster that does not answer: the teardown goes on in the background', async () => {
        const { service, mocks } = makeService(managedWork());
        (service as unknown as { deploymentTeardownWaitMs: number }).deploymentTeardownWaitMs = 20;
        const logger = (service as unknown as { logger: { warn: jest.Mock; log: jest.Mock } })
            .logger;
        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
        let finish: (value: typeof removedAll) => void = () => undefined;
        const run = jest.fn(
            () =>
                new Promise<typeof removedAll>((resolve) => {
                    finish = resolve;
                }),
        );
        mocks.deployFacade.prepareWorkDeploymentTeardown.mockResolvedValue(readyTeardown(run));

        const result = await service.deleteWork('w-managed', {}, user);

        expect(result.status).toBe('success');
        expect(mocks.everWorksDns.removeWorkSubdomain).toHaveBeenCalledWith('best-tools');
        expect(warn.mock.calls.map(([message]) => String(message))).toContainEqual(
            expect.stringContaining('goes on in the background'),
        );
        expect(log.mock.calls.some(([message]) => String(message).includes('removed'))).toBe(false);

        // When it ends, its outcome is still logged.
        finish(removedAll);
        await new Promise((resolve) => setImmediate(resolve));
        expect(log.mock.calls.map(([message]) => String(message))).toContainEqual(
            expect.stringContaining(
                'removed Ingress/best-tools-website, Service/best-tools-website, Deployment/best-tools-website',
            ),
        );
    });

    it('logs a failed object by its reason code, never by its message', async () => {
        const { service, mocks } = makeService(managedWork());
        const logger = (service as unknown as { logger: { error: jest.Mock } }).logger;
        const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
        const run = jest.fn().mockResolvedValue({
            ...removedAll,
            failed: [
                {
                    kind: 'Ingress',
                    name: 'best-tools-website',
                    error: 'ingresses is forbidden: User "system:serviceaccount:works:deployer"',
                    code: 'UNAUTHORIZED',
                },
            ],
        });
        mocks.deployFacade.prepareWorkDeploymentTeardown.mockResolvedValue(readyTeardown(run));

        await service.deleteWork('w-managed', {}, user);

        const messages = error.mock.calls.map(([message]) => String(message));
        expect(messages).toContainEqual(
            expect.stringContaining('could not remove Ingress/best-tools-website (UNAUTHORIZED)'),
        );
        expect(messages.join('\n')).not.toContain('forbidden');
    });

    it('says where the Work was last deployed when that is not where the teardown looks', async () => {
        const { service, mocks } = makeService(managedWork());
        const logger = (service as unknown as { logger: { warn: jest.Mock } }).logger;
        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const run = jest.fn().mockResolvedValue(removedAll);
        mocks.deployFacade.prepareWorkDeploymentTeardown.mockResolvedValue({
            ...readyTeardown(run),
            staleTarget: 'ever-works-tenants-owner-1/old-tools-website',
        });

        await service.deleteWork('w-managed', {}, user);

        expect(warn.mock.calls.map(([message]) => String(message))).toContainEqual(
            expect.stringContaining(
                'last deployed as ever-works-tenants-owner-1/old-tools-website',
            ),
        );
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('a result that cannot even be logged does not fail the delete', async () => {
        const { service, mocks } = makeService(managedWork());
        const logger = (service as unknown as { logger: { log: jest.Mock } }).logger;
        jest.spyOn(logger, 'log').mockImplementation(() => {
            throw new Error('log sink down');
        });
        const run = jest.fn().mockResolvedValue(removedAll);
        mocks.deployFacade.prepareWorkDeploymentTeardown.mockResolvedValue(readyTeardown(run));

        await expect(service.deleteWork('w-managed', {}, user)).resolves.toMatchObject({
            status: 'success',
        });
    });

    it('a Vercel Work never asks for a cluster teardown', async () => {
        const { service, mocks } = makeService(directoryWork());

        await service.deleteWork('w-dir', {}, user);

        expect(mocks.deployFacade.prepareWorkDeploymentTeardown).not.toHaveBeenCalled();
    });

    it('a skipped preparation removes nothing and the delete goes on', async () => {
        const { service, mocks } = makeService(managedWork());
        mocks.deployFacade.prepareWorkDeploymentTeardown.mockResolvedValue({
            status: 'skipped',
            reason: 'shared',
            detail: 'Work w-other deploys to ever-works-tenants-owner-1/best-tools-website too',
        });

        const result = await service.deleteWork('w-managed', {}, user);

        expect(result.status).toBe('success');
        expect(mocks.workRepository.delete).toHaveBeenCalledWith('w-managed');
        expect(mocks.everWorksDns.removeWorkSubdomain).toHaveBeenCalledWith('best-tools');
    });

    it('a preparation that throws does not block the delete', async () => {
        const { service, mocks } = makeService(managedWork());
        mocks.deployFacade.prepareWorkDeploymentTeardown.mockRejectedValue(new Error('boom'));

        const result = await service.deleteWork('w-managed', {}, user);

        expect(result.status).toBe('success');
        expect(mocks.workRepository.delete).toHaveBeenCalledWith('w-managed');
        expect(mocks.everWorksDns.removeWorkSubdomain).toHaveBeenCalledWith('best-tools');
    });

    it('a teardown that throws does not fail the delete, and the DNS record is still removed', async () => {
        const { service, mocks } = makeService(managedWork());
        const run = jest.fn().mockRejectedValue(new Error('cluster unreachable'));
        mocks.deployFacade.prepareWorkDeploymentTeardown.mockResolvedValue(readyTeardown(run));

        const result = await service.deleteWork('w-managed', {}, user);

        expect(result.status).toBe('success');
        expect(run).toHaveBeenCalledTimes(1);
        expect(mocks.everWorksDns.removeWorkSubdomain).toHaveBeenCalledWith('best-tools');
    });

    it('a partial teardown (some objects kept or failed) still answers success', async () => {
        const { service, mocks } = makeService(managedWork());
        const run = jest.fn().mockResolvedValue({
            ...removedAll,
            removed: [{ kind: 'Service', name: 'best-tools-website' }],
            kept: [{ kind: 'Ingress', name: 'best-tools-website', reason: 'other_manager' }],
            failed: [{ kind: 'Deployment', name: 'best-tools-website', error: 'forbidden' }],
        });
        mocks.deployFacade.prepareWorkDeploymentTeardown.mockResolvedValue(readyTeardown(run));

        const result = await service.deleteWork('w-managed', {}, user);

        expect(result.status).toBe('success');
    });

    it('does not remove anything when the row delete itself fails', async () => {
        const { service, mocks } = makeService(managedWork());
        const run = jest.fn().mockResolvedValue(removedAll);
        mocks.deployFacade.prepareWorkDeploymentTeardown.mockResolvedValue(readyTeardown(run));
        mocks.workRepository.delete.mockRejectedValue(new Error('db down'));

        await expect(service.deleteWork('w-managed', {}, user)).rejects.toBeDefined();

        expect(run).not.toHaveBeenCalled();
        expect(mocks.everWorksDns.removeWorkSubdomain).not.toHaveBeenCalled();
    });
});

/**
 * #3337 review M5: the `<slug>.<root>` record goes with an `ever-works` Work only
 * when that Work holds the name. A slug is not unique across tenants, and since
 * #3327 the DNS provider only guards against records off the managed target, so
 * a record on it that serves another Work would otherwise be deleted too.
 */
describe('WorkLifecycleService.deleteWork — the slug DNS record goes only with the Work that holds it', () => {
    function everWorksWork(managedSubdomain: string | null): Record<string, unknown> {
        return {
            ...directoryWork(),
            id: 'w-managed',
            slug: 'best-tools',
            deployProvider: 'ever-works',
            managedSubdomain,
        };
    }

    it('removes it when the Work holds the managed subdomain claim on its slug', async () => {
        const { service, mocks } = makeService(everWorksWork('best-tools'));

        await service.deleteWork('w-managed', {}, user);

        expect(mocks.workRepository.findByManagedSubdomain).toHaveBeenCalledWith('best-tools');
        expect(mocks.workRepository.findByDeployProvidersForUserOrSlug).not.toHaveBeenCalled();
        expect(mocks.everWorksDns.removeWorkSubdomain).toHaveBeenCalledWith('best-tools');
    });

    it('keeps it when ANOTHER Work holds the managed subdomain claim on that slug', async () => {
        const { service, mocks } = makeService(everWorksWork(null));
        mocks.workRepository.findByManagedSubdomain.mockResolvedValue({ id: 'w-other' });

        const result = await service.deleteWork('w-managed', {}, user);

        expect(result.status).toBe('success');
        expect(mocks.everWorksDns.removeWorkSubdomain).not.toHaveBeenCalled();
    });

    it('removes it for a Work from before managed subdomains when no other ever-works Work has the slug', async () => {
        const { service, mocks } = makeService(everWorksWork(null));

        await service.deleteWork('w-managed', {}, user);

        expect(mocks.workRepository.findByDeployProvidersForUserOrSlug).toHaveBeenCalledWith(
            ['ever-works'],
            '',
            'best-tools',
        );
        expect(mocks.everWorksDns.removeWorkSubdomain).toHaveBeenCalledWith('best-tools');
    });

    it('keeps it for a Work from before managed subdomains when another ever-works Work has the same slug', async () => {
        const { service, mocks } = makeService(everWorksWork(null));
        mocks.workRepository.findByDeployProvidersForUserOrSlug.mockResolvedValue([
            { id: 'w-other-tenant', slug: 'best-tools', deployProvider: 'ever-works' },
        ]);

        const result = await service.deleteWork('w-managed', {}, user);

        expect(result.status).toBe('success');
        expect(mocks.everWorksDns.removeWorkSubdomain).not.toHaveBeenCalled();
    });

    it('keeps it when the owner of the name cannot be checked, and the delete still succeeds', async () => {
        const { service, mocks } = makeService(everWorksWork('best-tools'));
        mocks.workRepository.findByManagedSubdomain.mockRejectedValue(new Error('db down'));

        const result = await service.deleteWork('w-managed', {}, user);

        expect(result.status).toBe('success');
        expect(mocks.everWorksDns.removeWorkSubdomain).not.toHaveBeenCalled();
    });

    it('never looks at DNS ownership for a Work on another provider', async () => {
        const { service, mocks } = makeService(directoryWork());

        await service.deleteWork('w-dir', {}, user);

        expect(mocks.workRepository.findByManagedSubdomain).not.toHaveBeenCalled();
        expect(mocks.everWorksDns.removeWorkSubdomain).not.toHaveBeenCalled();
    });
});
