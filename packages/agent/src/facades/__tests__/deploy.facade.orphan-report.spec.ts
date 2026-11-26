import { DeployFacadeService } from '../deploy.facade';

/**
 * `DeployFacadeService.reportOrphanedWorkDeployments` — the website deployments on the
 * platform's own clusters that no Work accounts for, which is what a skipped or failed
 * Work-delete teardown leaves running.
 *
 * REPORT ONLY: these tests pin that it lists and compares, never removes, never throws,
 * and names only namespaces, object names and reason codes.
 */

const MANAGED_KUBECONFIG = 'managed-tenant-kubeconfig';
const INTERNAL_KUBECONFIG = 'internal-works-kubeconfig';
const SHARED_KUBECONFIG = 'shared-works-kubeconfig';

function work(fixture: {
    id: string;
    userId?: string;
    slug?: string;
    kind?: string;
    deployProvider?: string;
    websiteRepo: string;
    deployProjectId?: string | null;
}): Record<string, unknown> {
    const userId = fixture.userId ?? 'user-1';
    return {
        id: fixture.id,
        userId,
        slug: fixture.slug ?? fixture.id,
        kind: fixture.kind ?? 'directory',
        deployProvider: fixture.deployProvider ?? 'ever-works',
        deployProjectId: fixture.deployProjectId ?? null,
        managedSubdomain: null,
        user: { id: userId, isPlatformAdmin: true },
        getWebsiteRepo: () => fixture.websiteRepo,
        getRepoOwner: () => 'ever-works',
    };
}

