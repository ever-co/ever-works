import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource } from 'typeorm';
import { EverConnectConnection, EverConnectLink } from '@ever-works/agent/entities';
import { EverConnectLinkChangedEvent } from '../../ever-connect.events';
import { EverConnectExtensions } from '../../ever-connect-extensions';
import type { EverConnectIntegrationService } from '../../ever-connect-integration.service';
import type { EverConnectService } from '../../ever-connect.service';
import type { EverConnectEntitlementService } from '../../entitlements/ever-connect-entitlement.service';
import { createIdentityDataSource } from '../../identity/__tests__/db.helper-spec';
import { EverConnectLinkService } from '../ever-connect-link.service';

/**
 * An Organization's link on a real database, with Ever Platform's answers
 * played by a fake client: how each refusal is answered here, and what is kept
 * (or not) after it. (The happy path over the wire is covered against the mock
 * platform in `ever-connect-links-mirror.mock.spec.ts`.)
 */
const INSTANCE = '01JZ8Q3M4N5P6R7S8T9V0W1X2Y';
const LINK_ID = '01JZ8Q3M4N5P6R7S8T9V0W1XA1';
const EVER_ORG = '01JMQCK0RG000000000000000B';
const CODE = 'EVL-7K2M-9QXR-4HTB';

const problem = (status: number, code: string) =>
    Object.assign(new Error(code), { name: 'ProblemError', status, code });

