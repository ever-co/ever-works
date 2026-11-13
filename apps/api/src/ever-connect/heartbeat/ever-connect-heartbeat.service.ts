import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { EVER_CONNECT_CONNECTION_ROW_ID, EverConnectConnection } from '@ever-works/agent/entities';
import { getBuildInfo } from '../../health/build-info';
import { versionAndChannel } from '../../instance-stats/instance-stats.mapping';
import { EverConnectConnectionChangedEvent } from '../ever-connect.events';
import {
    EverConnectExtensions,
    type EverConnectRoundParticipant,
} from '../ever-connect-extensions';
import { EverConnectService } from '../ever-connect.service';
import { isHeartbeatEnabled } from '../ever-connect.switches';
import { describeFailure, platformFailure } from '../identity/platform-answer';

/** Between two heartbeats (the Ever Platform SDK's cadence: once a day). */
export const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60_000;
/**
 * After a start, a heartbeat is sent at the first round when the last one is
 * older than this, so a new version is known within minutes of a deploy
 * without every replica of a rolling restart sending its own.
 */
export const HEARTBEAT_AFTER_START_MS = 5 * 60_000;
/** After a failed heartbeat, the next try waits at least this long (the route allows one a minute). */
export const HEARTBEAT_RETRY_MS = 5 * 60_000;

/**
 * The heartbeat: `POST /v1/instances/me/heartbeat` with the product version
 * and the product this installation serves, nothing else. Sent on the replica
 * holding the Ever Connect lease, shortly after a start and then once a day,
 * only while the installation is connected (`active`). Ever Platform records
 * when it last heard from the installation; the time is kept here too, for the
 * operator.
 *
 * Does nothing unless `EVER_CONNECT_HEARTBEAT_ENABLED=true`.
 */
@Injectable()
export class EverConnectHeartbeatService implements OnModuleInit, EverConnectRoundParticipant {
    readonly name = 'heartbeat';
    private readonly logger = new Logger(EverConnectHeartbeatService.name);
    private sentSinceStart = false;
    private retryAt = 0;

    constructor(
        @InjectRepository(EverConnectConnection)
        private readonly connections: Repository<EverConnectConnection>,
        private readonly connection: EverConnectService,
        @Optional() private readonly extensions?: EverConnectExtensions,
    ) {}

    onModuleInit(): void {
        if (isHeartbeatEnabled()) this.extensions?.addRoundParticipant(this);
    }

    /** Send a heartbeat when one is due. */
    async round(now: Date = new Date()): Promise<void> {
        if (!isHeartbeatEnabled()) return;
        const row = await this.connection.connection();
        if (row.status !== 'active' || !row.platformInstanceId) return;
        if (now.getTime() < this.retryAt) return;
        const last = row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).getTime() : null;
        const age = last === null ? Number.POSITIVE_INFINITY : now.getTime() - last;
        const due = this.sentSinceStart
            ? age >= HEARTBEAT_INTERVAL_MS
            : age >= HEARTBEAT_AFTER_START_MS;
        if (!due) {
            // Another replica reported after this one started: that covers it.
            if (age < HEARTBEAT_AFTER_START_MS) this.sentSinceStart = true;
            return;
        }
        await this.send(now);
    }

    /** Send one heartbeat now. `true` when Ever Platform answered it. */
    async send(now: Date = new Date()): Promise<boolean> {
        const client = await this.connection.client();
        if (!client) return false;
        try {
            await client.instances.heartbeat({
                version: versionAndChannel(getBuildInfo().version).version,
                serves_products: ['works'],
            } as Parameters<typeof client.instances.heartbeat>[0]);
        } catch (error) {
            const failure = platformFailure(error);
            if (failure.kind === 'problem' && failure.code === 'credential_revoked') {
                await this.connection.ended('revoked');
                return false;
            }
            this.retryAt =
                now.getTime() +
                (failure.kind === 'rate_limited'
                    ? Math.max(failure.retryAfterS * 1000, HEARTBEAT_RETRY_MS)
                    : HEARTBEAT_RETRY_MS);
            this.logger.warn(`The heartbeat was not recorded: ${describeFailure(failure)}`);
            return false;
        }
        this.sentSinceStart = true;
        this.retryAt = 0;
        await this.connections.update(
            { id: EVER_CONNECT_CONNECTION_ROW_ID },
            { lastHeartbeatAt: now },
        );
        return true;
    }

    /**
     * The connection ended: the time of its last heartbeat goes with it, so a new
     * connection reports at its first round.
     */
    @OnEvent(EverConnectConnectionChangedEvent.EVENT_NAME, { async: true })
    async onConnectionChanged(event: EverConnectConnectionChangedEvent): Promise<void> {
        if (event.status !== 'disconnected' && event.status !== 'revoked') return;
        this.sentSinceStart = false;
        this.retryAt = 0;
        await this.connections
            .update({ id: EVER_CONNECT_CONNECTION_ROW_ID }, { lastHeartbeatAt: null })
            .catch(() => undefined);
    }

    /** When Ever Platform last recorded a heartbeat, for the operator. */
    async lastSentAt(): Promise<string | null> {
        const row = await this.connection.connection();
        return row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).toISOString() : null;
    }
}
