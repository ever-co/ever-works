import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
    DeploymentCompletedEvent,
    DeploymentDispatchedEvent,
    DeploymentFailedEvent,
    WorkCreatedEvent,
    WorkStatusChangedEvent,
} from '@ever-works/agent/events';
import { AppSyncService } from './app-sync.service';

/** A domain event, as far as the mirror reads one: which Work, of which Organization. */
interface WorkDomainEvent {
    readonly organizationId?: string | null;
    readonly aggregate?: { readonly type?: string; readonly id?: string };
}

/**
 * What tells the apps mirror that a Work changed. Each listener only names the
 * Work ({@link AppSyncService.workChanged}); nothing of the event is kept or
 * sent, and the worker reads the Work as it is when it sends.
 *
 * - Works: the recorded domain events `work.created`, `work.updated`,
 *   `work.archived` and `work.deleted` (emitted in process as `domain.<type>`
 *   once they are committed), and the direct `work.created` /
 *   `work.status.changed` events for an installation whose domain-event relay
 *   is off.
 * - Deployments: `deployment.dispatched`, `deployment.completed` and
 *   `deployment.failed`.
 *
 * A change no event announces (a deployment of an App, a deployment row
 * written by a worker process) is picked up by the daily reconciliation.
 *
 * The listeners exist only with `EVER_CONNECT_APP_SYNC_ENABLED=true`, and
 * queue nothing for an Organization the mirror does not run for.
 */
@Injectable()
export class AppSyncListener {
    private readonly logger = new Logger(AppSyncListener.name);

    constructor(private readonly mirror: AppSyncService) {}

    @OnEvent('domain.work.created', { async: true })
    @OnEvent('domain.work.updated', { async: true })
    @OnEvent('domain.work.archived', { async: true })
    @OnEvent('domain.work.deleted', { async: true })
    async onWorkDomainEvent(event: WorkDomainEvent): Promise<void> {
        const workId = event?.aggregate?.type === 'work' ? event.aggregate.id : undefined;
        if (!workId) {
            // Not a Work's event after all (its shape changed): said once per
            // event, and the daily reconciliation still sends the Work.
            this.logger.debug('A Work event without a Work id was not queued for the apps mirror');
            return;
        }
        await this.mirror.workChanged(workId, event.organizationId ?? null);
    }

    @OnEvent(WorkCreatedEvent.EVENT_NAME, { async: true })
    async onWorkCreated(event: WorkCreatedEvent): Promise<void> {
        if (event?.work?.id) {
            await this.mirror.workChanged(event.work.id, event.work.organizationId ?? null);
        }
    }

    @OnEvent(WorkStatusChangedEvent.EVENT_NAME, { async: true })
    async onWorkStatusChanged(event: WorkStatusChangedEvent): Promise<void> {
        if (event?.workId) await this.mirror.workChanged(event.workId);
    }

    @OnEvent(DeploymentDispatchedEvent.EVENT_NAME, { async: true })
    @OnEvent(DeploymentCompletedEvent.EVENT_NAME, { async: true })
    @OnEvent(DeploymentFailedEvent.EVENT_NAME, { async: true })
    async onDeployment(
        event: DeploymentDispatchedEvent | DeploymentCompletedEvent | DeploymentFailedEvent,
    ): Promise<void> {
        const work = event?.payload?.work;
        if (work?.id) await this.mirror.workChanged(work.id, work.organizationId ?? null);
    }
}
