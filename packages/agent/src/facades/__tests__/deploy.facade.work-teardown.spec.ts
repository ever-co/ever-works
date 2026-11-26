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
        findByDeployProvidersForUserOrSlug: jest.fn().mockResolvedValue(args.candidates ?? []),
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
    };

    beforeEach(() => {
        delete process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG;
        delete process.env.EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG;
        delete process.env.EVER_WORKS_DEPLOY_NAMESPACE;
    });

    afterAll(() => {
        const restore = (key: string, value: string | undefined) => {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        };
        restore('EVER_WORKS_K8S_WORKS_KUBECONFIG', saved.internal);
        restore('EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG', saved.shared);
        restore('EVER_WORKS_DEPLOY_NAMESPACE', saved.base);
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

        expect(prepared).toMatchObject({ status: 'skipped', reason: 'unresolved' });
    });

    it('never throws, even when the Work lookup itself fails', async () => {
        const { service, workRepository } = createService({ work: work() });
        workRepository.findById.mockRejectedValue(new Error('db down'));

        await expect(
            service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' }),
        ).resolves.toEqual({ status: 'skipped', reason: 'unresolved', detail: 'db down' });
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

        it('looks candidates up by owner and slug among the Kubernetes-family providers', async () => {
            const { service, workRepository } = createService({ work: work() });

            await service.prepareWorkDeploymentTeardown({ userId: 'user-1', workId: 'work-1' });

            expect(workRepository.findByDeployProvidersForUserOrSlug).toHaveBeenCalledWith(
                ['ever-works', 'k8s'],
                'user-1',
                'awesome-memes',
            );
        });
    });
});

/**
 * The facade's copy of the Kubernetes plugin's `sanitiseSlug` decides which other Works
 * could share a deleted Work's objects. It must answer exactly what the plugin answers, so
 * these are the plugin's own cases (`packages/plugins/k8s/src/__tests__/sanitise-slug.spec.ts`).
 */
describe('normaliseObjectName (parity with the k8s plugin sanitiseSlug)', () => {
    it.each([
        ['awesome-time-tracking-website', 'awesome-time-tracking-website'],
        ['My Project!!', 'my-project'],
        ['--a--b--', 'a-b'],
        ['___', ''],
        ['-', ''],
        ['', ''],
        ['a - b', 'a-b'],
        ['  spaced  ', 'spaced'],
        ['Ünïcode Name', 'n-code-name'],
        ['a'.repeat(70), 'a'.repeat(63)],
        [`${'a'.repeat(62)}-b`, `${'a'.repeat(62)}-`],
        [`${'a'.repeat(62)}!!b`, `${'a'.repeat(62)}-`],
    ])('normalises %j to %j', (input, expected) => {
        expect(normaliseObjectName(input)).toBe(expected);
    });

    it('stays linear over a long inner run of "-"', () => {
        const started = performance.now();
        expect(normaliseObjectName(`a${'-'.repeat(200_000)}a`)).toBe('a-a');
        expect(performance.now() - started).toBeLessThan(2_000);
    });
});
