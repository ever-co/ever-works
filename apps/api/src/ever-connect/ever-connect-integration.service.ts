import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, type Repository } from 'typeorm';
import { EverConnectIntegration } from '@ever-works/agent/entities';
import { PluginSecretEncService } from '@ever-works/agent/plugins';
import {
    EverConnectConnectionChangedEvent,
    EverConnectIntegrationChangedEvent,
} from './ever-connect.events';
import { EverConnectService } from './ever-connect.service';
import type {
    EverIdLoginClient,
    EverIdLoginIntegration,
} from './identity/ever-connect-identity.ports';
import { IntegrationHandlerRegistry } from './integrations/integration-handler.registry';

/** The key of Sign in with Ever ID. */
export const EVER_ID_LOGIN = 'ever_id_login';

/** An installation-wide integration's row (no tenant link). */
const INSTANCE_WIDE = '';

/** A tenant link id as Ever Platform issues it (a ULID). */
const LINK_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** One integration as Ever Platform reports it (`IntegrationStateBrief`). */
interface Brief {
    readonly state?: unknown;
    readonly enabled?: unknown;
    readonly consent_id?: unknown;
    readonly scope_version?: unknown;
}

/** One tenant link's state of a per-link integration, as last reported. */
export interface EverConnectLinkIntegrationView {
    readonly linkId: string;
    readonly state: string;
    readonly enabled: boolean;
}

/** What the operator sees of an installation-wide integration. */
export interface EverConnectIntegrationView {
    readonly key: string;
    readonly state: string;
    readonly enabled: boolean;
}

/**
 * The installation's Ever Platform integrations, as Ever Platform reports them
 * (`GET /v1/instances/me/integrations`, re-read on every consent event of the
 * feed). Nothing is turned on here: consent is given in app.ever.co, and an
 * installation-wide integration waits (`pending_operator`) until this
 * installation's administrator accepts it ({@link accept}).
 *
 * It is also where `ever_id_login` keeps the sign-in client it hands over,
 * wrapped like a plugin secret.
 */
@Injectable()
export class EverConnectIntegrationService implements EverIdLoginIntegration {
    private readonly logger = new Logger(EverConnectIntegrationService.name);
    private readonly secrets: PluginSecretEncService;

    constructor(
        @InjectRepository(EverConnectIntegration)
        private readonly integrations: Repository<EverConnectIntegration>,
        private readonly connection: EverConnectService,
        private readonly events: EventEmitter2,
        @Optional() secrets?: PluginSecretEncService,
        @Optional() private readonly handlers?: IntegrationHandlerRegistry,
    ) {
        this.secrets = secrets ?? new PluginSecretEncService();
    }

    /** The installation-wide integrations as last reported. */
    async list(): Promise<EverConnectIntegrationView[]> {
        const rows = await this.integrations.find({
            where: { linkId: INSTANCE_WIDE },
            order: { integrationKey: 'ASC' },
        });
        return rows.map((row) => ({
            key: row.integrationKey,
            state: row.state,
            enabled: row.enabled,
        }));
    }

    /**
     * Read the states from Ever Platform and store them; an installation-wide
     * integration that turned on or off is announced
     * ({@link EverConnectIntegrationChangedEvent}).
     */
    async refresh(): Promise<EverConnectIntegrationView[]> {
        const client = await this.connection.client();
        if (!client) return this.list();
        const answer = (await client.instances.integrations()) as {
            instance?: Record<string, Brief>;
            links?: Record<string, Record<string, Brief>>;
        };
        for (const [key, brief] of Object.entries(answer.instance ?? {})) {
            await this.store(key, brief);
        }
        await this.storeLinks(answer.links ?? {});
        return this.list();
    }

    /**
     * The tenant links' states of a per-link integration that has a handler
     * here (`marketplace_installs`); empty for any other key.
     */
    async linkStates(key: string): Promise<EverConnectLinkIntegrationView[]> {
        const rows = await this.integrations.find({
            where: { linkId: Not(INSTANCE_WIDE), integrationKey: key },
            order: { linkId: 'ASC' },
        });
        return rows.map((row) => ({ linkId: row.linkId, state: row.state, enabled: row.enabled }));
    }

    /** Whether a per-link integration is enabled for one of the installation's tenant links. */
    async enabledForAnyLink(key: string): Promise<boolean> {
        if (!(await this.connection.client())) return false;
        return (await this.linkStates(key)).some((link) => link.enabled);
    }

    /**
     * The administrator accepts (or declines) an installation-wide integration
     * enabled in app.ever.co: `POST /v1/instances/me/integrations/{key}/accept`.
     */
    async accept(key: string, accepted: boolean): Promise<EverConnectIntegrationView[]> {
        const client = await this.connection.client();
        const row = await this.row(key);
        if (!client || !row || row.state !== 'pending_operator' || !row.consentId) {
            throw new NotFoundException({
                code: 'not_pending',
                message: 'No integration waits for an answer here.',
            });
        }
        const brief = (await client.instances.acceptIntegration(
            key,
            { consent_id: row.consentId, accepted },
            `accept-${key}-${randomUUID()}`,
        )) as Brief;
        await this.store(key, brief);
        return this.list();
    }

    // -- EverIdLoginIntegration -------------------------------------------------

    async isEnabled(): Promise<boolean> {
        if (!(await this.connection.client())) return false;
        return (await this.row(EVER_ID_LOGIN))?.enabled === true;
    }

    async readClient(): Promise<EverIdLoginClient | null> {
        const sealed = (await this.row(EVER_ID_LOGIN))?.configEncrypted;
        if (!sealed) return null;
        try {
            const value = JSON.parse(
                this.secrets.decryptValue(sealed),
            ) as Partial<EverIdLoginClient>;
            if (value.issuer && value.clientId && value.clientSecret) {
                return {
                    issuer: value.issuer,
                    clientId: value.clientId,
                    clientSecret: value.clientSecret,
                };
            }
        } catch {
            this.logger.warn('The stored Ever ID client cannot be read');
        }
        return null;
    }