describe('EverConnectLinkService', () => {
    const savedEnv = { ...process.env };
    let dataSource: DataSource;
    let create: jest.Mock;
    let remove: jest.Mock;
    let ended: jest.Mock;
    let refresh: jest.Mock;
    let refreshLink: jest.Mock;
    let forgetLink: jest.Mock;
    let events: EventEmitter2;
    let announced: EverConnectLinkChangedEvent[];
    let extensions: EverConnectExtensions;
    let links: EverConnectLinkService;

    const acme = { id: randomUUID(), tenantId: randomUUID(), slug: 'acme' };
    const other = { id: randomUUID(), tenantId: randomUUID(), slug: 'other' };

    const refusal = async (attempt: Promise<unknown>) => {
        try {
            await attempt;
        } catch (error) {
            const http = error as { getStatus?: () => number; getResponse?: () => unknown };
            return {
                status: http.getStatus?.(),
                code: (http.getResponse?.() as { code?: string } | undefined)?.code,
            };
        }
        return { status: 0, code: 'not refused' };
    };
    const row = (organizationId: string) =>
        dataSource.getRepository(EverConnectLink).findOne({ where: { organizationId } });
    const setStatus = (status: EverConnectConnection['status']) =>
        dataSource.getRepository(EverConnectConnection).update({ id: 'self' }, { status });

    beforeAll(async () => {
        dataSource = await createIdentityDataSource();
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        process.env.EVER_CONNECT_ENABLED = 'true';
        process.env.EVER_CONNECT_LINK_CODES_ENABLED = 'true';
        const connections = dataSource.getRepository(EverConnectConnection);
        await connections.clear();
        await dataSource.getRepository(EverConnectLink).clear();
        await connections.insert({ id: 'self', status: 'active', platformInstanceId: INSTANCE });
        create = jest.fn(async () => ({ id: LINK_ID, org_id: EVER_ORG }));
        remove = jest.fn(async () => undefined);
        ended = jest.fn(async (status: 'revoked') => {
            await connections.update({ id: 'self' }, { status });
        });
        refresh = jest.fn(async () => []);
        refreshLink = jest.fn(async () => 'stored');
        forgetLink = jest.fn(async () => undefined);
        const client = { instances: { tenantLinks: { create, remove } } };
        const connected = async () =>
            ['active', 'pending_approval'].includes(
                (await connections.findOneOrFail({ where: { id: 'self' } })).status,
            );
        const connection = {
            connection: async () => connections.findOneOrFail({ where: { id: 'self' } }),
            status: async () => ({
                status: (await connections.findOneOrFail({ where: { id: 'self' } })).status,
            }),
            client: async () => ((await connected()) ? client : null),
            ended,
        } as unknown as EverConnectService;
        events = new EventEmitter2();
        announced = [];
        events.on(EverConnectLinkChangedEvent.EVENT_NAME, (event) => announced.push(event));
        extensions = new EverConnectExtensions();
        links = new EverConnectLinkService(
            dataSource.getRepository(EverConnectLink),
            connection,
            { refresh } as unknown as EverConnectIntegrationService,
            events,
            {
                isEnabled: () => true,
                refreshLink,
                forgetLink,
                view: async () => null,
            } as unknown as EverConnectEntitlementService,
            extensions,
        );
    });

    afterEach(() => {
        process.env = { ...savedEnv };
    });

    it('links: one call with an idempotency key, the link kept, the states read, the change announced', async () => {
        const view = await links.link(acme, CODE.toLowerCase());
        expect(view.link).toMatchObject({
            everOrgId: EVER_ORG,
            handle: null,
            createdVia: 'link_code',
        });
        expect(create).toHaveBeenCalledTimes(1);
        const [body, key] = create.mock.calls[0];
        expect(body).toEqual({
            link_code: CODE,
            product: 'works',
            product_tenant_id: acme.tenantId,
            product_org_id: 'acme',
        });
        expect(key).toMatch(/^[0-9a-f]{64}$/);
        // The key never carries the code itself.
        expect(key).not.toContain('7K2M');
        expect(await row(acme.id)).toMatchObject({
            platformLinkId: LINK_ID,
            everOrgId: EVER_ORG,
            productOrgRef: 'acme',
            status: 'active',
        });
        expect(refreshLink).toHaveBeenCalledTimes(1);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(announced).toEqual([
            { organizationId: acme.id, change: 'linked', platformLinkId: LINK_ID },
        ]);
    });

    it('the same code again for the same Organization asks with the same key', async () => {
        create.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'TimeoutError' }));
        expect(await refusal(links.link(acme, CODE))).toEqual({
            status: 502,
            code: 'platform_unreachable',
        });
        await links.link(acme, CODE);
        expect(create.mock.calls[0][1]).toBe(create.mock.calls[1][1]);
        // Another Organization, another key.
        await dataSource.getRepository(EverConnectLink).clear();
        create.mockResolvedValueOnce({ id: '01JZ8Q3M4N5P6R7S8T9V0W1XB2', org_id: EVER_ORG });
        await links.link(other, CODE);
        expect(create.mock.calls[2][1]).not.toBe(create.mock.calls[0][1]);
    });

    it.each([
        ['a code Ever Platform does not know', problem(422, 'code_invalid'), 422, 'code_invalid'],
        ['a code for another product', problem(422, 'product_mismatch'), 422, 'product_mismatch'],
        [
            'a tenant Ever Platform holds as linked',
            problem(409, 'already_linked'),
            409,
            'already_linked',
        ],
        ['link codes switched off there', problem(404, 'not_found'), 422, 'not_found'],
        [
            'too many wrong codes',
            Object.assign(new Error('x'), { name: 'RateLimitedError', retryAfterS: 60 }),
            429,
            'rate_limited',
        ],
        ['Ever Platform failing', problem(503, 'unavailable'), 502, 'platform_unreachable'],
        ['no answer', new Error('socket hang up'), 502, 'platform_unreachable'],
        [
            'a body the client refuses to send',
            Object.assign(new Error('x'), { name: 'RequestRefusedError', code: 'invalid_body' }),
            422,
            'invalid_body',
        ],
    ])(
        '%s: answered in its own words, nothing kept, nothing announced',
        async (_name, error, status, code) => {
            create.mockRejectedValueOnce(error);
            expect(await refusal(links.link(acme, CODE))).toEqual({ status, code });
            expect(await row(acme.id)).toBeNull();
            expect(announced).toEqual([]);
            expect(refresh).not.toHaveBeenCalled();
        },
    );

    it('no log line and no answer carries the code, whatever happens to it', async () => {
        const lines: string[] = [];
        const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
            jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
                lines.push(args.map(String).join(' '));
            }),
        );
        try {
            const answers: unknown[] = [];
            for (const error of [
                problem(422, 'code_invalid'),
                problem(503, 'unavailable'),
                Object.assign(new Error(`refused ${CODE}`), {
                    name: 'ProblemError',
                    status: 409,
                    code: 'already_linked',
                }),
            ]) {
                create.mockRejectedValueOnce(error);
                answers.push(
                    await links
                        .link(acme, CODE)
                        .catch((refused) =>
                            (refused as { getResponse?: () => unknown }).getResponse?.(),
                        ),
                );
            }
            answers.push(await links.link(acme, CODE));
            answers.push(await links.unlink(acme));
            const said = JSON.stringify([lines, answers]);
            expect(lines.length).toBeGreaterThan(3);
            expect(said).not.toContain(CODE);
            expect(said.toUpperCase()).not.toContain('7K2M');
        } finally {
            for (const spy of spies) spy.mockRestore();
        }
    });

    it('a revoked credential ends the connection', async () => {
        create.mockRejectedValueOnce(problem(401, 'credential_revoked'));
        expect(await refusal(links.link(acme, CODE))).toEqual({
            status: 409,
            code: 'not_connected',
        });
        expect(ended).toHaveBeenCalledWith('revoked');
        expect(await row(acme.id)).toBeNull();
    });

    it('an answer without its ids keeps nothing', async () => {
        create.mockResolvedValueOnce({ id: 'not-a-link-id', org_id: EVER_ORG });
        expect(await refusal(links.link(acme, CODE))).toEqual({
            status: 502,
            code: 'platform_unreachable',
        });
        expect(await row(acme.id)).toBeNull();
    });

    it.each(['pending_approval', 'disconnected', 'revoked'] as const)(
        'an installation that is %s links nothing and asks nothing',
        async (status) => {
            await setStatus(status);
            expect(await refusal(links.link(acme, CODE))).toEqual({
                status: 409,
                code: 'not_connected',
            });
            expect(create).not.toHaveBeenCalled();
            expect((await links.view(acme)).connected).toBe(false);
        },
    );

    it('an Ever organization linked to another Organization here: the new link is taken back', async () => {
        await links.link(acme, CODE);
        create.mockResolvedValueOnce({ id: '01JZ8Q3M4N5P6R7S8T9V0W1XB2', org_id: EVER_ORG });
        expect(await refusal(links.link(other, 'EVL-0000-0000-0001'))).toEqual({
            status: 409,
            code: 'already_linked',
        });
        expect(remove).toHaveBeenCalledWith('01JZ8Q3M4N5P6R7S8T9V0W1XB2');
        expect(await row(other.id)).toBeNull();
        expect((await row(acme.id))?.status).toBe('active');
    });

    it('a link is made without waiting on the entitlement or the states', async () => {
        refreshLink.mockRejectedValueOnce(new Error('unavailable'));
        refresh.mockRejectedValueOnce(new Error('unavailable'));
        const view = await links.link(acme, CODE);
        expect(view.link?.everOrgId).toBe(EVER_ORG);
    });

    describe('removing a link', () => {
        beforeEach(async () => {
            await links.link(acme, CODE);
            announced.length = 0;
        });

        it('tells Ever Platform, archives the link, forgets its document and announces it', async () => {
            expect((await links.unlink(acme)).link).toBeNull();
            expect(remove).toHaveBeenCalledWith(LINK_ID);
            expect((await row(acme.id))?.status).toBe('archived');
            expect(forgetLink).toHaveBeenCalledWith(LINK_ID);
            expect(announced).toEqual([
                { organizationId: acme.id, change: 'unlinked', platformLinkId: LINK_ID },
            ]);
        });

        it('gone at Ever Platform already: the same outcome', async () => {
            remove.mockRejectedValueOnce(problem(404, 'not_found'));
            await links.unlink(acme);
            expect((await row(acme.id))?.status).toBe('archived');
        });

        it.each([
            ['Ever Platform failing', problem(503, 'unavailable'), 502, 'platform_unreachable'],
            [
                'no answer',
                Object.assign(new Error('x'), { name: 'TimeoutError' }),
                502,
                'platform_unreachable',
            ],
            ['a refusal', problem(403, 'forbidden'), 422, 'forbidden'],
        ])('%s: the link stays, so both sides agree', async (_name, error, status, code) => {
            remove.mockRejectedValueOnce(error);
            expect(await refusal(links.unlink(acme))).toEqual({ status, code });
            expect((await row(acme.id))?.status).toBe('active');
            expect(announced).toEqual([]);
            // It can be tried again.
            await links.unlink(acme);
            expect((await row(acme.id))?.status).toBe('archived');
        });

        it('an installation that is not connected any more archives the link here', async () => {
            await setStatus('disconnected');
            await links.unlink(acme);
            expect(remove).not.toHaveBeenCalled();
            expect((await row(acme.id))?.status).toBe('archived');
        });

        it('linked again later: the Organization keeps its one row', async () => {
            await links.unlink(acme);
            create.mockResolvedValueOnce({ id: '01JZ8Q3M4N5P6R7S8T9V0W1XB2', org_id: EVER_ORG });
            await links.link(acme, 'EVL-0000-0000-0002');
            const all = await dataSource.getRepository(EverConnectLink).find();
            expect(all).toHaveLength(1);
            expect(all[0]).toMatchObject({
                status: 'active',
                platformLinkId: '01JZ8Q3M4N5P6R7S8T9V0W1XB2',
            });
        });
    });

    describe('what Ever Platform announces', () => {
        beforeEach(async () => {
            await links.link(acme, CODE);
            announced.length = 0;
        });

        it.each(['ever.registry.tenant_link.unlinked', 'ever.registry.tenant_link.orphaned'])(
            '%s ends the link here, without a call',
            async (type) => {
                expect(links.handles(type)).toBe(true);
                await links.handle({ id: 'e1', type, data: { tenant_link_id: LINK_ID } });
                expect((await row(acme.id))?.status).toBe('archived');
                expect(remove).not.toHaveBeenCalled();
                expect(announced).toHaveLength(1);
                // Delivered again: nothing more.
                await links.handle({ id: 'e1', type, data: { tenant_link_id: LINK_ID } });
                expect(announced).toHaveLength(1);
            },
        );

        it('other events, other links and unreadable data change nothing', async () => {
            expect(links.handles('ever.registry.tenant_link.created')).toBe(false);
            expect(links.handles('ever.registry.tenant_link.suspended')).toBe(false);
            for (const data of [
                { tenant_link_id: '01JZ8Q3M4N5P6R7S8T9V0W1XZ9' },
                { tenant_link_id: 'nope' },
                {},
                null,
                'text',
            ]) {
                await links.handle({ id: 'e2', type: 'ever.registry.tenant_link.unlinked', data });
            }
            expect((await row(acme.id))?.status).toBe('active');
        });

        it('the connection ended: every link ends here', async () => {
            await links.onConnectionChanged({ status: 'active' });
            expect((await row(acme.id))?.status).toBe('active');
            await links.onConnectionChanged({ status: 'revoked' });
            expect((await row(acme.id))?.status).toBe('archived');
            expect(announced).toHaveLength(1);
        });
    });

    it('reads the feed only when switched on', () => {
        links.onModuleInit();
        expect(extensions.handlesFeedEvent('ever.registry.tenant_link.unlinked')).toBe(true);

        delete process.env.EVER_CONNECT_LINK_CODES_ENABLED;
        const off = new EverConnectExtensions();
        new EverConnectLinkService(
            dataSource.getRepository(EverConnectLink),
            {} as EverConnectService,
            {} as EverConnectIntegrationService,
            events,
            undefined,
            off,
        ).onModuleInit();
        expect(off.handlesFeedEvent('ever.registry.tenant_link.unlinked')).toBe(false);
    });
});
