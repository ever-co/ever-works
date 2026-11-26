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
 * owner's explicit yes first. One API replica runs it per day (the task lock).
 * The lines carry namespaces, object names and reason codes only.
 */
@Injectable()
export class WorkDeploymentOrphanReportCronService {
    private readonly logger = new Logger(WorkDeploymentOrphanReportCronService.name);

    constructor(
        private readonly deployFacade: DeployFacadeService,
        private readonly taskLockService: DistributedTaskLockService,
    ) {}

    @Cron(WORK_DEPLOYMENT_ORPHAN_REPORT_CRON)
    async runReport(): Promise<void> {
        try {
            await this.taskLockService.runExclusive(
                'deploy:work-deployment-orphan-report',
                () => this.report(),
                {
                    ttlMs: 30 * 60 * 1000,
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
        const summary =
            `Orphaned website deployment report: ${listed} website deployment(s) on ` +
            `${report.clusters.length} cluster(s), ${report.orphans.length} orphaned` +
            (report.unresolvedWorks > 0
                ? `, ${report.unresolvedWorks} Work(s) whose target could not be worked out`
                : '');
        if (report.orphans.length > 0) {
            this.logger.warn(summary);
        } else {
            this.logger.log(summary);
        }
    }
}
