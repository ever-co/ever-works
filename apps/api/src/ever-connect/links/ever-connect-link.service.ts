import { createHash } from 'node:crypto';
import {
    BadRequestException,
    ConflictException,
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleInit,
    Optional,
    UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { codes } from '@ever-co/connect-sdk';
import type { EverPlatformLinkView, EverPlatformOrganizationLinkView } from '@ever-works/contracts';
import { EverConnectLink, type Organization } from '@ever-works/agent/entities';
import { isUniqueConstraintError } from '@ever-works/agent/utils';
import {
    EverConnectConnectionChangedEvent,
    EverConnectLinkChangedEvent,
} from '../ever-connect.events';
import {
    EverConnectExtensions,
    type EverConnectFeedEvent,
    type EverConnectFeedHandler,
} from '../ever-connect-extensions';
import { EverConnectIntegrationService } from '../ever-connect-integration.service';
import { EverConnectService } from '../ever-connect.service';
import { isLinkCodesEnabled } from '../ever-connect.switches';
import {
    EverConnectEntitlementService,
    linkEntitlementSubject,
} from '../entitlements/ever-connect-entitlement.service';
import { describeFailure, platformFailure } from '../identity/platform-answer';

/** A tenant link id as Ever Platform issues it (a ULID). */
const LINK_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The feed events that end a link at Ever Platform. */
const LINK_ENDED_EVENTS: ReadonlySet<string> = new Set([
    'ever.registry.tenant_link.unlinked',
    'ever.registry.tenant_link.orphaned',
]);

function problem(status: number, code: string, message: string): HttpException {
    return new HttpException({ statusCode: status, code, message }, status);
}

/**
 * An Organization's link to its Ever organization, made with a link code.
 *
 * An admin of the Organization gets a link code (`EVL-XXXX-XXXX-XXXX`) in
 * app.ever.co and pastes it here. The installation redeems it
 * (`POST /v1/instances/me/tenant-links`) with the tenant's id and the
 * Organization's slug, nothing else: no name, no e-mail, no member. Ever
 * Platform answers the link and the Ever organization it belongs to, which are
 * kept in `ever_connect_links` (the table a company created from Ever Platform
 * uses too). Removing the link tells Ever Platform
 * (`DELETE /v1/instances/me/tenant-links/{link}`) and archives it here.
 *
 * One Organization has one link; a tenant has one linked Organization; an Ever
 * organization is linked to one Organization of this installation.
 *
 * The routes exist only with `EVER_CONNECT_LINK_CODES_ENABLED=true`.
 */
@Injectable()
export class EverConnectLinkService implements OnModuleInit, EverConnectFeedHandler {
    readonly name = 'links';
    private readonly logger = new Logger(EverConnectLinkService.name);

    constructor(
        @InjectRepository(EverConnectLink) private readonly links: Repository<EverConnectLink>,
        private readonly connection: EverConnectService,
        private readonly integrations: EverConnectIntegrationService,
        private readonly events: EventEmitter2,
        @Optional() private readonly entitlements?: EverConnectEntitlementService,
        @Optional() private readonly extensions?: EverConnectExtensions,
    ) {}

    onModuleInit(): void {
        if (isLinkCodesEnabled()) this.extensions?.addFeedHandler(this);
    }

    /** The Organization's link, with what its entitlement document says. */
    async view(organization: Pick<Organization, 'id'>): Promise<EverPlatformOrganizationLinkView> {
        const connected = (await this.connection.status()).status === 'active';
        const link = await this.active(organization.id);
        if (!link) return { connected, link: null, entitlement: null, appSync: false };
        const entitlement =
            link.platformLinkId && this.entitlements
                ? await this.entitlements.view(linkEntitlementSubject(link.platformLinkId))
                : null;
        // The mirror's own answer: the switch, the consent and its scope version.
        const appSync =
            connected && this.extensions
                ? await this.extensions.appSyncRunsFor(organization.id)
                : false;
        return { connected, link: linkView(link), entitlement, appSync };
    }

    /**
     * Link the Organization with a link code. A code that is not one, an
     * installation that is not connected and an Organization (or tenant) that
     * has a link are refused before any request.
     */
    async link(
        organization: Pick<Organization, 'id' | 'tenantId' | 'slug'>,
        rawCode: string,
    ): Promise<EverPlatformOrganizationLinkView> {
        const code = typeof rawCode === 'string' ? codes.normalize(rawCode) : null;
        if (!code || !codes.isLinkCode(code)) {
            throw new BadRequestException({ code: 'code_invalid', message: 'Not a link code.' });
        }
        const connection = await this.connection.connection();
        const client = await this.connection.client();
        if (!client || connection.status !== 'active' || !connection.platformInstanceId) {
            throw new ConflictException({
                code: 'not_connected',
                message: 'This installation is not connected to Ever Platform.',
            });
        }
        if (await this.active(organization.id)) {
            throw new ConflictException({
                code: 'already_linked',
                message: 'This organization is already linked.',
            });
        }
        const inTenant = await this.links.findOne({
            where: { tenantId: organization.tenantId, status: 'active' },
        });
        if (inTenant) {
            throw new ConflictException({
                code: 'tenant_already_linked',
                message: 'Another organization of this account is already linked.',
            });
        }

        const productOrgRef = organization.slug;
        let created: { id: string; org_id: string };
        try {
            created = await client.instances.tenantLinks.create(
                {
                    link_code: code,
                    product: 'works',
                    product_tenant_id: organization.tenantId,
                    product_org_id: productOrgRef,
                } as Parameters<typeof client.instances.tenantLinks.create>[0],
                createHash('sha256')
                    .update(
                        `link|${connection.platformInstanceId}|${organization.tenantId}|${productOrgRef}|${code}`,
                    )
                    .digest('hex'),
            );
        } catch (error) {
            throw await this.refused(error, 'The link code was refused.');
        }
        if (!LINK_ID.test(created.id) || typeof created.org_id !== 'string' || !created.org_id) {
            this.logger.warn('Ever Platform answered a link without its ids');
            throw problem(
                HttpStatus.BAD_GATEWAY,
                'platform_unreachable',
                'Ever Platform could not be reached.',
            );
        }

        try {
            await this.store(organization, productOrgRef, created);
        } catch (error) {
            if (!isUniqueConstraintError(error)) throw error;
            // Another request linked this Organization, this tenant or this Ever
            // organization meanwhile: the link just made is not used.
            await client.instances.tenantLinks.remove(created.id).catch(() => undefined);
            throw new ConflictException({
                code: 'already_linked',
                message: 'This organization, or that Ever organization, is already linked.',
            });
        }
        this.logger.log(`ever_connect.link.created ${created.id}`);

        const stored = await this.active(organization.id);
        // What the link has on Ever Platform (and its handle), and which
        // integrations are on for it: best effort, read again on every round.
        if (stored && this.entitlements?.isEnabled()) {
            await this.entitlements.refreshLink(stored).catch(() => undefined);
        }
        await this.integrations.refresh().catch(() => undefined);
        this.events.emit(
            EverConnectLinkChangedEvent.EVENT_NAME,
            new EverConnectLinkChangedEvent(organization.id, 'linked', created.id),
        );
        return this.view(organization);
    }

    /**
     * Remove the Organization's link. Ever Platform is told first; when it
     * cannot be reached the link stays, so the two sides never disagree (try
     * again, or remove the link in app.ever.co). An installation that is not
     * connected any more just archives the link here.
     */
    async unlink(
        organization: Pick<Organization, 'id'>,
    ): Promise<EverPlatformOrganizationLinkView> {
        const link = await this.active(organization.id);
        if (!link) {
            throw new NotFoundException({
                code: 'not_linked',
                message: 'This organization is not linked.',
            });
        }
        const client = await this.connection.client();
        if (client && link.platformLinkId) {
            try {
                await client.instances.tenantLinks.remove(link.platformLinkId);
            } catch (error) {
                const failure = platformFailure(error);
                // Gone there already: the same outcome.
                if (!(failure.kind === 'problem' && failure.status === 404)) {
                    throw await this.refused(error, 'The link could not be removed.');
                }
            }
        }
        await this.archive(link);
        return this.view(organization);
    }

    // -- the feed ---------------------------------------------------------------

    handles(type: string): boolean {
        return LINK_ENDED_EVENTS.has(type);
    }

    /** A link ended at Ever Platform (removed in app.ever.co, or orphaned): it ends here too. */
    async handle(event: EverConnectFeedEvent): Promise<void> {
        const data = (event.data ?? {}) as { tenant_link_id?: unknown; id?: unknown };
        const linkId = typeof data.tenant_link_id === 'string' ? data.tenant_link_id : data.id;
        if (typeof linkId !== 'string' || !LINK_ID.test(linkId)) return;
        const link = await this.links.findOne({
            where: { platformLinkId: linkId, status: 'active' },
        });
        if (link) await this.archive(link);
    }

    /** The connection ended: Ever Platform ends the installation's links, so they end here. */
    @OnEvent(EverConnectConnectionChangedEvent.EVENT_NAME, { async: true })
    async onConnectionChanged(event: EverConnectConnectionChangedEvent): Promise<void> {
        if (event.status !== 'disconnected' && event.status !== 'revoked') return;
        try {
            for (const link of await this.links.find({ where: { status: 'active' } })) {
                await this.archive(link);
            }
        } catch (error) {
            this.logger.warn(
                `Links not archived after the connection ended: ${
                    error instanceof Error ? error.name : 'unknown'
                }`,
            );
        }
    }

    // -- internals --------------------------------------------------------------

    private active(organizationId: string): Promise<EverConnectLink | null> {
        return this.links.findOne({ where: { organizationId, status: 'active' } });
    }

    /** Keep the link: a new row, or the Organization's archived one made active again. */
    private async store(
        organization: Pick<Organization, 'id' | 'tenantId'>,
        productOrgRef: string,
        created: { id: string; org_id: string },
    ): Promise<void> {
        const values = {
            tenantId: organization.tenantId,
            everOrgId: created.org_id,
            // Known once the link's entitlement document is read.
            handle: '',
            platformLinkId: created.id,
            productOrgRef,
            createdVia: 'link_code' as const,
            status: 'active' as const,
        };
        const archived = await this.links.findOne({ where: { organizationId: organization.id } });
        if (archived) {
            // The row is the Organization's: a new link starts its dates again.
            await this.links.update({ id: archived.id }, { ...values, createdAt: new Date() });
            return;
        }
        await this.links.insert({ organizationId: organization.id, ...values });
    }

    private async archive(link: EverConnectLink): Promise<void> {
        await this.links.update({ id: link.id }, { status: 'archived' });
        await this.entitlements?.forgetLink(link.platformLinkId).catch(() => undefined);
        this.logger.log(`ever_connect.link.removed ${link.platformLinkId ?? link.id}`);
        this.events.emit(
            EverConnectLinkChangedEvent.EVENT_NAME,
            new EverConnectLinkChangedEvent(link.organizationId, 'unlinked', link.platformLinkId),
        );
    }

    /** How a failed call to Ever Platform is answered here. */
    private async refused(error: unknown, message: string): Promise<Error> {
        const failure = platformFailure(error);
        this.logger.warn(`${message} (${describeFailure(failure)})`);
        if (failure.kind === 'problem' && failure.code === 'credential_revoked') {
            await this.connection.ended('revoked');
            return new ConflictException({
                code: 'not_connected',
                message: 'This installation is not connected to Ever Platform.',
            });
        }
        if (failure.kind === 'rate_limited') {
            return problem(
                HttpStatus.TOO_MANY_REQUESTS,
                'rate_limited',
                'Too many attempts; try again later.',
            );
        }
        if (failure.kind === 'problem' && failure.status === 409) {
            return new ConflictException({ code: failure.code, message });
        }
        if (failure.kind === 'problem' && failure.status >= 400 && failure.status < 500) {
            return new UnprocessableEntityException({ code: failure.code, message });
        }
        if (failure.kind === 'refused') {
            return new UnprocessableEntityException({ code: failure.code, message });
        }
        return problem(
            HttpStatus.BAD_GATEWAY,
            'platform_unreachable',
            'Ever Platform could not be reached.',
        );
    }
}

function linkView(link: EverConnectLink): EverPlatformLinkView {
    return {
        everOrgId: link.everOrgId,
        handle: link.handle ? link.handle : null,
        createdVia: link.createdVia,
        linkedAt: new Date(link.createdAt).toISOString(),
    };
}
