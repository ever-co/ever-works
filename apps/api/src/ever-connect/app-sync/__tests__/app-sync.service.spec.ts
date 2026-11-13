import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import {
    EverConnectConnection,
    EverConnectIntegration,
    EverConnectLink,
    EverConnectOutbox,
    Organization,
    Work,
} from '@ever-works/agent/entities';
import { createIdentityDataSource } from '../../identity/__tests__/db.helper-spec';
import { EverConnectExtensions } from '../../ever-connect-extensions';
import type { EverConnectIntegrationService } from '../../ever-connect-integration.service';
import type { EverConnectService } from '../../ever-connect.service';
import { IntegrationHandlerRegistry } from '../../integrations/integration-handler.registry';
import { APP_SYNC_KEY, APP_SYNC_MAX_OPS, APP_SYNC_OUTBOX_EVENT } from '../app-sync.mapping';
import {
    APP_SYNC_MAX_ATTEMPTS,
    APP_SYNC_PASS_LINKS,
    APP_SYNC_PASS_WORKS,
    APP_SYNC_RECONCILE_INTERVAL_MS,
    APP_SYNC_RECONCILE_RETRY_MS,
    AppSyncService,
} from '../app-sync.service';

/**
 * The apps mirror's worker on a real database with Ever Platform's answers
 * played by a fake client: what is queued and for whom, what each answer of a
 * batch does to its row, how a batch that was not taken is retried, and when
 * the full set is sent again. (The wire itself is covered against the mock
 * platform in `ever-connect-links-mirror.mock.spec.ts`.)
 */
const LINK_A = '01JZ8Q3M4N5P6R7S8T9V0W1XA1';
const LINK_B = '01JZ8Q3M4N5P6R7S8T9V0W1XB2';
const INSTANCE = '01JZ8Q3M4N5P6R7S8T9V0W1X2Y';
const NOW = new Date('2026-11-13T10:00:00.000Z');

interface Op {
    op: string;
    kind: string;
    external_id: string;
    data?: Record<string, unknown>;
}

const problem = (status: number, code: string) =>
    Object.assign(new Error(code), { name: 'ProblemError', status, code });

