import type { DataSource } from 'typeorm';
import {
    EverConnectConnection,
    EverConnectEntitlement,
    EverConnectLink,
} from '@ever-works/agent/entities';
import { EverConnectExtensions } from '../../ever-connect-extensions';
import type { EverConnectService } from '../../ever-connect.service';
import { EverConnectEntitlementService } from '../../entitlements/ever-connect-entitlement.service';
import { createIdentityDataSource } from '../../identity/__tests__/db.helper-spec';
import {
    EverConnectHeartbeatService,
    HEARTBEAT_AFTER_START_MS,
    HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_RETRY_MS,
} from '../ever-connect-heartbeat.service';

/**
 * When the heartbeat is sent, on a real database with Ever Platform played by a
 * fake client; and that the heartbeat and the entitlement reader do nothing at
 * all while their switch is off. (The wire is covered against the mock platform
 * in `ever-connect-links-mirror.mock.spec.ts`.)
 */
const INSTANCE = '01JZ8Q3M4N5P6R7S8T9V0W1X2Y';
const T0 = new Date('2026-11-13T10:00:00.000Z');
const after = (ms: number) => new Date(T0.getTime() + ms);

const problem = (status: number, code: string) =>
    Object.assign(new Error(code), { name: 'ProblemError', status, code });

