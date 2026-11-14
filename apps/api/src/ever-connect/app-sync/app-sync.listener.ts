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

/** A step of an App's deployment, as far as the mirror reads one: which Work. */
interface AppDeploymentEvent {
    readonly workId?: unknown;
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
 * - Deployments of an App: `app.deploy.started`, `app.deploy.succeeded`,
 *   `app.deploy.failed` and `app.deploy.rolled_back`. The worker that runs an
 *   App's deployment writes its row in another process and reports each step
 *   to the API, which emits it here under these names; the event carries the
 *   Work's id, which is all that is read of it.
 *
 * A change no event announces is picked up by the daily reconciliation.
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

    // One decorator per name: the emitter's `wildcard` option is not assumed.
    @OnEvent('app.deploy.started', { async: true })
    @OnEvent('app.deploy.succeeded', { async: true })
    @OnEvent('app.deploy.failed', { async: true })
    @OnEvent('app.deploy.rolled_back', { async: true })
    async onAppDeployment(payload: AppDeploymentEvent): Promise<void> {
        const workId = typeof payload?.workId === 'string' ? payload.workId.trim() : '';
        // The Organization is read from the Work: the event does not name it.
        if (workId) await this.mirror.workChanged(workId);
    }
}