    async writeClient(client: EverIdLoginClient): Promise<void> {
        const row = await this.row(EVER_ID_LOGIN);
        if (!row) throw new Error('ever_id_login is not known here');
        await this.integrations.update(
            { id: row.id },
            { configEncrypted: this.secrets.encryptValue(JSON.stringify(client)) },
        );
    }

    async clearClient(): Promise<void> {
        await this.integrations.update(
            { linkId: INSTANCE_WIDE, integrationKey: EVER_ID_LOGIN },
            { configEncrypted: null },
        );
    }

    /** A connection that ended takes every integration with it. */
    @OnEvent(EverConnectConnectionChangedEvent.EVENT_NAME, { async: true })
    async onConnectionChanged(event: EverConnectConnectionChangedEvent): Promise<void> {
        if (event.status !== 'disconnected' && event.status !== 'revoked') return;
        try {
            const enabled = await this.integrations.find({
                where: { linkId: INSTANCE_WIDE, enabled: true },
            });
            await this.integrations.update(
                { linkId: INSTANCE_WIDE },
                { state: 'disabled', enabled: false, configEncrypted: null, consentId: null },
            );
            for (const row of enabled) this.announce(row.integrationKey, false);
            // The tenant links' states of the integrations with a handler go too.
            const linked = await this.integrations.find({
                where: { linkId: Not(INSTANCE_WIDE), enabled: true },
            });
            await this.integrations.update(
                { linkId: Not(INSTANCE_WIDE) },
                { state: 'disabled', enabled: false, configEncrypted: null, consentId: null },
            );
            for (const row of linked) this.announce(row.integrationKey, false, row.linkId);
        } catch (error) {
            this.logger.warn(
                `Integrations not cleared after the connection ended: ${
                    error instanceof Error ? error.name : 'unknown'
                }`,
            );
        }
    }

    private async store(key: string, brief: Brief): Promise<void> {
        const state = typeof brief.state === 'string' ? brief.state : 'available';
        const enabled = brief.enabled === true;
        const consentId = typeof brief.consent_id === 'string' ? brief.consent_id : null;
        const scopeVersion = typeof brief.scope_version === 'number' ? brief.scope_version : null;
        const existing = await this.row(key);
        if (!existing) {
            await this.integrations
                .createQueryBuilder()
                .insert()
                .into(EverConnectIntegration)
                .values({
                    linkId: INSTANCE_WIDE,
                    integrationKey: key,
                    state,
                    enabled,
                    consentId,
                    scopeVersion,
                })
                .orIgnore()
                .execute();
            if (enabled) this.announce(key, true);
            return;
        }
        await this.integrations.update(
            { id: existing.id },
            {
                state,
                enabled,
                consentId,
                scopeVersion,
                // What an integration handed over goes with it.
                ...(enabled ? {} : { configEncrypted: null }),
            },
        );
        if (existing.enabled !== enabled) this.announce(key, enabled);
    }

    /**
     * Keep the tenant links' states of the per-link integrations that have a
     * handler here; a link Ever Platform no longer lists for one is off.
     * Without a handler, a per-link integration's state is not kept: nothing
     * of it runs here.
     */
    private async storeLinks(links: Record<string, Record<string, Brief>>): Promise<void> {
        for (const key of this.handlers?.perLinkKeys() ?? []) {
            const listed = new Set<string>();
            for (const [linkId, briefs] of Object.entries(links)) {
                const brief = briefs?.[key];
                if (!brief || !LINK_ID.test(linkId)) continue;
                listed.add(linkId);
                await this.storeLink(key, linkId, brief);
            }
            const kept = await this.integrations.find({
                where: { linkId: Not(INSTANCE_WIDE), integrationKey: key },
            });
            for (const row of kept) {
                if (listed.has(row.linkId) || (row.state === 'disabled' && !row.enabled)) continue;
                await this.integrations.update(
                    { id: row.id },
                    { state: 'disabled', enabled: false, consentId: null },
                );
                if (row.enabled) this.announce(key, false, row.linkId);
            }
        }
    }

    private async storeLink(key: string, linkId: string, brief: Brief): Promise<void> {
        const state = typeof brief.state === 'string' ? brief.state : 'available';
        const enabled = brief.enabled === true;
        const consentId = typeof brief.consent_id === 'string' ? brief.consent_id : null;
        const scopeVersion = typeof brief.scope_version === 'number' ? brief.scope_version : null;
        const existing = await this.integrations.findOne({
            where: { linkId, integrationKey: key },
        });
        if (!existing) {
            await this.integrations
                .createQueryBuilder()
                .insert()
                .into(EverConnectIntegration)
                .values({ linkId, integrationKey: key, state, enabled, consentId, scopeVersion })
                .orIgnore()
                .execute();
            if (enabled) this.announce(key, true, linkId);
            return;
        }
        await this.integrations.update(
            { id: existing.id },
            { state, enabled, consentId, scopeVersion },
        );
        if (existing.enabled !== enabled) this.announce(key, enabled, linkId);
    }

    private announce(key: string, enabled: boolean, linkId?: string): void {
        this.events.emit(
            EverConnectIntegrationChangedEvent.EVENT_NAME,
            new EverConnectIntegrationChangedEvent(key, enabled, linkId),
        );
    }

    private row(key: string): Promise<EverConnectIntegration | null> {
        return this.integrations.findOne({ where: { linkId: INSTANCE_WIDE, integrationKey: key } });
    }
}
