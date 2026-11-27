import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DeployFacadeService, normaliseObjectName } from '../deploy.facade';

/**
 * `DeployFacadeService.prepareWorkDeploymentTeardown` — resolving, while the Work
 * row still exists, where its deploy put its Kubernetes objects, so a deleted
 * Work's Ingress can be removed after the row is gone.
 *
 * Since the `ever.works` zone carries a proxied `*.ever.works` wildcard that the
 * shared tunnel routes to the works ingress, removing a Work's DNS record no longer
 * takes its site down; its Ingress has to go too. These tests pin which Works get a
 * teardown, where it points, and that nothing here can throw into the delete.
 */

const MANAGED_KUBECONFIG = 'managed-tenant-kubeconfig';
const INTERNAL_KUBECONFIG = 'internal-works-kubeconfig';

interface WorkFixture {
    id: string;
    userId: string;
    slug: string;
    kind?: string;
    deployProvider: string | null;
    websiteRepo: string;
    deployProjectId?: string | null;
    user?: { id: string; isPlatformAdmin?: boolean };
}

function work(fixture: Partial<WorkFixture> = {}): Record<string, unknown> {
    const f: WorkFixture = {
        id: 'work-1',
        userId: 'user-1',
        slug: 'awesome-memes',
        kind: 'directory',
        deployProvider: 'ever-works',
        websiteRepo: 'awesome-memes-website',
        ...fixture,
    };
    return {
        id: f.id,
        userId: f.userId,
        slug: f.slug,
        kind: f.kind,
        deployProvider: f.deployProvider,
        deployProjectId: f.deployProjectId ?? null,
        managedSubdomain: null,
        user: f.user ?? { id: f.userId, isPlatformAdmin: true },
        getWebsiteRepo: () => f.websiteRepo,
        getRepoOwner: () => 'ever-works',
    };
}

function createService(args: {
    work: Record<string, unknown> | null;
    /** Non-secret settings per Work id (what `getSettings` answers). */
    settingsByWork?: Record<string, Record<string, unknown>>;
    /** Secret-including settings (what `getResolvedSettings(includeSecrets: true)` answers). */
    resolvedSecrets?: Record<string, { value?: unknown }>;
    candidates?: Array<Record<string, unknown>>;
    pluginOverrides?: Record<string, unknown>;
    managedKubeconfig?: string | null;
}) {
    const removeWorkDeployment = jest.fn().mockResolvedValue({
        location: 'ns',
        removed: [{ kind: 'Ingress', name: 'x' }],
        absent: [],
        kept: [],
        failed: [],
    });
    const plugin = {
        id: 'k8s',
        name: 'Kubernetes',
        providerName: 'kubernetes',
        capabilities: ['deployment'],
        removeWorkDeployment,
        ...args.pluginOverrides,
    };
    const registered = {
        plugin,
        manifest: { id: 'k8s', name: 'Kubernetes', capabilities: ['deployment'] },
        state: 'loaded',
    };
    const registry = {
        get: jest.fn((id: string) => (id === 'k8s' ? registered : undefined)),
        getByCapability: jest.fn(() => [registered]),
    };
    const settingsService = {
        getSettings: jest.fn(async (_pluginId: string, options: { workId?: string }) => {
            return args.settingsByWork?.[options.workId ?? ''] ?? {};
        }),
        getResolvedSettings: jest.fn(
            async (_pluginId: string, options: { workId?: string; includeSecrets?: boolean }) => {
                if (options.includeSecrets) return args.resolvedSecrets ?? {};
                const values = args.settingsByWork?.[options.workId ?? ''] ?? {};
                return Object.fromEntries(
                    Object.keys(values).map((key) => [key, { value: values[key], source: 'work' }]),
                );
            },
        ),
    };
    const workRepository = {
        findById: jest.fn().mockResolvedValue(args.work),
        findDeploymentSharerCandidates: jest.fn().mockResolvedValue(args.candidates ?? []),
        update: jest.fn(),
    };
    const managed =
        args.managedKubeconfig === undefined ? MANAGED_KUBECONFIG : args.managedKubeconfig;
    const everWorksDeployProvider = {
        isEnabled: jest.fn(() => managed !== null),
        resolveKubeconfig: jest.fn(async () => managed),
    };

    const service = new DeployFacadeService(
        registry as any,
        settingsService as any,
        workRepository as any,
        {} as any,
        {} as any,
        undefined,
        everWorksDeployProvider as any,
    );
    return { service, plugin, registry, settingsService, workRepository, removeWorkDeployment };
}

