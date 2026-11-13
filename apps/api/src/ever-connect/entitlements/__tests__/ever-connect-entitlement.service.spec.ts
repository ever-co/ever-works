import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import {
    EverConnectConnection,
    EverConnectEntitlement,
    EverConnectLink,
} from '@ever-works/agent/entities';
import { EverConnectExtensions } from '../../ever-connect-extensions';
import type { EverConnectService } from '../../ever-connect.service';
import { createIdentityDataSource } from '../../identity/__tests__/db.helper-spec';
import {
    ENTITLEMENT_LINK_READS_PER_ROUND,
    ENTITLEMENT_REFRESH_AFTER_S,
    ENTITLEMENT_RETRY_AFTER_MS,
    EverConnectEntitlementService,
    linkEntitlementSubject,
} from '../ever-connect-entitlement.service';

/**
 * When the entitlement documents are read, on a real database with Ever
 * Platform played by a fake client that answers no document: which documents a
 * round reads, how many, and when a failed read is tried again. (Reading,
 * verifying and keeping a real signed document is covered against the mock
 * platform in `ever-connect-links-mirror.mock.spec.ts`.)
 */
const INSTANCE = '01JZ8Q3M4N5P6R7S8T9V0W1X2Y';
const T0 = new Date('2026-11-13T10:00:00.000Z');
const after = (ms: number) => new Date(T0.getTime() + ms);
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A distinct tenant link id (a ULID's shape) for each number. */
const linkId = (n: number) =>
    `01JZ8Q3M4N5P6R7S8T9V0W${ALPHABET[Math.floor(n / 1024) % 32]}${ALPHABET[Math.floor(n / 32) % 32]}${ALPHABET[n % 32]}Z`;

const problem = (status: number, code: string) =>
    Object.assign(new Error(code), { name: 'ProblemError', status, code });

describe('EverConnectEntitlementService — which documents a round reads', () => {
    const savedEnv = { ...process.env };
    let dataSource: DataSource;
    let instanceRead: jest.Mock;
    let linkRead: jest.Mock;
    let ended: jest.Mock;
    let entitlements: EverConnectEntitlementService;
    let extensions: EverConnectExtensions;

    const documents = () => dataSource.getRepository(EverConnectEntitlement);
    const addLinks = async (count: number, from = 0) => {
        await dataSource.getRepository(EverConnectLink).insert(
            Array.from({ length: count }, (_, index) => ({
                organizationId: randomUUID(),
                tenantId: randomUUID(),
                everOrgId: `ever-org-${from + index}`,
                handle: '',
                platformLinkId: linkId(from + index),
                createdVia: 'link_code' as const,
                status: 'active' as const,
            })),
        );
    };
    /** Every document read just now. */
    const markRead = async (at: Date) => {
        const links = await dataSource.getRepository(EverConnectLink).find();
        await documents().clear();
        await documents().insert(
            [
                'instance',
                ...links.map((link) => linkEntitlementSubject(link.platformLinkId as string)),
            ].map((subject) => ({ subject, fetchedAt: at })),
        );
    };

    beforeAll(async () => {
        dataSource = await createIdentityDataSource();
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        process.env.EVER_CONNECT_ENABLED = 'true';
        process.env.EVER_CONNECT_ENTITLEMENTS_ENABLED = 'true';
        const connections = dataSource.getRepository(EverConnectConnection);
        for (const entity of [EverConnectEntitlement, EverConnectLink, EverConnectConnection]) {
            await dataSource.getRepository(entity).clear();
        }
        await connections.insert({ id: 'self', status: 'active', platformInstanceId: INSTANCE });
        // Ever Platform answers no document: every read fails, and is counted.
        instanceRead = jest.fn(async () => {
            throw problem(503, 'unavailable');
        });
        linkRead = jest.fn(async () => {
            throw problem(503, 'unavailable');
        });
        ended = jest.fn(async (status: 'revoked') => {
            await connections.update({ id: 'self' }, { status });
        });
        const client = { instances: { entitlement: instanceRead, linkEntitlement: linkRead } };
        const connection = {
            connection: async () => connections.findOneOrFail({ where: { id: 'self' } }),
            client: async () =>
                (await connections.findOneOrFail({ where: { id: 'self' } })).status === 'active'
                    ? client
                    : null,
            ended,
        } as unknown as EverConnectService;
        extensions = new EverConnectExtensions();
        entitlements = new EverConnectEntitlementService(
            documents(),
            dataSource.getRepository(EverConnectLink),
            connection,
            extensions,
        );
        entitlements.onModuleInit();
    });

    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it("reads the installation's document and each linked Organization's, each once", async () => {
        await addLinks(3);
        await entitlements.round(T0);
        expect(instanceRead).toHaveBeenCalledTimes(1);
        expect(linkRead.mock.calls.map(([id]) => id).sort()).toEqual([0, 1, 2].map(linkId));
        // The failure is kept for the operator; nothing was stored as a document.
        const rows = await documents().find();
        expect(rows).toHaveLength(4);
        expect(rows.every((row) => row.lastError === 'unavailable' && row.document === null)).toBe(
            true,
        );
        expect(await entitlements.instanceView(T0)).toMatchObject({
            status: 'paused',
            plan: null,
            lastError: 'unavailable',
        });
    });

    it('a failed read is tried again after a quarter of an hour, not every round', async () => {
        await addLinks(1);
        await entitlements.round(T0);
        await entitlements.round(after(30_000));
        await entitlements.round(after(ENTITLEMENT_RETRY_AFTER_MS - 1));
        expect(instanceRead).toHaveBeenCalledTimes(1);
        expect(linkRead).toHaveBeenCalledTimes(1);
        await entitlements.round(after(ENTITLEMENT_RETRY_AFTER_MS));
        expect(instanceRead).toHaveBeenCalledTimes(2);
        expect(linkRead).toHaveBeenCalledTimes(2);
    });

    it('a document is read again six hours after it was read', async () => {
        await addLinks(2);
        await markRead(T0);
        await entitlements.round(after(ENTITLEMENT_REFRESH_AFTER_S * 1000 - 1));
        expect(instanceRead).not.toHaveBeenCalled();
        expect(linkRead).not.toHaveBeenCalled();
        await entitlements.round(after(ENTITLEMENT_REFRESH_AFTER_S * 1000));
        expect(instanceRead).toHaveBeenCalledTimes(1);
        expect(linkRead).toHaveBeenCalledTimes(2);
    });

    it('a new document announced on the feed is read at the next round', async () => {
        await addLinks(2);
        await markRead(T0);
        await entitlements.round(after(60_000));
        expect(instanceRead).not.toHaveBeenCalled();
        expect(extensions.handlesFeedEvent('ever.entitlements.entitlement.issued')).toBe(true);
        await extensions.dispatchFeedEvent({
            id: 'e1',
            type: 'ever.entitlements.entitlement.issued',
            data: {},
        });
        await entitlements.round(after(120_000));
        expect(instanceRead).toHaveBeenCalledTimes(1);
        expect(linkRead).toHaveBeenCalledTimes(2);
    });

    it('a round reads a bounded number of linked documents; the next rounds read the rest', async () => {
        const total = ENTITLEMENT_LINK_READS_PER_ROUND + 5;
        await addLinks(total);
        await entitlements.round(T0);
        expect(linkRead).toHaveBeenCalledTimes(ENTITLEMENT_LINK_READS_PER_ROUND);
        await entitlements.round(after(30_000));
        expect(linkRead).toHaveBeenCalledTimes(total);
        await entitlements.round(after(60_000));
        expect(linkRead).toHaveBeenCalledTimes(total);
        expect(new Set(linkRead.mock.calls.map(([id]) => id)).size).toBe(total);
    });

    it('an archived link, and a link Ever Platform has not named yet, are not read', async () => {
        await addLinks(1);
        await dataSource.getRepository(EverConnectLink).insert([
            {
                organizationId: randomUUID(),
                tenantId: randomUUID(),
                everOrgId: 'ever-org-archived',
                handle: '',
                platformLinkId: linkId(40),
                createdVia: 'link_code',
                status: 'archived',
            },
            {
                organizationId: randomUUID(),
                tenantId: randomUUID(),
                everOrgId: 'ever-org-unnamed',
                handle: '',
                platformLinkId: null,
                createdVia: 'provisioning',
                status: 'active',
            },
        ]);
        await entitlements.round(T0);
        expect(linkRead.mock.calls.map(([id]) => id)).toEqual([linkId(0)]);
    });

    it.each(['pending_approval', 'disconnected', 'revoked'] as const)(
        'nothing is read while the installation is %s',
        async (status) => {
            await addLinks(1);
            await dataSource
                .getRepository(EverConnectConnection)
                .update({ id: 'self' }, { status });
            await entitlements.round(T0);
            expect(await entitlements.refreshInstance(T0)).toBe('not_connected');
            expect(instanceRead).not.toHaveBeenCalled();
            expect(linkRead).not.toHaveBeenCalled();
        },
    );

    it('a revoked credential ends the connection', async () => {
        instanceRead.mockRejectedValueOnce(problem(401, 'credential_revoked'));
        expect(await entitlements.refreshInstance(T0)).toBe('not_connected');
        expect(ended).toHaveBeenCalledWith('revoked');
    });

    it('held back by Ever Platform: named for the operator and tried again later', async () => {
        instanceRead.mockRejectedValueOnce(
            Object.assign(new Error('x'), { name: 'RateLimitedError', retryAfterS: 600 }),
        );
        expect(await entitlements.refreshInstance(T0)).toBe('failed');
        expect((await entitlements.instanceView(T0))?.lastError).toBe('rate_limited');
    });

    it('the end of the connection forgets the documents, not the key set', async () => {
        await addLinks(1);
        await entitlements.round(T0);
        await documents().insert({ subject: 'key-set', document: '{"document":{}}' });
        await entitlements.onConnectionChanged({ status: 'active' });
        expect(await documents().count()).toBe(3);
        await entitlements.onConnectionChanged({ status: 'disconnected' });
        expect((await documents().find()).map((row) => row.subject)).toEqual(['key-set']);
        // The key set is never shown as a document.
        expect(await entitlements.view('key-set')).toBeNull();
    });

    it("a link's document goes with the link", async () => {
        await addLinks(1);
        await entitlements.round(T0);
        await entitlements.forgetLink(linkId(0));
        await entitlements.forgetLink(null);
        expect((await documents().find()).map((row) => row.subject)).toEqual(['instance']);
    });
});