describe('EverConnectHeartbeatService', () => {
    const savedEnv = { ...process.env };
    let dataSource: DataSource;
    let send: jest.Mock;
    let ended: jest.Mock;
    let connection: EverConnectService;
    let entitlementRead: jest.Mock;

    const service = (extensions?: EverConnectExtensions) =>
        new EverConnectHeartbeatService(
            dataSource.getRepository(EverConnectConnection),
            connection,
            extensions,
        );
    const setStatus = (status: EverConnectConnection['status']) =>
        dataSource.getRepository(EverConnectConnection).update({ id: 'self' }, { status });

    beforeEach(async () => {
        process.env.EVER_CONNECT_ENABLED = 'true';
        process.env.EVER_CONNECT_HEARTBEAT_ENABLED = 'true';
        dataSource = await createIdentityDataSource();
        const connections = dataSource.getRepository(EverConnectConnection);
        await connections.insert({ id: 'self', status: 'active', platformInstanceId: INSTANCE });
        send = jest.fn(async () => ({
            recorded: true,
            notices: [],
            server_time: T0.toISOString(),
        }));
        entitlementRead = jest.fn();
        ended = jest.fn(async (status: 'revoked') => {
            await connections.update({ id: 'self' }, { status });
        });
        const client = {
            instances: {
                heartbeat: send,
                entitlement: entitlementRead,
                linkEntitlement: entitlementRead,
            },
        };
        connection = {
            connection: async () => connections.findOneOrFail({ where: { id: 'self' } }),
            client: async () =>
                ['active', 'pending_approval'].includes(
                    (await connections.findOneOrFail({ where: { id: 'self' } })).status,
                )
                    ? client
                    : null,
            ended,
        } as unknown as EverConnectService;
    });

    afterEach(async () => {
        await dataSource.destroy();
        process.env = { ...savedEnv };
    });

    it('sends the version and the product, nothing else', async () => {
        await service().round(T0);
        expect(send).toHaveBeenCalledTimes(1);
        const [body] = send.mock.calls[0];
        expect(Object.keys(body).sort()).toEqual(['serves_products', 'version']);
        expect(body.serves_products).toEqual(['works']);
        expect(typeof body.version).toBe('string');
    });

    it('once after a start, then once a day', async () => {
        const heartbeat = service();
        await heartbeat.round(T0);
        expect(await heartbeat.lastSentAt()).toBe(T0.toISOString());
        await heartbeat.round(after(30_000));
        await heartbeat.round(after(HEARTBEAT_AFTER_START_MS + 1));
        await heartbeat.round(after(HEARTBEAT_INTERVAL_MS - 1));
        expect(send).toHaveBeenCalledTimes(1);
        await heartbeat.round(after(HEARTBEAT_INTERVAL_MS));
        expect(send).toHaveBeenCalledTimes(2);
        expect(await heartbeat.lastSentAt()).toBe(after(HEARTBEAT_INTERVAL_MS).toISOString());
    });

    it('a restart reports again, unless another replica just did', async () => {
        await service().round(T0);
        // A second replica starting within minutes: the first one's report covers it.
        const replica = service();
        await replica.round(after(60_000));
        await replica.round(after(HEARTBEAT_AFTER_START_MS + 60_000));
        expect(send).toHaveBeenCalledTimes(1);
        // A start hours later (a deploy): the new version is reported.
        await service().round(after(3 * 3_600_000));
        expect(send).toHaveBeenCalledTimes(2);
    });

    it.each(['pending_approval', 'disconnected', 'revoked'] as const)(
        'nothing while the installation is %s',
        async (status) => {
            await setStatus(status);
            await service().round(T0);
            expect(send).not.toHaveBeenCalled();
        },
    );

    it('a failure is retried after five minutes, not every round', async () => {
        const heartbeat = service();
        send.mockRejectedValueOnce(problem(503, 'unavailable'));
        await heartbeat.round(T0);
        expect(await heartbeat.lastSentAt()).toBeNull();
        await heartbeat.round(after(30_000));
        await heartbeat.round(after(HEARTBEAT_RETRY_MS - 1));
        expect(send).toHaveBeenCalledTimes(1);
        await heartbeat.round(after(HEARTBEAT_RETRY_MS));
        expect(send).toHaveBeenCalledTimes(2);
        expect(await heartbeat.lastSentAt()).toBe(after(HEARTBEAT_RETRY_MS).toISOString());
    });

    it('held back by Ever Platform: waits as long as it says', async () => {
        const heartbeat = service();
        send.mockRejectedValueOnce(
            Object.assign(new Error('x'), { name: 'RateLimitedError', retryAfterS: 900 }),
        );
        await heartbeat.round(T0);
        await heartbeat.round(after(HEARTBEAT_RETRY_MS));
        expect(send).toHaveBeenCalledTimes(1);
        await heartbeat.round(after(900_000));
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('a revoked credential ends the connection', async () => {
        send.mockRejectedValueOnce(problem(401, 'credential_revoked'));
        await service().round(T0);
        expect(ended).toHaveBeenCalledWith('revoked');
    });

    it('the end of a connection forgets its last heartbeat, so the next connection reports at once', async () => {
        const heartbeat = service();
        await heartbeat.round(T0);
        await heartbeat.onConnectionChanged({ status: 'active' });
        expect(await heartbeat.lastSentAt()).toBe(T0.toISOString());
        await heartbeat.onConnectionChanged({ status: 'disconnected' });
        expect(await heartbeat.lastSentAt()).toBeNull();
        await heartbeat.round(after(60_000));
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('joins the worker only when switched on; switched off it sends nothing even when asked', async () => {
        const on = new EverConnectExtensions();
        service(on).onModuleInit();
        await on.runRound(T0);
        expect(send).toHaveBeenCalledTimes(1);

        delete process.env.EVER_CONNECT_HEARTBEAT_ENABLED;
        const off = new EverConnectExtensions();
        const heartbeat = service(off);
        heartbeat.onModuleInit();
        await off.runRound(after(HEARTBEAT_INTERVAL_MS));
        await heartbeat.round(after(HEARTBEAT_INTERVAL_MS));
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('the entitlement reader does nothing while its switch is off', async () => {
        delete process.env.EVER_CONNECT_ENTITLEMENTS_ENABLED;
        const extensions = new EverConnectExtensions();
        const documents = dataSource.getRepository(EverConnectEntitlement);
        await documents.insert({ subject: 'instance', lastError: 'kept-from-before' });
        const entitlements = new EverConnectEntitlementService(
            documents,
            dataSource.getRepository(EverConnectLink),
            connection,
            extensions,
        );
        entitlements.onModuleInit();
        expect(entitlements.isEnabled()).toBe(false);
        expect(extensions.handlesFeedEvent('ever.entitlements.entitlement.issued')).toBe(false);
        await extensions.runRound(T0);
        await entitlements.round(T0);
        expect(await entitlements.refreshInstance(T0)).toBe('not_connected');
        expect(await entitlements.instanceView(T0)).toBeNull();
        expect(entitlementRead).not.toHaveBeenCalled();

        process.env.EVER_CONNECT_ENTITLEMENTS_ENABLED = 'true';
        const on = new EverConnectExtensions();
        new EverConnectEntitlementService(
            documents,
            dataSource.getRepository(EverConnectLink),
            connection,
            on,
        ).onModuleInit();
        expect(on.handlesFeedEvent('ever.entitlements.entitlement.issued')).toBe(true);
        expect(on.handlesFeedEvent('ever.consent.consent.granted')).toBe(false);
    });
});