describe('DeployFacadeService.prepareWorkDeploymentTeardown', () => {
    const saved = {
        internal: process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG,
        shared: process.env.EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG,
        base: process.env.EVER_WORKS_DEPLOY_NAMESPACE,
        owner: process.env.EVER_WORKS_K8S_WORKS_CLUSTER_OWNER,
        suffix: process.env.EVER_WORKS_K8S_WORKS_NAMESPACE_SUFFIX,
    };

    beforeEach(() => {
        delete process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG;
        delete process.env.EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG;
        delete process.env.EVER_WORKS_DEPLOY_NAMESPACE;
        delete process.env.EVER_WORKS_K8S_WORKS_NAMESPACE_SUFFIX;
        // This environment owns the clusters, unless a test says otherwise.
        process.env.EVER_WORKS_K8S_WORKS_CLUSTER_OWNER = 'true';
    });

    afterAll(() => {
        const restore = (key: string, value: string | undefined) => {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        };
        restore('EVER_WORKS_K8S_WORKS_KUBECONFIG', saved.internal);
        restore('EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG', saved.shared);
        restore('EVER_WORKS_DEPLOY_NAMESPACE', saved.base);
        restore('EVER_WORKS_K8S_WORKS_CLUSTER_OWNER', saved.owner);
        restore('EVER_WORKS_K8S_WORKS_NAMESPACE_SUFFIX', saved.suffix);
    });

    describe('only in the environment that owns the platform clusters', () => {
        it.each([
            ['unset', undefined],
            ['false', 'false'],
        ])(
            'skips an ever-works Work as not_cluster_owner when the flag is %s, before any credential',
            async (_label, value) => {
                if (value === undefined) delete process.env.EVER_WORKS_K8S_WORKS_CLUSTER_OWNER;
                else process.env.EVER_WORKS_K8S_WORKS_CLUSTER_OWNER = value;
                const { service, workRepository, removeWorkDeployment, registry } = createService({
                    work: work(),
                });

                await expect(
                    service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
                ).resolves.toEqual({
                    status: 'skipped',
                    reason: 'not_cluster_owner',
                    detail: 'EVER_WORKS_K8S_WORKS_CLUSTER_OWNER is not true in this environment',
                });
                expect(registry.get).not.toHaveBeenCalled();
                expect(workRepository.findDeploymentSharerCandidates).not.toHaveBeenCalled();
                expect(removeWorkDeployment).not.toHaveBeenCalled();
            },
        );

        it('skips a k8s Work on k8s-works as not_cluster_owner too', async () => {
            delete process.env.EVER_WORKS_K8S_WORKS_CLUSTER_OWNER;
            process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG = INTERNAL_KUBECONFIG;
            const { service } = createService({
                work: work({ deployProvider: 'k8s' }),
                settingsByWork: { 'work-1': { clusterSource: 'k8s-works' } },
                resolvedSecrets: { clusterSource: { value: 'k8s-works' } },
            });

            await expect(
                service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toMatchObject({ status: 'skipped', reason: 'not_cluster_owner' });
        });

        it('still answers not_managed, not not_cluster_owner, for a member cluster or another provider', async () => {
            delete process.env.EVER_WORKS_K8S_WORKS_CLUSTER_OWNER;
            const custom = createService({
                work: work({ deployProvider: 'k8s' }),
                settingsByWork: { 'work-1': { clusterSource: 'custom-kubeconfig' } },
            });
            const vercel = createService({ work: work({ deployProvider: 'vercel' }) });

            for (const { service } of [custom, vercel]) {
                await expect(
                    service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
                ).resolves.toEqual({ status: 'skipped', reason: 'not_managed' });
            }
        });
    });

    it('prepares the managed ever-works Work in its tenant namespace with the platform kubeconfig', async () => {
        const { service, removeWorkDeployment } = createService({ work: work() });

        const prepared = await service.prepareWorkDeploymentTeardown({
            userId: 'user-1',
            workId: 'work-1',
        });

        expect(prepared).toMatchObject({
            status: 'ready',
            namespace: 'ever-works-tenants-user-1',
            objectName: 'awesome-memes-website',
        });
        // Nothing is removed while preparing: the row has not been deleted yet.
        expect(removeWorkDeployment).not.toHaveBeenCalled();

        if (prepared.status !== 'ready') throw new Error('expected ready');
        await prepared.run();
        expect(removeWorkDeployment).toHaveBeenCalledTimes(1);
        const [projectName, credential, context] = removeWorkDeployment.mock.calls[0];
        expect(projectName).toBe('awesome-memes-website');
        expect(credential).toBe(MANAGED_KUBECONFIG);
        expect(context).toMatchObject({
            namespaceOverride: 'ever-works-tenants-user-1',
            projectNameOverride: 'awesome-memes-website',
            kubeContextOverride: null,
        });
    });

    it('hands the plugin the deleted Work’s id and this environment, so it keeps objects labelled for another', async () => {
        const { service, removeWorkDeployment } = createService({ work: work() });

        const prepared = await service.prepareWorkDeploymentTeardown({
            userId: 'user-1',
            workId: 'work-1',
        });

        if (prepared.status !== 'ready') throw new Error('expected ready');
        await prepared.run();
        const [, , context] = removeWorkDeployment.mock.calls[0];
        // `prod` when EVER_WORKS_K8S_WORKS_NAMESPACE_SUFFIX is unset, as the deploy stamps it.
        expect(context).toMatchObject({ workUuid: 'work-1', environment: 'prod' });
    });

    it('names the environment by EVER_WORKS_K8S_WORKS_NAMESPACE_SUFFIX, the value the deploy stamps', async () => {
        process.env.EVER_WORKS_K8S_WORKS_NAMESPACE_SUFFIX = 'stage';
        const { service, removeWorkDeployment } = createService({ work: work() });

        const prepared = await service.prepareWorkDeploymentTeardown({
            userId: 'user-1',
            workId: 'work-1',
        });

        if (prepared.status !== 'ready') throw new Error('expected ready');
        await prepared.run();
        expect(removeWorkDeployment.mock.calls[0][2]).toMatchObject({
            workUuid: 'work-1',
            environment: 'stage',
        });
    });

    it('reports the sanitised object name but hands the plugin the raw website repository, as deploy() did', async () => {
        const { service, removeWorkDeployment } = createService({
            work: work({ websiteRepo: 'Awesome_Memes-Website' }),
        });

        const prepared = await service.prepareWorkDeploymentTeardown({
            userId: 'user-1',
            workId: 'work-1',
        });

        expect(prepared).toMatchObject({ status: 'ready', objectName: 'awesome-memes-website' });
        if (prepared.status !== 'ready') throw new Error('expected ready');
        await prepared.run();
        const [projectName, , context] = removeWorkDeployment.mock.calls[0];
        // The plugin sanitises both itself, exactly as it did when it deployed.
        expect(projectName).toBe('Awesome_Memes-Website');
        expect(context).toMatchObject({ projectNameOverride: 'Awesome_Memes-Website' });
    });

    it('honours EVER_WORKS_DEPLOY_NAMESPACE as the tenant namespace base, like the deploy', async () => {
        process.env.EVER_WORKS_DEPLOY_NAMESPACE = 'ew-tenants';
        const { service } = createService({ work: work() });

        const prepared = await service.prepareWorkDeploymentTeardown({
            userId: 'user-1',
            workId: 'work-1',
        });

        expect(prepared).toMatchObject({ status: 'ready', namespace: 'ew-tenants-user-1' });
    });

    it('prepares a k8s Work on the internal k8s-works cluster in its derived namespace', async () => {
        process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG = INTERNAL_KUBECONFIG;
        const { service, removeWorkDeployment } = createService({
            work: work({
                deployProvider: 'k8s',
                slug: 'chairs',
                websiteRepo: 'awesome-chairs-website',
            }),
            settingsByWork: { 'work-1': { clusterSource: 'k8s-works' } },
            resolvedSecrets: { clusterSource: { value: 'k8s-works' } },
        });

        const prepared = await service.prepareWorkDeploymentTeardown({
            userId: 'user-1',
            workId: 'work-1',
        });

        expect(prepared).toMatchObject({
            status: 'ready',
            namespace: 'ever-works-chairs-prod',
            objectName: 'awesome-chairs-website',
        });
        if (prepared.status !== 'ready') throw new Error('expected ready');
        await prepared.run();
        expect(removeWorkDeployment.mock.calls[0][1]).toBe(INTERNAL_KUBECONFIG);
    });

    it('skips an explicit reserved namespace as no_namespace, not as an unresolved error', async () => {
        process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG = INTERNAL_KUBECONFIG;
        const { service, removeWorkDeployment } = createService({
            work: work({ deployProvider: 'k8s' }),
            settingsByWork: { 'work-1': { clusterSource: 'k8s-works', namespace: 'kube-system' } },
            resolvedSecrets: { clusterSource: { value: 'k8s-works' } },
        });

        await expect(
            service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
        ).resolves.toEqual({ status: 'skipped', reason: 'no_namespace' });
        expect(removeWorkDeployment).not.toHaveBeenCalled();
    });

    it('skips a k8s Work on the member’s own cluster without resolving any credential', async () => {
        const { service, registry } = createService({
            work: work({ deployProvider: 'k8s' }),
            settingsByWork: { 'work-1': { clusterSource: 'custom-kubeconfig' } },
        });

        const prepared = await service.prepareWorkDeploymentTeardown({
            userId: 'user-1',
            workId: 'work-1',
        });

        expect(prepared).toEqual({ status: 'skipped', reason: 'not_managed' });
        expect(registry.get).not.toHaveBeenCalled();
    });

    it.each([
        ['a Vercel Work', { deployProvider: 'vercel' }],
        ['a Work with no deploy provider', { deployProvider: null }],
        ['an App Work (its own runtime removes its workloads)', { kind: 'app' }],
    ])('skips %s as not managed', async (_label, fixture) => {
        const { service, registry } = createService({
            work: work(fixture as Partial<WorkFixture>),
        });

        const prepared = await service.prepareWorkDeploymentTeardown({
            userId: 'user-1',
            workId: 'work-1',
        });

        expect(prepared).toEqual({ status: 'skipped', reason: 'not_managed' });
        expect(registry.get).not.toHaveBeenCalled();
    });

    it('skips when the Work is not found', async () => {
        const { service } = createService({ work: null });

        await expect(
            service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'gone' }),
        ).resolves.toEqual({ status: 'skipped', reason: 'not_found' });
    });

    it('skips when the deploy plugin has no removeWorkDeployment', async () => {
        const { service } = createService({
            work: work(),
            pluginOverrides: { removeWorkDeployment: undefined },
        });

        await expect(
            service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
        ).resolves.toEqual({ status: 'skipped', reason: 'unsupported' });
    });

    it('reports an unresolvable target as skipped instead of throwing', async () => {
        // No platform kubeconfig and no member kubeconfig: the deploy could not run here either.
        const { service } = createService({ work: work(), managedKubeconfig: null });

        const prepared = await service.prepareWorkDeploymentTeardown({
            userId: 'user-1',
            workId: 'work-1',
        });

        expect(prepared).toEqual({
            status: 'skipped',
            reason: 'unresolved',
            detail: 'no platform kubeconfig for the ever-works provider',
        });
    });

    it('never falls back to the member’s own kubeconfig for an ever-works Work', async () => {
        // The deploy would use the member's `k8s` kubeconfig here; the teardown must not,
        // or it would delete on the member's cluster.
        const { service, settingsService, removeWorkDeployment } = createService({
            work: work(),
            managedKubeconfig: null,
            resolvedSecrets: { kubeconfig: { value: 'member-kubeconfig' } },
        });

        const prepared = await service.prepareWorkDeploymentTeardown({
            userId: 'user-1',
            workId: 'work-1',
        });

        expect(prepared).toMatchObject({ status: 'skipped', reason: 'unresolved' });
        expect(removeWorkDeployment).not.toHaveBeenCalled();
        // The member's secret-bearing settings are not even read.
        expect(
            settingsService.getResolvedSettings.mock.calls.some(
                ([, options]) => (options as { includeSecrets?: boolean }).includeSecrets === true,
            ),
        ).toBe(false);
    });

    it('uses the shared-cluster kubeconfig for an ever-works Work when no dedicated one is set, never the member’s', async () => {
        process.env.EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG = 'shared-cluster-kubeconfig';
        const { service, removeWorkDeployment } = createService({
            work: work(),
            managedKubeconfig: null,
            resolvedSecrets: { kubeconfig: { value: 'member-kubeconfig' } },
        });

        const prepared = await service.prepareWorkDeploymentTeardown({
            userId: 'user-1',
            workId: 'work-1',
        });

        if (prepared.status !== 'ready') throw new Error(`expected ready, got ${prepared.reason}`);
        await prepared.run();
        expect(removeWorkDeployment.mock.calls[0][1]).toBe('shared-cluster-kubeconfig');
    });

    it('never throws, and logs only a reason code, when the Work lookup itself fails', async () => {
        const { service, workRepository } = createService({ work: work() });
        workRepository.findById.mockRejectedValue(
            Object.assign(new Error('db down at postgres://admin:hunter2@db'), {
                code: 'ECONNREFUSED',
            }),
        );

        await expect(
            service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
        ).resolves.toEqual({ status: 'skipped', reason: 'unresolved', detail: 'ECONNREFUSED' });
    });

    it('answers "unknown" for an error that carries no code', async () => {
        const { service, workRepository } = createService({ work: work() });
        workRepository.findById.mockRejectedValue(new Error('db down'));

        await expect(
            service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
        ).resolves.toEqual({ status: 'skipped', reason: 'unresolved', detail: 'unknown' });
    });

    it('names a different place the Work was last deployed to, which this teardown does not remove', async () => {
        const { service } = createService({
            work: work({ deployProjectId: 'ever-works-tenants-user-1/old-memes-website' }),
        });

        await expect(
            service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
        ).resolves.toMatchObject({
            status: 'ready',
            staleTarget: 'ever-works-tenants-user-1/old-memes-website',
        });
    });

    it.each([
        ['the same place', 'ever-works-tenants-user-1/awesome-memes-website'],
        ['another provider’s project id', 'prj_AbC123'],
    ])('reports no stale target when deployProjectId is %s', async (_label, deployProjectId) => {
        const { service } = createService({ work: work({ deployProjectId }) });

        const prepared = await service.prepareWorkDeploymentTeardown({
            userId: 'user-1',
            workId: 'work-1',
        });

        expect(prepared.status).toBe('ready');
        expect(prepared).not.toHaveProperty('staleTarget');
    });

    describe('objects another Work also deploys to', () => {
        it('skips when another Work of the owner deploys the same website repository to the same namespace', async () => {
            const { service, removeWorkDeployment } = createService({
                work: work(),
                candidates: [work(), work({ id: 'work-2', slug: 'memes-copy' })],
            });

            const prepared = await service.prepareWorkDeploymentTeardown({
                userId: 'user-1',
                workId: 'work-1',
            });

            expect(prepared).toMatchObject({ status: 'skipped', reason: 'shared' });
            expect((prepared as { detail?: string }).detail).toContain('work-2');
            expect(removeWorkDeployment).not.toHaveBeenCalled();
        });

        it('matches website repositories by their Kubernetes object name, not their raw spelling', async () => {
            const { service } = createService({
                work: work(),
                candidates: [work({ id: 'work-2', websiteRepo: 'Awesome_Memes-Website' })],
            });

            await expect(
                service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toMatchObject({ status: 'skipped', reason: 'shared' });
        });

        it('is not blocked by a same-slug Work of another owner, whose tenant namespace differs', async () => {
            const { service } = createService({
                work: work(),
                candidates: [work({ id: 'work-9', userId: 'user-9' })],
            });

            await expect(
                service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toMatchObject({ status: 'ready', namespace: 'ever-works-tenants-user-1' });
        });

        it('is not blocked by another Work of the owner with a different website repository', async () => {
            const { service } = createService({
                work: work(),
                candidates: [work({ id: 'work-2', websiteRepo: 'awesome-memos-website' })],
            });

            await expect(
                service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toMatchObject({ status: 'ready' });
        });

        it('counts a candidate whose namespace cannot be worked out as a sharer (the safe side)', async () => {
            const { service, settingsService } = createService({
                work: work(),
                candidates: [work({ id: 'work-2' })],
            });
            settingsService.getSettings.mockImplementation(
                async (_id: string, options: { workId?: string }) => {
                    if (options.workId === 'work-2') throw new Error('settings unavailable');
                    return {};
                },
            );

            const prepared = await service.prepareWorkDeploymentTeardown({
                userId: 'user-1',
                workId: 'work-1',
            });

            expect(prepared).toMatchObject({ status: 'skipped', reason: 'shared' });
            // Says it is a guess, so an operator knows why this delete left objects behind.
            expect((prepared as { detail?: string }).detail).toContain('work-2');
            expect((prepared as { detail?: string }).detail).toContain('could not be read');
        });

        it('says plainly when a sharer was resolved, not guessed', async () => {
            const { service } = createService({
                work: work(),
                candidates: [work({ id: 'work-2' })],
            });

            const prepared = await service.prepareWorkDeploymentTeardown({
                userId: 'user-1',
                workId: 'work-1',
            });

            expect((prepared as { detail?: string }).detail).toBe(
                'Work work-2 deploys to ever-works-tenants-user-1/awesome-memes-website too',
            );
        });

        it('looks candidates up by the owner and the slug', async () => {
            const { service, workRepository } = createService({ work: work() });

            await service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' });

            // The Work's own tenant namespace: no other tenant to add. Any Work that has
            // the target cached as its deploy target is a candidate too.
            expect(workRepository.findDeploymentSharerCandidates).toHaveBeenCalledWith(
                'user-1',
                'awesome-memes',
                {
                    tenantUserId: undefined,
                    deployProjectId: 'ever-works-tenants-user-1/awesome-memes-website',
                },
            );
        });

        it('is blocked by another admin’s live Work whose namespace this one took over explicitly', async () => {
            // Admin B's duplicate `mcp-servers-v2` points its namespace at admin A's
            // `mcpserver` Work (slug-derived `ever-works-mcpserver-prod`), same repository.
            // Neither the owner nor the slug matches: only the namespace says they share.
            process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG = INTERNAL_KUBECONFIG;
            const repo = 'awesome-mcp-servers-website';
            const { service, removeWorkDeployment } = createService({
                work: work({
                    id: 'work-b',
                    userId: 'user-b',
                    slug: 'mcp-servers-v2',
                    deployProvider: 'k8s',
                    websiteRepo: repo,
                }),
                settingsByWork: {
                    'work-b': {
                        clusterSource: 'k8s-works',
                        namespace: 'ever-works-mcpserver-prod',
                    },
                    'work-a': { clusterSource: 'k8s-works' },
                },
                resolvedSecrets: { clusterSource: { value: 'k8s-works' } },
                candidates: [
                    work({
                        id: 'work-a',
                        userId: 'user-a',
                        slug: 'mcpserver',
                        deployProvider: 'k8s',
                        websiteRepo: repo,
                    }),
                ],
            });

            const prepared = await service.prepareWorkDeploymentTeardown({
                userId: 'user-b',
                workId: 'work-b',
            });

            expect(prepared).toEqual({
                status: 'skipped',
                reason: 'shared',
                detail: `Work work-a deploys to ever-works-mcpserver-prod/${repo} too`,
            });
            expect(removeWorkDeployment).not.toHaveBeenCalled();
        });

        it('is blocked by a Work whose slug shares the 40 characters a k8s-works namespace keeps', async () => {
            process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG = INTERNAL_KUBECONFIG;
            const stem = 'a-very-long-directory-name-for-the-prefix'.slice(0, 40);
            const { service } = createService({
                work: work({ id: 'work-1', slug: `${stem}-one`, deployProvider: 'k8s' }),
                settingsByWork: {
                    'work-1': { clusterSource: 'k8s-works' },
                    'work-2': { clusterSource: 'k8s-works' },
                },
                resolvedSecrets: { clusterSource: { value: 'k8s-works' } },
                candidates: [
                    work({
                        id: 'work-2',
                        userId: 'user-2',
                        slug: `${stem}-two`,
                        deployProvider: 'k8s',
                    }),
                ],
            });

            await expect(
                service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toMatchObject({ status: 'skipped', reason: 'shared' });
        });

        it.each([
            ['moved to Vercel', 'vercel', 'vercel'],
            ['left with no provider', null, 'no provider'],
        ])(
            'is blocked by a same-owner Work with the same name that was %s: its old objects may still serve it',
            async (_label, provider, said) => {
                const { service, removeWorkDeployment } = createService({
                    work: work(),
                    candidates: [work({ id: 'work-2', deployProvider: provider })],
                });

                const prepared = await service.prepareWorkDeploymentTeardown({
                    userId: 'user-1',
                    workId: 'work-1',
                });

                expect(prepared).toMatchObject({ status: 'skipped', reason: 'shared' });
                const detail = (prepared as { detail?: string }).detail ?? '';
                expect(detail).toContain('work-2');
                expect(detail).toContain(`moved to ${said}`);
                expect(removeWorkDeployment).not.toHaveBeenCalled();
            },
        );

        it('is not blocked by a candidate whose own namespace setting is reserved: it can never deploy here', async () => {
            const { service } = createService({
                work: work(),
                settingsByWork: {
                    'work-2': { clusterSource: 'k8s-works', namespace: 'kube-system' },
                },
                candidates: [work({ id: 'work-2', deployProvider: 'k8s' })],
            });

            await expect(
                service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toMatchObject({ status: 'ready' });
        });

        it('ignores App Works among the candidates', async () => {
            const { service } = createService({
                work: work(),
                candidates: [work({ id: 'work-2', kind: 'app' })],
            });

            await expect(
                service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toMatchObject({ status: 'ready' });
        });

        it('is not blocked by another owner’s Work on another provider (only the owner’s or the tenant’s can have moved away)', async () => {
            const { service } = createService({
                work: work(),
                candidates: [work({ id: 'work-9', userId: 'user-9', deployProvider: 'vercel' })],
            });

            await expect(
                service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toMatchObject({ status: 'ready' });
        });

        describe('a namespace that is another tenant’s (N1)', () => {
            // An admin's `k8s` Work on `k8s-works` that names a member's tenant namespace
            // explicitly deploys to the same place as that member's `ever-works` Works.
            const adminWork = (fixture: Partial<WorkFixture> = {}) =>
                work({
                    id: 'work-admin',
                    userId: 'user-admin',
                    slug: 'admin-memes',
                    deployProvider: 'k8s',
                    ...fixture,
                });
            const adminSettings = {
                'work-admin': {
                    clusterSource: 'k8s-works',
                    namespace: 'ever-works-tenants-user-m',
                },
            };

            beforeEach(() => {
                process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG = INTERNAL_KUBECONFIG;
            });

            it('adds that tenant’s Works to the candidates', async () => {
                const { service, workRepository } = createService({
                    work: adminWork(),
                    settingsByWork: adminSettings,
                    resolvedSecrets: { clusterSource: { value: 'k8s-works' } },
                });

                const prepared = await service.prepareWorkDeploymentTeardown({
                    userId: 'user-admin',
                    workId: 'work-admin',
                });

                expect(prepared).toMatchObject({
                    status: 'ready',
                    namespace: 'ever-works-tenants-user-m',
                });
                expect(workRepository.findDeploymentSharerCandidates).toHaveBeenCalledWith(
                    'user-admin',
                    'admin-memes',
                    {
                        tenantUserId: 'user-m',
                        deployProjectId: 'ever-works-tenants-user-m/awesome-memes-website',
                    },
                );
            });

            it('is blocked by the tenant’s ever-works Work with another slug and the same repository', async () => {
                const { service, removeWorkDeployment } = createService({
                    work: adminWork(),
                    settingsByWork: adminSettings,
                    resolvedSecrets: { clusterSource: { value: 'k8s-works' } },
                    candidates: [work({ id: 'work-m', userId: 'user-m', slug: 'member-memes' })],
                });

                const prepared = await service.prepareWorkDeploymentTeardown({
                    userId: 'user-admin',
                    workId: 'work-admin',
                });

                expect(prepared).toEqual({
                    status: 'skipped',
                    reason: 'shared',
                    detail: 'Work work-m deploys to ever-works-tenants-user-m/awesome-memes-website too',
                });
                expect(removeWorkDeployment).not.toHaveBeenCalled();
            });

            it('is blocked by the tenant’s Work that moved to another provider', async () => {
                const { service } = createService({
                    work: adminWork(),
                    settingsByWork: adminSettings,
                    resolvedSecrets: { clusterSource: { value: 'k8s-works' } },
                    candidates: [
                        work({
                            id: 'work-m',
                            userId: 'user-m',
                            slug: 'member-memes',
                            deployProvider: 'vercel',
                        }),
                    ],
                });

                const prepared = await service.prepareWorkDeploymentTeardown({
                    userId: 'user-admin',
                    workId: 'work-admin',
                });

                expect(prepared).toMatchObject({ status: 'skipped', reason: 'shared' });
                const detail = (prepared as { detail?: string }).detail ?? '';
                expect(detail).toContain('work-m');
                expect(detail).toContain(
                    'belongs to the tenant whose namespace ever-works-tenants-user-m is',
                );
                expect(detail).toContain('moved to vercel');
            });

            it('skips as shared when the tenant cannot be read back from a name at the 63-character cap', async () => {
                process.env.EVER_WORKS_DEPLOY_NAMESPACE = 'ever-works-tenants-of-the-long-base';
                const namespace = `ever-works-tenants-of-the-long-base-${'a'.repeat(27)}`;
                expect(namespace).toHaveLength(63);
                const { service, workRepository, removeWorkDeployment } = createService({
                    work: adminWork(),
                    settingsByWork: { 'work-admin': { clusterSource: 'k8s-works', namespace } },
                    resolvedSecrets: { clusterSource: { value: 'k8s-works' } },
                });

                const prepared = await service.prepareWorkDeploymentTeardown({
                    userId: 'user-admin',
                    workId: 'work-admin',
                });

                expect(prepared).toMatchObject({ status: 'skipped', reason: 'shared' });
                expect((prepared as { detail?: string }).detail).toContain(
                    'cannot be read back from its name',
                );
                expect(workRepository.findDeploymentSharerCandidates).not.toHaveBeenCalled();
                expect(removeWorkDeployment).not.toHaveBeenCalled();
            });

            it('adds no other tenant for a namespace that is not a tenant namespace', async () => {
                const { service, workRepository } = createService({
                    work: adminWork(),
                    settingsByWork: {
                        'work-admin': {
                            clusterSource: 'k8s-works',
                            namespace: 'ever-works-memes-prod',
                        },
                    },
                    resolvedSecrets: { clusterSource: { value: 'k8s-works' } },
                });

                await expect(
                    service.prepareWorkDeploymentTeardown({
                        userId: 'user-admin',
                        workId: 'work-admin',
                    }),
                ).resolves.toMatchObject({ status: 'ready', namespace: 'ever-works-memes-prod' });
                expect(workRepository.findDeploymentSharerCandidates).toHaveBeenCalledWith(
                    'user-admin',
                    'admin-memes',
                    expect.objectContaining({ tenantUserId: undefined }),
                );
            });
        });

        describe('a Work whose cached deploy target is this one (N2, review m7)', () => {
            const TARGET = 'ever-works-tenants-user-1/awesome-memes-website';
            const CACHED_DETAIL = `has ${TARGET} cached as its deploy target, whatever it deploys to now`;

            it('is blocked by a same-owner k8s Work whose cached deployProjectId is this target', async () => {
                // work-2's cached target is here, though its `k8s-works` settings now derive
                // another namespace; its objects here may still serve it.
                const { service, removeWorkDeployment } = createService({
                    work: work(),
                    settingsByWork: { 'work-2': { clusterSource: 'k8s-works' } },
                    candidates: [
                        work({
                            id: 'work-2',
                            slug: 'memes-two',
                            deployProvider: 'k8s',
                            deployProjectId: TARGET,
                        }),
                    ],
                });

                const prepared = await service.prepareWorkDeploymentTeardown({
                    userId: 'user-1',
                    workId: 'work-1',
                });

                expect(prepared).toEqual({
                    status: 'skipped',
                    reason: 'shared',
                    detail: `Work work-2 ${CACHED_DETAIL}; its objects there may still serve it, so remove them by hand if they do not`,
                });
                expect(removeWorkDeployment).not.toHaveBeenCalled();
            });

            it('decides on the cached target without reading its settings, which may be reserved or unreadable', async () => {
                const { service, settingsService } = createService({
                    work: work(),
                    settingsByWork: {
                        'work-2': { clusterSource: 'k8s-works', namespace: 'kube-system' },
                    },
                    candidates: [
                        work({ id: 'work-2', deployProvider: 'k8s', deployProjectId: TARGET }),
                    ],
                });

                const prepared = await service.prepareWorkDeploymentTeardown({
                    userId: 'user-1',
                    workId: 'work-1',
                });

                expect(prepared).toMatchObject({ status: 'skipped', reason: 'shared' });
                expect((prepared as { detail?: string }).detail).toContain(CACHED_DETAIL);
                expect(
                    settingsService.getSettings.mock.calls.some(
                        ([, options]) => (options as { workId?: string }).workId === 'work-2',
                    ),
                ).toBe(false);
            });

            it('is blocked by a Work of another owner on another provider whose cached target is this one', async () => {
                // m7: admin B's Work named this namespace, then moved to Vercel. It is neither
                // the owner's, the tenant's, nor on Kubernetes now; only its cached id says so.
                const { service } = createService({
                    work: work(),
                    candidates: [
                        work({
                            id: 'work-b',
                            userId: 'user-b',
                            slug: 'b-memes',
                            deployProvider: 'vercel',
                            deployProjectId: TARGET,
                        }),
                    ],
                });

                const prepared = await service.prepareWorkDeploymentTeardown({
                    userId: 'user-1',
                    workId: 'work-1',
                });

                expect(prepared).toMatchObject({ status: 'skipped', reason: 'shared' });
                expect((prepared as { detail?: string }).detail).toContain(
                    `Work work-b ${CACHED_DETAIL}`,
                );
            });

            it('is blocked by a Work whose website repository was renamed since its target was cached', async () => {
                const { service } = createService({
                    work: work(),
                    candidates: [
                        work({
                            id: 'work-2',
                            deployProvider: 'k8s',
                            websiteRepo: 'renamed-memes-website',
                            deployProjectId: TARGET,
                        }),
                    ],
                });

                await expect(
                    service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
                ).resolves.toMatchObject({ status: 'skipped', reason: 'shared' });
            });

            it('is not blocked when that Work has another target cached', async () => {
                const { service } = createService({
                    work: work(),
                    settingsByWork: { 'work-2': { clusterSource: 'k8s-works' } },
                    candidates: [
                        work({
                            id: 'work-2',
                            slug: 'memes-two',
                            deployProvider: 'k8s',
                            deployProjectId: 'ever-works-memes-two-prod/awesome-memes-website',
                        }),
                    ],
                });

                await expect(
                    service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
                ).resolves.toMatchObject({ status: 'ready' });
            });
        });

        it('skips as shared when the owner’s own tenant namespace sits at the 63-character cap (review n1)', async () => {
            // The cut keeps only part of the id there, so other tenants may share the name.
            process.env.EVER_WORKS_DEPLOY_NAMESPACE = 'ever-works-tenants-of-the-long-base';
            const owner = 'a'.repeat(40);
            const { service, removeWorkDeployment } = createService({
                work: work({ userId: owner }),
            });

            const prepared = await service.prepareWorkDeploymentTeardown({
                userId: owner,
                workId: 'work-1',
            });

            expect(prepared).toMatchObject({ status: 'skipped', reason: 'shared' });
            expect((prepared as { detail?: string }).detail).toContain('63-character name cap');
            expect(removeWorkDeployment).not.toHaveBeenCalled();
        });
    });

    describe('EVER_WORKS_K8S_WORKS_NAMESPACE_SUFFIX: the teardown and its sharer check use the deploy’s suffix', () => {
        beforeEach(() => {
            process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG = INTERNAL_KUBECONFIG;
            process.env.EVER_WORKS_K8S_WORKS_NAMESPACE_SUFFIX = 'stage';
        });

        it('prepares a k8s-works Work in ever-works-<slug>-<suffix>, and looks for sharers there', async () => {
            const { service, workRepository } = createService({
                work: work({
                    deployProvider: 'k8s',
                    slug: 'chairs',
                    websiteRepo: 'awesome-chairs-website',
                }),
                settingsByWork: { 'work-1': { clusterSource: 'k8s-works' } },
                resolvedSecrets: { clusterSource: { value: 'k8s-works' } },
            });

            await expect(
                service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toMatchObject({
                status: 'ready',
                namespace: 'ever-works-chairs-stage',
                objectName: 'awesome-chairs-website',
            });
            expect(workRepository.findDeploymentSharerCandidates).toHaveBeenCalledWith(
                'user-1',
                'chairs',
                expect.objectContaining({
                    deployProjectId: 'ever-works-chairs-stage/awesome-chairs-website',
                }),
            );
        });

        it('is blocked by a Work whose slug-derived namespace, with the same suffix, is this one', async () => {
            // Two slugs that share the 40 characters the namespace keeps.
            const stem = 'a-very-long-directory-name-for-the-prefix'.slice(0, 40);
            const { service, removeWorkDeployment } = createService({
                work: work({ id: 'work-1', slug: `${stem}-one`, deployProvider: 'k8s' }),
                settingsByWork: {
                    'work-1': { clusterSource: 'k8s-works' },
                    'work-2': { clusterSource: 'k8s-works' },
                },
                resolvedSecrets: { clusterSource: { value: 'k8s-works' } },
                candidates: [
                    work({
                        id: 'work-2',
                        userId: 'user-2',
                        slug: `${stem}-two`,
                        deployProvider: 'k8s',
                    }),
                ],
            });

            await expect(
                service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toEqual({
                status: 'skipped',
                reason: 'shared',
                detail: `Work work-2 deploys to ever-works-${stem}-stage/awesome-memes-website too`,
            });
            expect(removeWorkDeployment).not.toHaveBeenCalled();
        });

        it('is not blocked by a Work that names the -prod namespace of the same slug', async () => {
            const { service } = createService({
                work: work({
                    deployProvider: 'k8s',
                    slug: 'chairs',
                    websiteRepo: 'awesome-chairs-website',
                }),
                settingsByWork: {
                    'work-1': { clusterSource: 'k8s-works' },
                    'work-2': { clusterSource: 'k8s-works', namespace: 'ever-works-chairs-prod' },
                },
                resolvedSecrets: { clusterSource: { value: 'k8s-works' } },
                candidates: [
                    work({
                        id: 'work-2',
                        userId: 'user-2',
                        slug: 'chairs-copy',
                        deployProvider: 'k8s',
                        websiteRepo: 'awesome-chairs-website',
                    }),
                ],
            });

            await expect(
                service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
            ).resolves.toMatchObject({ status: 'ready', namespace: 'ever-works-chairs-stage' });
        });
    });
});

/**
 * The facade's copy of the Kubernetes plugin's `sanitiseSlug` decides which other Works
 * could share a deleted Work's objects. It must answer exactly what the plugin answers, so
 * it runs the plugin's own case file, which the plugin's `sanitise-slug.spec.ts` also runs:
 * a change to the plugin's rule fails one of the two specs until both agree.
 */
const SANITISE_SLUG_CASES = (
    JSON.parse(
        readFileSync(
            resolve(
                __dirname,
                '../../../../plugins/k8s/src/__tests__/fixtures/sanitise-slug.cases.json',
            ),
            'utf-8',
        ),
    ) as { cases: Array<[string, string]> }
).cases;

describe('normaliseObjectName (parity with the k8s plugin sanitiseSlug)', () => {
    it('reads the plugin’s shared case file', () => {
        expect(SANITISE_SLUG_CASES.length).toBeGreaterThanOrEqual(12);
    });

    it.each(SANITISE_SLUG_CASES)('normalises %j to %j', (input, expected) => {
        expect(normaliseObjectName(input)).toBe(expected);
    });

    it('stays linear over a long inner run of "-"', () => {
        const started = performance.now();
        expect(normaliseObjectName(`a${'-'.repeat(200_000)}a`)).toBe('a-a');
        expect(performance.now() - started).toBeLessThan(2_000);
    });
});
