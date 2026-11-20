import { OPERATIONS, type EverPlatformClient, type OperationSpec } from '@ever-co/connect-sdk';

/**
 * `GET /v1/instances/me/tenant-links/{link}/memberships`: one page of the
 * current members of the organization a tenant link points at, named as the
 * membership envelopes of the feed name them (the Ever ID issuer and subject,
 * the local account when a person link names one, the Ever role; never an
 * e-mail or a person id). It is the re-read Ever Platform asks for after the
 * feed answered `410 resync_required`, and answers `404 module_disabled` while
 * Ever Platform sends no membership events.
 *
 * The pinned SDK (`1.0.0-rc.8`) has no method for this route yet, so its
 * operation is added to the SDK's own operation table, as the published
 * contract describes it, the first time it is needed: the call then goes
 * through the SDK client like every other one (the installation's token, its
 * timeouts, redirect refusal and problem documents). A later SDK that ships
 * the operation keeps its own entry.
 */
export const LINK_MEMBERSHIPS_OPERATION = 'instanceListLinkMemberships';

/** The largest page the route answers. */
export const LINK_MEMBERSHIPS_PAGE_SIZE = 100;

const SPEC: OperationSpec = {
    id: LINK_MEMBERSHIPS_OPERATION,
    method: 'GET',
    path: '/v1/instances/me/tenant-links/{link}/memberships',
    pathParams: ['link'],
    query: ['cursor', 'limit'],
    auth: 'instance',
    idempotencyKey: 'none',
    linkHeader: 'none',
    conditional: false,
    body: null,
    success: [200],
    row: 0,
    integration: null,
    rateLimit: 'instance',
    status: 'provisional',
};

/** One page as the route answers it (each item is checked by the caller). */
export interface LinkMembershipsPage {
    readonly items: readonly unknown[];
    readonly nextCursor: string | null;
}

/** Thrown for an answer that is not a page (a value-free `name`, as the SDK's errors). */
export class LinkMembershipsAnswerError extends Error {
    override readonly name = 'LinkMembershipsAnswerError';
    readonly code = 'malformed_page';
    constructor() {
        super('The membership list answered something that is not a page');
    }
}

type Call = (
    id: string,
    input: {
        readonly path: Readonly<Record<string, string>>;
        readonly query: Readonly<Record<string, string | number | undefined>>;
    },
) => Promise<unknown>;

/** Add the operation to the SDK's table, unless the SDK has it already. */
export function ensureLinkMembershipsOperation(
    table: Record<string, OperationSpec> = OPERATIONS as unknown as Record<string, OperationSpec>,
): void {
    if (!Object.prototype.hasOwnProperty.call(table, LINK_MEMBERSHIPS_OPERATION)) {
        table[LINK_MEMBERSHIPS_OPERATION] = SPEC;
    }
}

/**
 * Read one page of the members of the tenant link `linkId` (Ever Platform's id
 * of the link), after `cursor` (`null` for the first page). A failure is the
 * SDK's own error (`ProblemError` with `status` and `code`, …).
 */
export async function readLinkMembershipsPage(
    client: Pick<EverPlatformClient, 'call'>,
    linkId: string,
    cursor: string | null,
): Promise<LinkMembershipsPage> {
    ensureLinkMembershipsOperation();
    const answer = await (client.call as unknown as Call)(LINK_MEMBERSHIPS_OPERATION, {
        path: { link: linkId },
        query: { limit: LINK_MEMBERSHIPS_PAGE_SIZE, cursor: cursor ?? undefined },
    });
    if (!answer || typeof answer !== 'object') throw new LinkMembershipsAnswerError();
    const { items, next_cursor } = answer as { items?: unknown; next_cursor?: unknown };
    if (!Array.isArray(items)) throw new LinkMembershipsAnswerError();
    if (next_cursor !== undefined && next_cursor !== null && typeof next_cursor !== 'string') {
        throw new LinkMembershipsAnswerError();
    }
    return {
        items,
        nextCursor: typeof next_cursor === 'string' && next_cursor !== '' ? next_cursor : null,
    };
}
