import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { DeployFacadeService } from '@ever-works/agent/facades';

/** Once a day, at a quiet hour (UTC). */
export const WORK_DEPLOYMENT_ORPHAN_REPORT_CRON = '25 5 * * *';

/** The most orphans named one per line in a run; the rest are counted. */
const MAX_ORPHAN_LINES = 50;

/**
 * The daily REPORT of website deployments on the platform's clusters that no
 * Work accounts for ({@link DeployFacadeService.reportOrphanedWorkDeployments}).
 *
 * A Work delete removes its site's Ingress, Service, Deployment and Secrets,
 * but it skips them when another Work may share them, and a removal can fail
 * or be cut short. Nothing else records that, so this report names what such a
 * delete left running (the `*.ever.works` wildcard keeps a leftover Ingress
 * public).
 *
 * It only logs. It never removes anything: removing what it names needs the
 * owner's explicit yes first. One API replica runs it per day (the task lock,
 * capped at 30 minutes; each cluster list is capped at 60 s by the facade).
 * The lines carry namespaces, object names and reason codes only.
 *
 * It runs only where `EVER_WORKS_K8S_WORKS_CLUSTER_OWNER=true`: it compares a
 * whole cluster with this environment's Works alone, and dev, stage and prod
 * may share one cluster. Elsewhere the tick does nothing (a debug line).
 */
@Injectable()
export class WorkDeploymentOrphanReportCronService {
    private readonly logger = new Logger(WorkDeploymentOrphanReportCronService.name);

    constructor(
        private readonly deployFacade: DeployFacadeService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(WORK_DEPLOYMENT_ORPHAN_REPORT_CRON, { timeZone: 'UTC' })
    async runReport(): Promise<void> {
        try {
            await this.taskLockService.runExclusive(
                'deploy:work-deployment-orphan-report',
                () => this.report(),
                {
                    ttlMs: 30 * 60 * 1000,
                    // A run lists a few clusters and reads the Works: minutes at
                    // most. Past this the lease is not renewed, so a hung run
                    // cannot keep the next day's run out.
                    maxLifetimeMs: 30 * 60 * 1000,
                    onLocked: () =>
                        this.logger.debug(
                            'Skipping the orphaned website deployment report: another instance holds the task lock',
                        ),
                },
            );
        } catch (error) {
            this.logger.error(
                `The orphaned website deployment report failed: ${error instanceof Error ? error.name : 'unknown'}`,
            );
        }
    }

    /** One run: the report, logged. Never removes anything. */
    async report(): Promise<void> {
        const report = await this.deployFacade.reportOrphanedWorkDeployments();
        if (report.skipped === 'works_unreadable') {
            this.logger.warn(
                `Orphaned website deployment report skipped: the Works could not be loaded (${report.detail ?? 'unknown'})`,
            );
            return;
        }
        if (report.skipped && report.detail) {
            // A lookup failed (for `no_cluster`, the platform credential lookup itself).
            this.logger.warn(
                `Orphaned website deployment report skipped: ${report.skipped} (${report.detail})`,
            );
            return;
        }
        if (report.skipped === 'unsupported') {
            // The k8s plugin is not loaded, or is a build without the list: the
            // report cannot run, which is not the same as finding nothing.
            this.logger.warn(
                'Orphaned website deployment report skipped: the Kubernetes plugin cannot list its website deployments',
            );
            return;
        }
        if (report.skipped) {
            this.logger.debug(`Orphaned website deployment report skipped: ${report.skipped}`);
            return;
        }

        for (const cluster of report.clusters) {
            if (cluster.failed) {
                this.logger.warn(
                    `Orphaned website deployment report: could not list ${cluster.names.join('+')} (${cluster.failed})`,
                );
            }
        }
        for (const orphan of report.orphans.slice(0, MAX_ORPHAN_LINES)) {
            this.logger.warn(
                `Orphaned website deployment ${orphan.namespace}/${orphan.name} on ${orphan.cluster}: ` +
                    `no Work deploys there. Nothing was removed; removing it needs the owner's explicit yes`,
            );
        }
        if (report.orphans.length > MAX_ORPHAN_LINES) {
            this.logger.warn(
                `Orphaned website deployment report: ${report.orphans.length - MAX_ORPHAN_LINES} more not named here`,
            );
        }

        const listed = report.clusters.reduce((sum, cluster) => sum + cluster.listed, 0);
        const failed = report.clusters.filter((cluster) => cluster.failed).length;
        const summary =
            `Orphaned website deployment report: ${listed} website deployment(s) on ` +
            `${report.clusters.length} cluster(s), ${report.orphans.length} orphaned` +
            (failed > 0 ? `, ${failed} cluster(s) could not be listed` : '') +
            (report.unresolvedWorks > 0
                ? `, ${report.unresolvedWorks} Work(s) whose target could not be worked out`
                : '');
        if (report.orphans.length > 0 || failed > 0) {
            this.logger.warn(summary);
        } else {
            this.logger.log(summary);
        }
    }
}
