import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EVER_INSTALLS_INTEGRATION_KEY } from '@ever-works/contracts';
import { EverConnectIntegrationChangedEvent } from '../ever-connect.events';
import { EverConnectIntegrationService } from '../ever-connect-integration.service';
import {
    type IntegrationHandler,
    IntegrationHandlerRegistry,
} from '../integrations/integration-handler.registry';
import { InstallApprovalService } from './install-approval.service';
import { InstallStatusReporter } from './install-status-reporter.service';

/**
 * `marketplace_installs` on this installation: install requests from
 * apps.ever.co. Registering this handler is what makes the integration
 * offerable in Works (without it, it stays "coming soon"); it exists only in
 * the Ever Connect module, so only with `EVER_CONNECT_ENABLED=true`.
 *
 * - When the integration goes off for every tenant link, the reports still
 *   owed are dropped (logged) and never sent.
 * - Each round of the Ever Connect worker ({@link round}) sends the reports
 *   that are due and reports `removed` for a plugin installed from a request
 *   that was uninstalled here since.
 */
@Injectable()
export class InstallRequestsIntegration implements IntegrationHandler, OnModuleInit {
    readonly key = EVER_INSTALLS_INTEGRATION_KEY;
    private readonly logger = new Logger(InstallRequestsIntegration.name);

    constructor(
        private readonly registry: IntegrationHandlerRegistry,
        private readonly integrations: EverConnectIntegrationService,
        private readonly reporter: InstallStatusReporter,
        private readonly approvals: InstallApprovalService,
    ) {}

    onModuleInit(): void {
        this.registry.register(this);
    }

    @OnEvent(EverConnectIntegrationChangedEvent.EVENT_NAME, { async: true })
    async onIntegrationChanged(event: EverConnectIntegrationChangedEvent): Promise<void> {
        if (event.integrationKey !== this.key || event.enabled) return;
        try {
            if (!(await this.integrations.enabledForAnyLink(this.key))) await this.onDisabled();
        } catch (error) {
            this.logger.warn(`install_request.disable_failed (${errorName(error)})`);
        }
    }

    async onDisabled(): Promise<void> {
        const dropped = await this.reporter.dropOwed('integration_not_enabled').catch(() => 0);
        if (dropped > 0)
            this.logger.warn(`install_request.report_dropped ${dropped} owed report(s)`);
    }

    /** One round of the Ever Connect worker. */
    async round(now = new Date()): Promise<void> {
        await this.approvals.reconcileRemovals();
        await this.reporter.sendDue(now);
    }
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'unknown';
}
