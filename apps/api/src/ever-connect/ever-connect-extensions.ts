import { Injectable, Logger } from '@nestjs/common';
import type { EverPlatformAppSyncStatusView } from '@ever-works/contracts';
import { EVER_CONNECT_LEASE_HELD, type EverConnectRoundLease } from './ever-connect-lease.service';

/** One event of the installation's feed, as a handler receives it. */
export interface EverConnectFeedEvent {
    readonly id: string;
    readonly type: string;
    readonly data: unknown;
}

/**
 * A part of Ever Connect that reads some feed events itself. `handle` may
 * throw: the feed then stops at that event and reads it again on its next pass.
 */
export interface EverConnectFeedHandler {
    readonly name: string;
    handles(type: string): boolean;
    handle(event: EverConnectFeedEvent): Promise<void>;
}

/**
 * A part of Ever Connect that has work to do on every round of the worker (on
 * the replica holding the Ever Connect lease, while the installation is
 * connected). `round` should not throw; one that does is logged by name and the
 * other parts still run.
 *
 * A round that makes several requests calls `lease.keep()` between them and
 * stops when it answers `false`: the worker's lease lasts two minutes, and a
 * long round must not run on after another replica has taken it.
 */
export interface EverConnectRoundParticipant {
    readonly name: string;
    round(now: Date, lease: EverConnectRoundLease): Promise<void>;
}

/** What the apps mirror tells the rest of Ever Connect (it lives in a module of its own). */
export interface EverConnectAppSyncReader {
    status(): Promise<EverPlatformAppSyncStatusView | null>;
    runsFor(organizationId: string): Promise<boolean>;
}

/**
 * Where the parts of Ever Connect that are switched on separately (the
 * heartbeat, entitlement documents, tenant links, the apps mirror) join the
 * feed and the worker's round. A part that is switched off never registers, so
 * the feed and the round do exactly what they did without it.
 */
@Injectable()
export class EverConnectExtensions {
    private readonly logger = new Logger(EverConnectExtensions.name);
    private readonly feedHandlers: EverConnectFeedHandler[] = [];
    private readonly participants: EverConnectRoundParticipant[] = [];
    private appSync: EverConnectAppSyncReader | null = null;

    addFeedHandler(handler: EverConnectFeedHandler): void {
        if (!this.feedHandlers.includes(handler)) this.feedHandlers.push(handler);
    }

    addRoundParticipant(participant: EverConnectRoundParticipant): void {
        if (!this.participants.includes(participant)) this.participants.push(participant);
    }

    /** The apps mirror says where it stands and which Organizations it runs for. */
    provideAppSync(reader: EverConnectAppSyncReader): void {
        this.appSync = reader;
    }

    /** Where the apps mirror stands, or `null` when it is switched off. */
    async appSyncStatus(): Promise<EverPlatformAppSyncStatusView | null> {
        return this.appSync ? this.appSync.status().catch(() => null) : null;
    }

    /** Whether the apps mirror runs for an Organization (never while it is switched off). */
    async appSyncRunsFor(organizationId: string): Promise<boolean> {
        return this.appSync ? this.appSync.runsFor(organizationId).catch(() => false) : false;
    }

    /** Whether any registered handler reads this event type. */
    handlesFeedEvent(type: string): boolean {
        return this.feedHandlers.some((handler) => handler.handles(type));
    }

    /** Hand a feed event to every handler that reads its type, in registration order. */
    async dispatchFeedEvent(event: EverConnectFeedEvent): Promise<void> {
        for (const handler of this.feedHandlers) {
            if (handler.handles(event.type)) await handler.handle(event);
        }
    }

    /**
     * Run every participant's round; a failure of one is logged and the next
     * still runs. The lease is renewed before each one, and the round stops
     * there when this replica no longer holds it.
     */
    async runRound(
        now: Date,
        lease: EverConnectRoundLease = EVER_CONNECT_LEASE_HELD,
    ): Promise<void> {
        for (const participant of this.participants) {
            if (!(await lease.keep())) return;
            try {
                await participant.round(now, lease);
            } catch (error) {
                this.logger.warn(
                    `Ever Connect ${participant.name} round failed: ${
                        error instanceof Error ? error.name : 'unknown'
                    }`,
                );
            }
        }
    }
}