function createService(args: {
    works?: Array<Record<string, unknown>>;
    /** What each kubeconfig's list answers (an Error rejects). */
    listings?: Record<string, Array<{ location: string; name: string }> | Error>;
    settingsByWork?: Record<string, Record<string, unknown>>;
    pluginOverrides?: Record<string, unknown>;
    managedKubeconfig?: string | null;
}) {
    const listWorkDeployments = jest.fn(async (kubeconfig: string) => {
        const listing = args.listings?.[kubeconfig] ?? [];
        if (listing instanceof Error) throw listing;
        return listing;
    });
    const removeWorkDeployment = jest.fn();
    const plugin = {
        id: 'k8s',
        name: 'Kubernetes',
        capabilities: ['deployment'],
        listWorkDeployments,
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
        getSettings: jest.fn(
            async (_pluginId: string, options: { workId?: string }) =>
                args.settingsByWork?.[options.workId ?? ''] ?? {},
        ),
        getResolvedSettings: jest.fn(async (_pluginId: string, options: { workId?: string }) => {
            const values = args.settingsByWork?.[options.workId ?? ''] ?? {};
            return Object.fromEntries(
                Object.keys(values).map((key) => [key, { value: values[key], source: 'work' }]),
            );
        }),
    };
    const workRepository = {
        findByDeployProviders: jest.fn().mockResolvedValue(args.works ?? []),
        update: jest.fn(),
        delete: jest.fn(),
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
    return { service, listWorkDeployments, removeWorkDeployment, workRepository, settingsService };
}

describe('DeployFacadeService.reportOrphanedWorkDeployments', () => {
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

    it('names the deployments no Work accounts for, and removes nothing', async () => {
        const { service, listWorkDeployments, removeWorkDeployment } = createService({
            works: [work({ id: 'w1', websiteRepo: 'memes-website' })],
            listings: {
                [MANAGED_KUBECONFIG]: [
                    { location: 'ever-works-tenants-user-1', name: 'memes-website' },
                    { location: 'ever-works-tenants-user-1', name: 'deleted-website' },
                ],
            },
        });

        const report = await service.reportOrphanedWorkDeployments();

        expect(report).toEqual({
            clusters: [{ names: ['ever-works'], listed: 2 }],
            orphans: [
                {
                    cluster: 'ever-works',
                    namespace: 'ever-works-tenants-user-1',
                    name: 'deleted-website',
                },
            ],
            unresolvedWorks: 0,
        });
        expect(listWorkDeployments).toHaveBeenCalledWith(MANAGED_KUBECONFIG, {
            settingsOverride: {},
            kubeContextOverride: null,
        });
        expect(removeWorkDeployment).not.toHaveBeenCalled();
    });

    it('lists each distinct credential once, with the names that share it', async () => {
        // Path B: the managed ever-works kubeconfig IS the shared cluster's.
        process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG = INTERNAL_KUBECONFIG;
        process.env.EVER_WORKS_K8S_WORKS_SHARED_KUBECONFIG = SHARED_KUBECONFIG;
        const { service, listWorkDeployments } = createService({ managedKubeconfig: null });

        const report = await service.reportOrphanedWorkDeployments();

        expect(report.clusters).toEqual([
            { names: ['k8s-works'], listed: 0 },
            { names: ['k8s-works-shared', 'ever-works'], listed: 0 },
        ]);
        expect(listWorkDeployments.mock.calls).toEqual([
            [
                INTERNAL_KUBECONFIG,
                { settingsOverride: { clusterSource: 'k8s-works' }, kubeContextOverride: null },
            ],
            [
                SHARED_KUBECONFIG,
                {
                    settingsOverride: { clusterSource: 'k8s-works-shared' },
                    kubeContextOverride: null,
                },
            ],
        ]);
    });

    it('accounts for a k8s Work’s explicit and slug-derived namespaces, and any Work’s last deploy', async () => {
        process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG = INTERNAL_KUBECONFIG;
        const { service } = createService({
            managedKubeconfig: null,
            works: [
                work({
                    id: 'w-derived',
                    slug: 'chairs',
                    deployProvider: 'k8s',
                    websiteRepo: 'chairs-website',
                }),
                work({ id: 'w-explicit', deployProvider: 'k8s', websiteRepo: 'mcp-website' }),
                work({
                    id: 'w-moved',
                    deployProvider: 'k8s',
                    websiteRepo: 'tools-website',
                    deployProjectId: 'ever-works-old-tools-prod/tools-website',
                }),
            ],
            settingsByWork: {
                'w-derived': { clusterSource: 'k8s-works' },
                'w-explicit': {
                    clusterSource: 'k8s-works',
                    namespace: 'ever-works-mcpserver-prod',
                },
                'w-moved': { clusterSource: 'k8s-works' },
            },
            listings: {
                [INTERNAL_KUBECONFIG]: [
                    { location: 'ever-works-chairs-prod', name: 'chairs-website' },
                    { location: 'ever-works-mcpserver-prod', name: 'mcp-website' },
                    { location: 'ever-works-old-tools-prod', name: 'tools-website' },
                    { location: 'ever-works-gone-prod', name: 'gone-website' },
                ],
            },
        });

        const report = await service.reportOrphanedWorkDeployments();

        expect(report.orphans).toEqual([
            { cluster: 'k8s-works', namespace: 'ever-works-gone-prod', name: 'gone-website' },
        ]);
    });

    it('reads no settings for an ever-works Work: its namespace is its owner’s tenant namespace', async () => {
        const { service, settingsService } = createService({
            works: [work({ id: 'w1', websiteRepo: 'memes-website' })],
        });

        await service.reportOrphanedWorkDeployments();

        expect(settingsService.getSettings).not.toHaveBeenCalled();
    });

    it('does not call a deployment an orphan when a Work with that object name could not be resolved', async () => {
        const { service, settingsService } = createService({
            works: [work({ id: 'w-k8s', deployProvider: 'k8s', websiteRepo: 'memes-website' })],
            listings: {
                [MANAGED_KUBECONFIG]: [{ location: 'ever-works-somewhere', name: 'memes-website' }],
            },
        });
        settingsService.getSettings.mockRejectedValue(new Error('settings unavailable'));

        const report = await service.reportOrphanedWorkDeployments();

        expect(report.orphans).toEqual([]);
        expect(report.unresolvedWorks).toBe(1);
    });

    it('ignores App Works', async () => {
        const { service } = createService({
            works: [work({ id: 'w-app', kind: 'app', websiteRepo: 'memes-website' })],
            listings: {
                [MANAGED_KUBECONFIG]: [
                    { location: 'ever-works-tenants-user-1', name: 'memes-website' },
                ],
            },
        });

        const report = await service.reportOrphanedWorkDeployments();

        expect(report.orphans).toHaveLength(1);
    });

    it('reports a failed list by its reason code and goes on with the next cluster', async () => {
        process.env.EVER_WORKS_K8S_WORKS_KUBECONFIG = INTERNAL_KUBECONFIG;
        const { service } = createService({
            listings: {
                [INTERNAL_KUBECONFIG]: Object.assign(
                    new Error('ingresses is forbidden: token abc123'),
                    { code: 'UNAUTHORIZED' },
                ),
                [MANAGED_KUBECONFIG]: [
                    { location: 'ever-works-tenants-user-9', name: 'x-website' },
                ],
            },
        });

        const report = await service.reportOrphanedWorkDeployments();

        expect(report.clusters).toEqual([
            { names: ['k8s-works'], listed: 0, failed: 'UNAUTHORIZED' },
            { names: ['ever-works'], listed: 1 },
        ]);
        expect(JSON.stringify(report)).not.toContain('abc123');
        expect(report.orphans).toHaveLength(1);
    });

    it('skips as unsupported when the k8s plugin cannot list its deployments', async () => {
        const { service } = createService({ pluginOverrides: { listWorkDeployments: undefined } });

        await expect(service.reportOrphanedWorkDeployments()).resolves.toEqual({
            skipped: 'unsupported',
            clusters: [],
            orphans: [],
            unresolvedWorks: 0,
        });
    });

    it('skips when the platform holds no cluster credential', async () => {
        const { service, listWorkDeployments } = createService({ managedKubeconfig: null });

        await expect(service.reportOrphanedWorkDeployments()).resolves.toMatchObject({
            skipped: 'no_cluster',
        });
        expect(listWorkDeployments).not.toHaveBeenCalled();
    });

    it('lists nothing when the Works cannot be loaded, since everything would look orphaned', async () => {
        const { service, workRepository, listWorkDeployments } = createService({});
        workRepository.findByDeployProviders.mockRejectedValue(
            Object.assign(new Error('db down at postgres://admin:hunter2@db'), {
                code: 'ECONNREFUSED',
            }),
        );

        await expect(service.reportOrphanedWorkDeployments()).resolves.toEqual({
            skipped: 'works_unreadable',
            detail: 'ECONNREFUSED',
            clusters: [],
            orphans: [],
            unresolvedWorks: 0,
        });
        expect(listWorkDeployments).not.toHaveBeenCalled();
    });
});
