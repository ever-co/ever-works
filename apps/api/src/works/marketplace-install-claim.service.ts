import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { normalizeEverPlatformInstallId } from '@ever-works/contracts';
import type { CreateWorkDto } from '@ever-works/agent/dto';
import { EverConnectLink } from '@ever-works/agent/entities';
import { isBlueprintHandoffEnabled } from '../ever-connect/ever-connect.switches';
import { ScopeContextService } from '../scope/scope-context.service';

/** The code of the one refusal {@link MarketplaceInstallClaimService} gives. */
export const INSTALL_ORGANIZATION_MISMATCH_CODE = 'install_organization_mismatch';

/** An Ever organization: Ever Platform's id of it, or its handle. */
const EVER_ORG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** What of a create request the claim is read from. */
export type InstallClaimRequest = Pick<
    CreateWorkDto,
    'kind' | 'blueprintId' | 'installId' | 'everOrg'
>;

/**
 * Whether a create request made by a signed-in person may keep the marketplace
 * install it names (`CreateWorkDto.installId`, with `everOrg`).
 *
 * The install id arrives in an address a person followed, so it is a **claim**.
 * It is passed on to the create path (which keeps it on the App) only when all
 * of this holds:
 *
 * - the hand-off is switched on here (`EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED`,
 *   off by default);
 * - the request creates an **App** from a **Blueprint** (an install is for a
 *   Blueprint listing);
 * - it is spelled like an install id, and it comes with the Ever organization
 *   it belongs to (`everOrg`);
 * - the Organization the App is created in is **linked to that Ever
 *   organization** (an active link, by Ever Platform's id of the organization
 *   or by its handle).
 *
 * In every other case but the last the claim is **ignored**: no error, nothing
 * stored, and the create goes on exactly as a request without it, so a client
 * that knows nothing of installs is unaffected. The last case is refused
 * (`409 install_organization_mismatch`): a request that names an Ever
 * organization and is made in an Organization not linked to it is not a
 * create to let through with the install dropped.
 *
 * `everOrg` is used for this check and is not stored. Whether the install
 * really is that organization's, is for that Blueprint and is not already
 * bound to another App is for Ever Platform to decide when it is told of the
 * App; nothing here asserts it.
 */
@Injectable()
export class MarketplaceInstallClaimService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly scope: ScopeContextService,
    ) {}

    /**
     * What the create path is told to keep for this request, or `undefined`
     * when the claim is not read. `organizationId` is the Organization the
     * request acts in; by default the request's own scope.
     */
    async forSessionCreate(
        request: InstallClaimRequest,
        organizationId: string | null = this.scope.getOrganizationId(),
    ): Promise<{ marketplaceInstallId: string } | undefined> {
        if (!isBlueprintHandoffEnabled()) return undefined;
        const installId = normalizeEverPlatformInstallId(request?.installId);
        if (!installId) return undefined;
        if (request.kind !== 'app' || !request.blueprintId) return undefined;
        const everOrg = typeof request.everOrg === 'string' ? request.everOrg.trim() : '';
        // An install without the organization it belongs to cannot be bound to anything.
        if (!EVER_ORG.test(everOrg)) return undefined;

        const link = organizationId
            ? await this.dataSource
                  .getRepository(EverConnectLink)
                  .findOne({ where: { organizationId, status: 'active' } })
            : null;
        const handle = typeof link?.handle === 'string' ? link.handle.trim().toLowerCase() : '';
        const linked =
            link !== null &&
            (link.everOrgId === everOrg || (handle !== '' && handle === everOrg.toLowerCase()));
        if (!linked) {
            throw new HttpException(
                {
                    status: 'error',
                    code: INSTALL_ORGANIZATION_MISMATCH_CODE,
                    message:
                        'This install belongs to an Ever organization this Organization is not linked to. ' +
                        'Create the App in the Organization linked to it.',
                },
                HttpStatus.CONFLICT,
            );
        }
        return { marketplaceInstallId: installId };
    }
}