describe('AppSyncService', () => {
    const savedEnv = { ...process.env };
    let dataSource: DataSource;
    let push: jest.Mock;
    let list: jest.Mock;
    let ended: jest.Mock;
    let refresh: jest.Mock;
    let mirror: AppSyncService;
    let extensions: EverConnectExtensions;
    let registry: IntegrationHandlerRegistry;

    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const orgA = { id: randomUUID(), tenantId: tenantA, slug: 'acme' };
    const orgB = { id: randomUUID(), tenantId: tenantB, slug: 'globex' };
    const orgC = { id: randomUUID(), tenantId: randomUUID(), slug: 'not-linked' };

    const rows = () =>
        dataSource
            .getRepository(EverConnectOutbox)
            .find({ where: { event: APP_SYNC_OUTBOX_EVENT }, order: { seq: 'ASC' } });
    const addWork = async (organization: { id: string; tenantId: string }, name: string) => {
        const id = randomUUID();
        await dataSource.getRepository(Work).insert({
            id,
            name,
            slug: name.toLowerCase().replace(/\s+/g, '-'),
            userId: randomUUID(),
            description: '',
            kind: 'website',
            status: 'active',
            organizationId: organization.id,
            tenantId: organization.tenantId,
        } as never);
        return id;
    };
    const setConsent = (linkId: string, values: Partial<EverConnectIntegration>) =>
        dataSource
            .getRepository(EverConnectIntegration)
            .update({ integrationKey: APP_SYNC_KEY, linkId }, values);
    /** Every operation answered `applied`, in request order. */
    const applied = (batch: { ops: Op[] }) => ({
        results: batch.ops.map((op) => ({ external_id: op.external_id, outcome: 'applied' })),
    });
    const answerAll = (outcome: string, code?: string) => (batch: { ops: Op[] }) => ({
        results: batch.ops.map((op) => ({ external_id: op.external_id, outcome, code })),
    });

    beforeAll(async () => {
        dataSource = await createIdentityDataSource();
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        process.env.EVER_CONNECT_ENABLED = 'true';
        process.env.EVER_CONNECT_APP_SYNC_ENABLED = 'true';
        for (const entity of [
            EverConnectOutbox,
            EverConnectIntegration,
            EverConnectLink,
            EverConnectConnection,
            Work,
            Organization,
        ]) {
            await dataSource.getRepository(entity).clear();
        }
        await dataSource.getRepository(EverConnectConnection).insert({
            id: 'self',
            status: 'active',
            platformInstanceId: INSTANCE,
        });
        await dataSource.getRepository(Organization).insert(
            [orgA, orgB, orgC].map((organization) => ({
                ...organization,
                displayName: organization.slug,
            })) as never,
        );
        await dataSource.getRepository(EverConnectLink).insert([
            {
                organizationId: orgA.id,
                tenantId: orgA.tenantId,
                everOrgId: '01JMQCK0RG000000000000000A',
                handle: 'acme',
                platformLinkId: LINK_A,
                productOrgRef: 'acme-as-linked',
                createdVia: 'link_code',
                status: 'active',
            },
            {
                // Made before the reference was kept: the Organization's slug stands in.
                organizationId: orgB.id,
                tenantId: orgB.tenantId,
                everOrgId: '01JMQCK0RG000000000000000B',
                handle: 'globex',
                platformLinkId: LINK_B,
                productOrgRef: null,
                createdVia: 'provisioning',
                status: 'active',
            },
        ]);
        await dataSource.getRepository(EverConnectIntegration).insert(
            [LINK_A, LINK_B].map((linkId) => ({
                linkId,
                integrationKey: APP_SYNC_KEY,
                state: 'enabled',
                enabled: true,
                scopeVersion: 2,
            })),
        );

        push = jest.fn(async (batch: { ops: Op[] }) => applied(batch));
        list = jest.fn(async () => ({ items: [], next_cursor: null }));
        ended = jest.fn(async (status: 'revoked') => {
            await dataSource
                .getRepository(EverConnectConnection)
                .update({ id: 'self' }, { status });
        });
        refresh = jest.fn(async () => []);
        const client = { instances: { mirrorApps: { push, list } } };
        const repository = dataSource.getRepository(EverConnectConnection);
        const connection = {
            connection: async () => repository.findOneOrFail({ where: { id: 'self' } }),
            client: async () =>
                (await repository.findOneOrFail({ where: { id: 'self' } })).status === 'active'
                    ? client
                    : null,
            ended,
        } as unknown as EverConnectService;
        extensions = new EverConnectExtensions();
        registry = new IntegrationHandlerRegistry();
        mirror = new AppSyncService(
            dataSource,
            connection,
            { refresh } as unknown as EverConnectIntegrationService,
            registry,
            extensions,
        );
    });

    afterEach(() => {
        process.env = { ...savedEnv };
    });

    describe('what is queued', () => {
        it('one row per Work, for an Organization the mirror runs for', async () => {
            const work = await addWork(orgA, 'Store');
            await mirror.workChanged(work);
            await mirror.workChanged(work);
            await mirror.workChanged(work, orgA.id);
            const queued = await rows();
            expect(queued).toHaveLength(1);
            expect(queued[0]).toMatchObject({
                payload: { workId: work },
                accountRef: orgA.id,
                state: 'pending',
                attempts: 0,
            });
            // Only the id is kept: nothing of the Work.
            expect(Object.keys(queued[0].payload)).toEqual(['workId']);
        });

        it('nothing for an Organization without a link, a Work without an Organization, or an id that is not one', async () => {
            await mirror.workChanged(await addWork(orgC, 'Unlinked'));
            await mirror.workChanged(randomUUID());
            await mirror.workChanged('not an id', orgA.id);
            await mirror.workChanged('');
            expect(await rows()).toEqual([]);
        });

        it.each([
            ['the switch is off', () => delete process.env.EVER_CONNECT_APP_SYNC_ENABLED],
            ['Ever Connect is off', () => delete process.env.EVER_CONNECT_ENABLED],
        ])('nothing while %s, and nothing is sent', async (_name, off) => {
            const work = await addWork(orgA, 'Store');
            await mirror.workChanged(work);
            off();
            await mirror.workChanged(await addWork(orgA, 'Second'));
            expect(await rows()).toHaveLength(1);
            await mirror.round(NOW);
            expect(await mirror.drainOnce(NOW)).toBe(0);
            expect(await mirror.reconcile(NOW)).toBe(false);
            expect(push).not.toHaveBeenCalled();
            expect(list).not.toHaveBeenCalled();
            expect(await mirror.status()).toBeNull();
            expect((await mirror.enabledLinks()).size).toBe(0);
        });

        it.each([
            ['the consent is off', { enabled: false, state: 'disabled' }],
            ['the consent is older than the scope the mirror needs', { scopeVersion: 1 }],
            ['the consent names no scope version', { scopeVersion: null }],
        ])('nothing while %s', async (_name, values) => {
            await setConsent(LINK_A, values as Partial<EverConnectIntegration>);
            await mirror.workChanged(await addWork(orgA, 'Store'));
            expect(await rows()).toEqual([]);
            expect([...(await mirror.enabledLinks()).keys()]).toEqual([orgB.id]);
        });

        it('nothing while the installation is not connected, or its link is archived', async () => {
            await dataSource
                .getRepository(EverConnectLink)
                .update({ organizationId: orgA.id }, { status: 'archived' });
            await mirror.workChanged(await addWork(orgA, 'Store'));
            await dataSource
                .getRepository(EverConnectConnection)
                .update({ id: 'self' }, { status: 'disconnected' });
            await mirror.workChanged(await addWork(orgB, 'Shop'));
            expect(await rows()).toEqual([]);
        });

        it('registers its handler and joins the round only when switched on', () => {
            mirror.onModuleInit();
            expect(registry.has(APP_SYNC_KEY)).toBe(true);
            expect(registry.perLinkKeys()).toContain(APP_SYNC_KEY);

            delete process.env.EVER_CONNECT_APP_SYNC_ENABLED;
            const offRegistry = new IntegrationHandlerRegistry();
            const offExtensions = new EverConnectExtensions();
            const off = new AppSyncService(
                dataSource,
                {} as EverConnectService,
                {} as EverConnectIntegrationService,
                offRegistry,
                offExtensions,
            );
            off.onModuleInit();
            expect(offRegistry.has(APP_SYNC_KEY)).toBe(false);
        });
    });

    describe('what is sent', () => {
        it('one batch for each link, each with the reference its link was made with', async () => {
            const a = await addWork(orgA, 'Store');
            const b = await addWork(orgB, 'Shop');
            await mirror.workChanged(a);
            await mirror.workChanged(b);
            expect(await mirror.drainOnce(new Date())).toBe(2);
            expect(push).toHaveBeenCalledTimes(2);
            const sent = push.mock.calls.map(([batch]) => batch.ops as Op[]);
            const forA = sent.find((ops) => ops.some((op) => op.external_id === a)) as Op[];
            const forB = sent.find((ops) => ops.some((op) => op.external_id === b)) as Op[];
            expect(forA).toHaveLength(1);
            expect(forA[0].data).toMatchObject({
                product_tenant_id: orgA.tenantId,
                product_org_id: 'acme-as-linked',
            });
            expect(forB[0].data).toMatchObject({
                product_tenant_id: orgB.tenantId,
                product_org_id: 'globex',
            });
            expect(await rows()).toEqual([]);
        });

        it('a pass sends at most a batch Ever Platform reads', async () => {
            // Three operations for a Work at most: the Work and its two environments.
            expect(APP_SYNC_PASS_WORKS * 3).toBeLessThanOrEqual(APP_SYNC_MAX_OPS);
        });

        it('a pass sends for a bounded number of links; the rows of the others stay due', async () => {
            const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
            const extra = APP_SYNC_PASS_LINKS;
            for (let index = 0; index < extra; index += 1) {
                const organization = {
                    id: randomUUID(),
                    tenantId: randomUUID(),
                    slug: `extra-${index}`,
                };
                const linkId = `01JZ8Q3M4N5P6R7S8T9V0W1X${alphabet[Math.floor(index / 32)]}${alphabet[index % 32]}`;
                await dataSource
                    .getRepository(Organization)
                    .insert({ ...organization, displayName: organization.slug } as never);
                await dataSource.getRepository(EverConnectLink).insert({
                    organizationId: organization.id,
                    tenantId: organization.tenantId,
                    everOrgId: `ever-org-${index}`,
                    handle: '',
                    platformLinkId: linkId,
                    productOrgRef: organization.slug,
                    createdVia: 'link_code',
                    status: 'active',
                });
                await dataSource.getRepository(EverConnectIntegration).insert({
                    linkId,
                    integrationKey: APP_SYNC_KEY,
                    state: 'enabled',
                    enabled: true,
                    scopeVersion: 2,
                });
                await mirror.workChanged(await addWork(organization, `Work ${index}`));
            }
            await mirror.workChanged(await addWork(orgA, 'Store'));
            expect(await rows()).toHaveLength(extra + 1);

            expect(await mirror.drainOnce(new Date())).toBe(APP_SYNC_PASS_LINKS);
            expect(push).toHaveBeenCalledTimes(APP_SYNC_PASS_LINKS);
            const left = await rows();
            expect(left).toHaveLength(1);
            expect(left[0]).toMatchObject({ state: 'pending', attempts: 0 });
            expect(await mirror.drainOnce(new Date())).toBe(1);
            expect(await rows()).toEqual([]);
        });

        it('a row whose Work may not move any more is dropped without a request', async () => {
            const work = await addWork(orgA, 'Store');
            await mirror.workChanged(work);
            await setConsent(LINK_A, { enabled: false });
            expect(await mirror.drainOnce(new Date())).toBe(0);
            expect(await rows()).toEqual([]);
            expect(push).not.toHaveBeenCalled();
        });

        it('a row waiting for a retry is not sent before its time', async () => {
            await mirror.workChanged(await addWork(orgA, 'Store'));
            push.mockRejectedValueOnce(problem(503, 'unavailable'));
            const at = new Date();
            await mirror.drainOnce(at);
            await mirror.drainOnce(new Date(at.getTime() + 10_000));
            expect(push).toHaveBeenCalledTimes(1);
            await mirror.drainOnce(new Date(at.getTime() + 31_000));
            expect(push).toHaveBeenCalledTimes(2);
            expect(await rows()).toEqual([]);
        });
    });

    describe("each answer of a batch decides its Work's row", () => {
        let work: string;
        beforeEach(async () => {
            work = await addWork(orgA, 'Store');
            await mirror.workChanged(work);
        });

        it('`applied` and `ignored_stale`: the row is done', async () => {
            push.mockImplementationOnce(async (batch) => answerAll('ignored_stale')(batch));
            expect(await mirror.drainOnce(new Date())).toBe(1);
            expect(await rows()).toEqual([]);
        });

        it.each(['unlinked_org', 'integration_disabled'])(
            '`rejected` %s: nothing is owed any more, and the states are read again',
            async (code) => {
                push.mockImplementationOnce(async (batch) => answerAll('rejected', code)(batch));
                expect(await mirror.drainOnce(new Date())).toBe(0);
                expect(await rows()).toEqual([]);
                expect(refresh).toHaveBeenCalledTimes(1);
            },
        );

        it('`rejected` unknown_app: sent again later', async () => {
            push.mockImplementationOnce(async (batch) =>
                answerAll('rejected', 'unknown_app')(batch),
            );
            const at = new Date();
            await mirror.drainOnce(at);
            const [row] = await rows();
            expect(row).toMatchObject({ state: 'pending', attempts: 1, lastError: 'unknown_app' });
            expect(new Date(row.nextAttemptAt).getTime()).toBeGreaterThanOrEqual(
                at.getTime() + 30_000,
            );
        });

        it.each(['schema_violation', 'org_mismatch'])(
            '`rejected` %s: kept as failed for the operator; the next change of the Work tries again',
            async (code) => {
                push.mockImplementationOnce(async (batch) => answerAll('rejected', code)(batch));
                await mirror.drainOnce(new Date());
                expect((await rows())[0]).toMatchObject({ state: 'failed', lastError: code });
                expect(await mirror.status()).toMatchObject({
                    pending: 0,
                    failed: 1,
                    lastError: code,
                });
                // Failed rows are not sent again by themselves.
                await mirror.drainOnce(new Date(Date.now() + 7_200_000));
                expect(push).toHaveBeenCalledTimes(1);

                await mirror.workChanged(work);
                expect((await rows())[0]).toMatchObject({
                    state: 'pending',
                    attempts: 0,
                    lastError: null,
                });
                expect(await mirror.drainOnce(new Date())).toBe(1);
            },
        );

        it('an answer that misses the operation: sent again', async () => {
            push.mockResolvedValueOnce({ results: [] });
            await mirror.drainOnce(new Date());
            expect((await rows())[0]).toMatchObject({ state: 'pending', lastError: 'no_result' });
        });
    });

    describe('a batch Ever Platform did not take', () => {
        beforeEach(async () => {
            await mirror.workChanged(await addWork(orgA, 'Store'));
        });

        it('waits 30 seconds, then 5 minutes, then an hour', async () => {
            const waits: number[] = [];
            let at = new Date();
            for (let attempt = 0; attempt < 4; attempt += 1) {
                push.mockRejectedValueOnce(problem(503, 'unavailable'));
                await mirror.drainOnce(at);
                const [row] = await rows();
                waits.push(new Date(row.nextAttemptAt).getTime() - at.getTime());
                expect(row).toMatchObject({ attempts: attempt + 1, lastError: 'unavailable' });
                at = new Date(new Date(row.nextAttemptAt).getTime() + 1);
            }
            expect(waits).toEqual([30_000, 300_000, 3_600_000, 3_600_000]);
        });

        it('a network failure and a timeout are retried too', async () => {
            push.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'TimeoutError' }));
            await mirror.drainOnce(new Date());
            expect((await rows())[0]).toMatchObject({ state: 'pending', lastError: 'timeout' });
        });

        it('rate limited: waits as long as Ever Platform says', async () => {
            push.mockRejectedValueOnce(
                Object.assign(new Error('x'), { name: 'RateLimitedError', retryAfterS: 120 }),
            );
            const at = new Date();
            await mirror.drainOnce(at);
            const [row] = await rows();
            expect(row.lastError).toBe('rate_limited');
            expect(new Date(row.nextAttemptAt).getTime() - at.getTime()).toBe(120_000);
        });

        it('403 (no link has the integration): the states are read again and the row waits', async () => {
            push.mockRejectedValueOnce(problem(403, 'integration_disabled'));
            await mirror.drainOnce(new Date());
            expect(refresh).toHaveBeenCalledTimes(1);
            expect((await rows())[0]).toMatchObject({
                state: 'pending',
                lastError: 'integration_disabled',
            });
        });

        it.each([
            [
                'a body Ever Platform does not read',
                problem(422, 'validation_failed'),
                'validation_failed',
            ],
            ['a body over its size', problem(413, 'payload_too_large'), 'payload_too_large'],
            [
                'a body the client refuses to send',
                Object.assign(new Error('x'), {
                    name: 'RequestRefusedError',
                    code: 'invalid_body',
                }),
                'invalid_body',
            ],
        ])('%s: given up at once, for the operator', async (_name, error, code) => {
            push.mockRejectedValueOnce(error);
            await mirror.drainOnce(new Date());
            expect((await rows())[0]).toMatchObject({ state: 'failed', lastError: code });
        });

        it('given up after the last attempt', async () => {
            await dataSource
                .getRepository(EverConnectOutbox)
                .update({ event: APP_SYNC_OUTBOX_EVENT }, { attempts: APP_SYNC_MAX_ATTEMPTS - 1 });
            push.mockRejectedValueOnce(problem(503, 'unavailable'));
            await mirror.drainOnce(new Date());
            expect((await rows())[0]).toMatchObject({ state: 'failed', lastError: 'unavailable' });
        });

        it('a revoked credential ends the connection; nothing more is sent', async () => {
            await mirror.workChanged(await addWork(orgB, 'Shop'));
            push.mockRejectedValueOnce(problem(401, 'credential_revoked'));
            await mirror.drainOnce(new Date());
            expect(ended).toHaveBeenCalledWith('revoked');
            expect(push).toHaveBeenCalledTimes(1);
            await mirror.round(new Date());
            expect(push).toHaveBeenCalledTimes(1);
        });
    });

    describe('the full set, sent again', () => {
        it('is due at once, then once a day; every Work of every enabled link is queued', async () => {
            const a = await addWork(orgA, 'Store');
            const b = await addWork(orgB, 'Shop');
            await addWork(orgC, 'Unlinked');
            expect(await mirror.reconcileIfDue(NOW)).toBe(true);
            expect((await rows()).map((row) => row.payload.workId).sort()).toEqual([a, b].sort());
            expect(list).toHaveBeenCalledTimes(1);
            expect((await mirror.status())?.reconciledAt).toBe(NOW.toISOString());

            await dataSource.getRepository(EverConnectOutbox).clear();
            const soon = new Date(NOW.getTime() + APP_SYNC_RECONCILE_INTERVAL_MS - 1);
            expect(await mirror.reconcileIfDue(soon)).toBe(false);
            expect(await rows()).toEqual([]);
            const nextDay = new Date(NOW.getTime() + APP_SYNC_RECONCILE_INTERVAL_MS);
            expect(await mirror.reconcileIfDue(nextDay)).toBe(true);
            expect(await rows()).toHaveLength(2);
        });

        it('a round queues and sends in the same round', async () => {
            await addWork(orgA, 'Store');
            await mirror.round(NOW);
            expect(push).toHaveBeenCalledTimes(1);
            expect(await rows()).toEqual([]);
        });

        it('what Ever Platform holds for a Work that is gone is deleted there; nothing here', async () => {
            const kept = await addWork(orgA, 'Store');
            const gone = randomUUID();
            const foreign = randomUUID();
            list.mockResolvedValueOnce({
                items: [
                    { external_id: kept, external_version: 1, kind: 'app', org_link_id: LINK_A },
                    { external_id: gone, external_version: 1, kind: 'app', org_link_id: LINK_A },
                    { external_id: `${gone}:production`, external_version: 1, kind: 'deployment' },
                    // Held under a link the mirror does not run for: left to Ever Platform.
                    {
                        external_id: foreign,
                        external_version: 1,
                        kind: 'app',
                        org_link_id: '01JZ8Q3M4N5P6R7S8T9V0W1XZ9',
                    },
                ],
                next_cursor: null,
            });
            expect(await mirror.reconcile(NOW)).toBe(true);
            expect((await rows()).map((row) => row.payload.workId).sort()).toEqual(
                [kept, gone].sort(),
            );
            await mirror.drainOnce(NOW);
            const ops = push.mock.calls.flatMap(([batch]) => batch.ops as Op[]);
            expect(ops.find((op) => op.external_id === gone)).toMatchObject({
                op: 'delete',
                kind: 'app',
            });
            expect(ops.find((op) => op.external_id === kept)).toMatchObject({ op: 'upsert' });
            expect(ops.some((op) => op.external_id === foreign)).toBe(false);
            expect(await dataSource.getRepository(Work).count()).toBe(1);
        });

        it('reads every page of what Ever Platform holds', async () => {
            await addWork(orgA, 'Store');
            list.mockResolvedValueOnce({ items: [], next_cursor: 'page-2' }).mockResolvedValueOnce({
                items: [],
                next_cursor: null,
            });
            await mirror.reconcile(NOW);
            expect(list.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, 'page-2']);
        });

        it('a reconciliation that could not finish is tried again an hour later, not at once', async () => {
            await addWork(orgA, 'Store');
            list.mockRejectedValueOnce(problem(503, 'unavailable'));
            expect(await mirror.reconcileIfDue(NOW)).toBe(false);
            expect((await mirror.status())?.reconciledAt).toBeNull();
            expect(await mirror.reconcileIfDue(new Date(NOW.getTime() + 60_000))).toBe(false);
            expect(list).toHaveBeenCalledTimes(1);
            const later = new Date(NOW.getTime() + APP_SYNC_RECONCILE_RETRY_MS);
            expect(await mirror.reconcileIfDue(later)).toBe(true);
            expect(list).toHaveBeenCalledTimes(2);
        });

        it('with no enabled link there is nothing to read', async () => {
            await setConsent(LINK_A, { enabled: false });
            await setConsent(LINK_B, { enabled: false });
            expect(await mirror.reconcile(NOW)).toBe(true);
            expect(list).not.toHaveBeenCalled();
            expect(await rows()).toEqual([]);
        });
    });

    describe('what turns it on and off', () => {
        it('enabled for a link: the full set is due now', async () => {
            await mirror.reconcileIfDue(NOW);
            expect(await mirror.reconcileIfDue(new Date(NOW.getTime() + 1000))).toBe(false);
            await mirror.onIntegrationChanged({
                integrationKey: APP_SYNC_KEY,
                enabled: true,
                linkId: LINK_A,
            });
            expect(await mirror.reconcileIfDue(new Date(NOW.getTime() + 2000))).toBe(true);
        });

        it("disabled for a link, or the link removed: what was owed for its Organization is dropped, nobody else's", async () => {
            await mirror.workChanged(await addWork(orgA, 'Store'));
            await mirror.workChanged(await addWork(orgB, 'Shop'));
            await mirror.onIntegrationChanged({
                integrationKey: APP_SYNC_KEY,
                enabled: false,
                linkId: LINK_A,
            });
            expect((await rows()).map((row) => row.accountRef)).toEqual([orgB.id]);
            await mirror.onLinkChanged({
                organizationId: orgB.id,
                change: 'unlinked',
                platformLinkId: LINK_B,
            });
            expect(await rows()).toEqual([]);
        });

        it("another integration's change, or an installation-wide one, changes nothing", async () => {
            await mirror.workChanged(await addWork(orgA, 'Store'));
            await mirror.onIntegrationChanged({
                integrationKey: 'marketplace_installs',
                enabled: false,
                linkId: LINK_A,
            });
            await mirror.onIntegrationChanged({ integrationKey: APP_SYNC_KEY, enabled: false });
            await mirror.onLinkChanged({
                organizationId: orgA.id,
                change: 'linked',
                platformLinkId: LINK_A,
            });
            expect(await rows()).toHaveLength(1);
        });

        it('tells the rest of Ever Connect which Organizations it runs for', async () => {
            mirror.onModuleInit();
            expect(await extensions.appSyncRunsFor(orgA.id)).toBe(true);
            expect(await extensions.appSyncRunsFor(orgC.id)).toBe(false);
            expect(await extensions.appSyncStatus()).toMatchObject({ linksEnabled: 2 });
            expect(await new EverConnectExtensions().appSyncRunsFor(orgA.id)).toBe(false);
        });
    });
});
