import type { WorkDeploymentOrphanReport } from '@ever-works/agent/facades';
import { WorkDeploymentOrphanReportCronService } from './work-deployment-orphan-report-cron.service';

/**
 * The daily orphaned website deployment report only LOGS: it never removes
 * anything, runs on one replica per day, and a failure never escapes the tick.
 */
function makeService(report: WorkDeploymentOrphanReport | Error) {
    const deployFacade = {
        reportOrphanedWorkDeployments: jest.fn(async () => {
            if (report instanceof Error) throw report;
            return report;
        }),
        prepareWorkDeploymentTeardown: jest.fn(),
    };
    const taskLockService = {
        runExclusive: jest.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
    };
    const service = new WorkDeploymentOrphanReportCronService(
        deployFacade as any,
        taskLockService as any,
    );
    const logger = (service as unknown as { logger: Record<string, jest.Mock> }).logger;
    const lines: Record<'log' | 'warn' | 'error' | 'debug', string[]> = {
        log: [],
        warn: [],
        error: [],
        debug: [],
    };
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
        jest.spyOn(logger, level).mockImplementation((message: unknown) => {
            lines[level].push(String(message));
        });
    }
    return { service, deployFacade, taskLockService, lines };
}

describe('WorkDeploymentOrphanReportCronService', () => {
    it('names each orphan, says nothing was removed, and never asks for a teardown', async () => {
        const { service, deployFacade, taskLockService, lines } = makeService({
            clusters: [{ names: ['k8s-works'], listed: 3 }],
            orphans: [
                { cluster: 'k8s-works', namespace: 'ever-works-gone-prod', name: 'gone-website' },
            ],
            unresolvedWorks: 0,
        });

        await service.runReport();

        expect(taskLockService.runExclusive).toHaveBeenCalledWith(
            'deploy:work-deployment-orphan-report',
            expect.any(Function),
            expect.objectContaining({ ttlMs: expect.any(Number) }),
        );
        expect(lines.warn).toEqual([
            "Orphaned website deployment ever-works-gone-prod/gone-website on k8s-works: no Work deploys there. Nothing was removed; removing it needs the owner's explicit yes",
            'Orphaned website deployment report: 3 website deployment(s) on 1 cluster(s), 1 orphaned',
        ]);
        expect(deployFacade.prepareWorkDeploymentTeardown).not.toHaveBeenCalled();
    });

    it('logs a quiet summary when nothing is orphaned', async () => {
        const { service, lines } = makeService({
            clusters: [{ names: ['ever-works'], listed: 2 }],
            orphans: [],
            unresolvedWorks: 1,
        });

        await service.runReport();

        expect(lines.warn).toEqual([]);
        expect(lines.log).toEqual([
            'Orphaned website deployment report: 2 website deployment(s) on 1 cluster(s), 0 orphaned, 1 Work(s) whose target could not be worked out',
        ]);
    });

    it('warns about a cluster it could not list, by reason code', async () => {
        const { service, lines } = makeService({
            clusters: [
                { names: ['k8s-works-shared', 'ever-works'], listed: 0, failed: 'UNAUTHORIZED' },
            ],
            orphans: [],
            unresolvedWorks: 0,
        });

        await service.runReport();

        expect(lines.warn).toContain(
            'Orphaned website deployment report: could not list k8s-works-shared+ever-works (UNAUTHORIZED)',
        );
    });

    it('says in the summary how many clusters could not be listed, as a warning', async () => {
        const { service, lines } = makeService({
            clusters: [
                { names: ['k8s-works'], listed: 0, failed: 'TIMEOUT' },
                { names: ['ever-works'], listed: 2 },
            ],
            orphans: [],
            unresolvedWorks: 0,
        });

        await service.runReport();

        expect(lines.log).toEqual([]);
        expect(lines.warn).toContain(
            'Orphaned website deployment report: 2 website deployment(s) on 2 cluster(s), 0 orphaned, 1 cluster(s) could not be listed',
        );
    });

    it('warns when the Kubernetes plugin cannot list, since that is not "no orphans"', async () => {
        const { service, lines } = makeService({
            skipped: 'unsupported',
            clusters: [],
            orphans: [],
            unresolvedWorks: 0,
        });

        await service.runReport();

        expect(lines.warn).toEqual([
            'Orphaned website deployment report skipped: the Kubernetes plugin cannot list its website deployments',
        ]);
    });

    it('does nothing but a debug line where this environment does not own the clusters', async () => {
        const { service, lines } = makeService({
            skipped: 'not_cluster_owner',
            clusters: [],
            orphans: [],
            unresolvedWorks: 0,
        });

        await service.runReport();

        expect(lines.warn).toEqual([]);
        expect(lines.log).toEqual([]);
        expect(lines.debug).toEqual([
            'Orphaned website deployment report skipped: not_cluster_owner',
        ]);
    });

    it('caps the task lock so a hung run cannot keep the next day out', async () => {
        const { service, taskLockService } = makeService({
            skipped: 'no_cluster',
            clusters: [],
            orphans: [],
            unresolvedWorks: 0,
        });

        await service.runReport();

        expect(taskLockService.runExclusive).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(Function),
            expect.objectContaining({ ttlMs: 30 * 60 * 1000, maxLifetimeMs: 30 * 60 * 1000 }),
        );
    });

    it('names at most 50 orphans and counts the rest', async () => {
        const orphans = Array.from({ length: 53 }, (_, i) => ({
            cluster: 'ever-works',
            namespace: 'ever-works-tenants-u1',
            name: `site-${i}`,
        }));
        const { service, lines } = makeService({
            clusters: [{ names: ['ever-works'], listed: 53 }],
            orphans,
            unresolvedWorks: 0,
        });

        await service.runReport();

        expect(
            lines.warn.filter((line) =>
                line.startsWith('Orphaned website deployment ever-works-tenants-u1/'),
            ),
        ).toHaveLength(50);
        expect(lines.warn).toContain('Orphaned website deployment report: 3 more not named here');
    });

    it('says why it was skipped', async () => {
        const unreadable = makeService({
            skipped: 'works_unreadable',
            detail: 'ECONNREFUSED',
            clusters: [],
            orphans: [],
            unresolvedWorks: 0,
        });
        await unreadable.service.runReport();
        expect(unreadable.lines.warn).toEqual([
            'Orphaned website deployment report skipped: the Works could not be loaded (ECONNREFUSED)',
        ]);

        const lookupFailed = makeService({
            skipped: 'no_cluster',
            detail: 'EACCES',
            clusters: [],
            orphans: [],
            unresolvedWorks: 0,
        });
        await lookupFailed.service.runReport();
        expect(lookupFailed.lines.warn).toEqual([
            'Orphaned website deployment report skipped: no_cluster (EACCES)',
        ]);

        const noCluster = makeService({
            skipped: 'no_cluster',
            clusters: [],
            orphans: [],
            unresolvedWorks: 0,
        });
        await noCluster.service.runReport();
        expect(noCluster.lines.warn).toEqual([]);
        expect(noCluster.lines.debug).toEqual([
            'Orphaned website deployment report skipped: no_cluster',
        ]);
    });

    it('never lets a failure escape the tick, and logs no error message body', async () => {
        const { service, lines } = makeService(
            Object.assign(new TypeError('db down at postgres://admin:hunter2@db'), {}),
        );

        await expect(service.runReport()).resolves.toBeUndefined();
        expect(lines.error).toEqual(['The orphaned website deployment report failed: TypeError']);
    });
});
