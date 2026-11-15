import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { EverConnectLink } from '@ever-works/agent/entities';
import { createIdentityDataSource } from '../ever-connect/identity/__tests__/db.helper-spec';
import { ScopeContextService } from '../scope/scope-context.service';
import {
    INSTALL_ORGANIZATION_MISMATCH_CODE,
    MarketplaceInstallClaimService,
} from './marketplace-install-claim.service';

/**
 * Whether `POST /api/works` may keep the marketplace install a request names.
 * The install id comes from an address a person followed, so it is a claim:
 * read only with the hand-off switched on, only for an App made from a
 * Blueprint, and only in the Organization linked to the Ever organization the
 * request names. Everything else is ignored (no error, nothing kept), except a
 * request made in an Organization that is not linked to that Ever organization,
 * which is refused. The links are on a real database.
 */
const INSTALL = '01JC5R7Y6K1M9E0V3Q2A8XW4TB';
const EVER_ORG = '01JMQCK0RG000000000000000A';
const OTHER_EVER_ORG = '01JMQCK0RG000000000000000B';
const GONE_EVER_ORG = '01JMQCK0RG000000000000000C';

const tenant = randomUUID();
/** Linked to `EVER_ORG`, whose handle on Ever Platform is `acme`. */
const linked = { id: randomUUID(), tenantId: tenant };
/** Another account's Organization, linked to another Ever organization. */
const elsewhere = { id: randomUUID(), tenantId: randomUUID() };
/** An Organization whose link to `GONE_EVER_ORG` was removed. */
const formerlyLinked = { id: randomUUID(), tenantId: randomUUID() };
/** An Organization that was never linked. */
const unlinked = { id: randomUUID(), tenantId: randomUUID() };

const ON = {
    EVER_CONNECT_ENABLED: 'true',
    EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED: 'true',
} as const;

/** A create request as the form sends it for a marketplace install. */
const claim = (overrides: Record<string, unknown> = {}) =>
    ({
        kind: 'app',
        blueprintId: 'cal-diy',
        installId: INSTALL,
        everOrg: EVER_ORG,
        ...overrides,
    }) as never;

async function refusalOf(call: Promise<unknown>) {
    try {
        await call;
    } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        return { ...(error.getResponse() as object), status: error.getStatus() };
    }
    throw new Error('expected a refusal');
}

describe('MarketplaceInstallClaimService', () => {
    const savedEnv = { ...process.env };
    let dataSource: DataSource;
    let scope: ScopeContextService;
    let claims: MarketplaceInstallClaimService;

    const setEnv = (env: Record<string, string | undefined>) => {
        for (const name of ['EVER_CONNECT_ENABLED', 'EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED']) {
            if (env[name] === undefined) delete process.env[name];
            else process.env[name] = env[name];
        }
    };

    beforeAll(async () => {
        dataSource = await createIdentityDataSource();
        const link = (
            of: { id: string; tenantId: string },
            everOrgId: string,
            handle: string,
            status: 'active' | 'archived',
        ) => ({
            organizationId: of.id,
            tenantId: of.tenantId,
            everOrgId,
            handle,
            platformLinkId: `01JZ8Q3M4N5P6R7S8T9V0W1X${handle.slice(0, 2).toUpperCase()}`,
            productOrgRef: handle,
            createdVia: 'link_code' as const,
            status,
        });
        await dataSource
            .getRepository(EverConnectLink)
            .insert([
                link(linked, EVER_ORG, 'acme', 'active'),
                link(elsewhere, OTHER_EVER_ORG, 'globex', 'active'),
                link(formerlyLinked, GONE_EVER_ORG, 'gone', 'archived'),
            ]);
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(() => {
        setEnv(ON);
        scope = new ScopeContextService();
        claims = new MarketplaceInstallClaimService(dataSource, scope);
    });

    afterEach(() => {
        process.env = { ...savedEnv };
        jest.restoreAllMocks();
    });

    /** As a request made in `organization`'s scope (`null`: a personal scope). */
    const within = <T>(organization: { id: string; tenantId: string } | null, fn: () => T): T =>
        scope.runWith(
            organization
                ? { tenantId: organization.tenantId, organizationId: organization.id }
                : { tenantId: tenant, organizationId: null },
            fn,
        );

    describe('switched off (the default)', () => {
        it.each([
            ['nothing set', {}],
            ['Ever Connect on, the switch unset', { EVER_CONNECT_ENABLED: 'true' }],
            ['the switch on, Ever Connect off', { EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED: 'true' }],
            ['a value that is not `true`', { ...ON, EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED: '1' }],
        ])(
            'a claim is not read (%s): nothing is kept, nothing is looked up',
            async (_name, env) => {
                setEnv(env);
                const read = jest.spyOn(dataSource, 'getRepository');

                // In the Organization the install is for: still nothing.
                expect(
                    await within(linked, () => claims.forSessionCreate(claim())),
                ).toBeUndefined();
                // And where it would be refused with the switch on: not an error either.
                expect(
                    await within(unlinked, () => claims.forSessionCreate(claim())),
                ).toBeUndefined();
                expect(await within(null, () => claims.forSessionCreate(claim()))).toBeUndefined();
                expect(read).not.toHaveBeenCalled();
            },
        );
    });

    describe('switched on', () => {
        it('keeps the install of an App made from a Blueprint, in the Organization linked to its Ever organization', async () => {
            expect(await within(linked, () => claims.forSessionCreate(claim()))).toEqual({
                marketplaceInstallId: INSTALL,
            });
        });

        it("knows the Ever organization by Ever Platform's id of it or by its handle", async () => {
            for (const everOrg of [EVER_ORG, 'acme', 'ACME', ' acme ']) {
                expect(
                    await within(linked, () => claims.forSessionCreate(claim({ everOrg }))),
                ).toEqual({ marketplaceInstallId: INSTALL });
            }
        });

        it('keeps the install id in its one spelling', async () => {
            expect(
                await within(linked, () =>
                    claims.forSessionCreate(claim({ installId: ` ${INSTALL.toLowerCase()} ` })),
                ),
            ).toEqual({ marketplaceInstallId: INSTALL });
        });

        it('takes the Organization it is told, when the caller knows it', async () => {
            expect(await claims.forSessionCreate(claim(), linked.id)).toEqual({
                marketplaceInstallId: INSTALL,
            });
        });

        describe('ignored, not an error: the create goes on as one without an install', () => {
            const IGNORED: Array<[string, Record<string, unknown>]> = [
                ['no install id', { installId: undefined }],
                ['an install id of null', { installId: null }],
                ['an empty install id', { installId: '' }],
                ['an install id that is not one', { installId: 'install-1' }],
                ['an install id that is too long', { installId: `${INSTALL}0` }],
                ['an install id that is not text', { installId: 42 }],
                ['a generated site', { kind: 'website' }],
                ['a request that names no kind', { kind: undefined }],
                ['an App that is not made from a Blueprint', { blueprintId: undefined }],
                ['an App with an empty Blueprint id', { blueprintId: '' }],
                ['an install without its Ever organization', { everOrg: undefined }],
                ['an empty Ever organization', { everOrg: '  ' }],
                ['an Ever organization that is not one', { everOrg: 'acme corp' }],
                ['an Ever organization that is an address', { everOrg: 'https://x.test/acme' }],
                ['an Ever organization that is too long', { everOrg: 'a'.repeat(65) }],
                ['an Ever organization that is not text', { everOrg: { id: EVER_ORG } }],
            ];

            it.each(IGNORED)('%s', async (_name, overrides) => {
                // Wherever the request is made: the linked Organization, one that is not
                // linked, and a personal scope. Never a refusal.
                for (const organization of [linked, unlinked, elsewhere, null]) {
                    expect(
                        await within(organization, () => claims.forSessionCreate(claim(overrides))),
                    ).toBeUndefined();
                }
            });
        });

        describe('refused: the Organization is not linked to the Ever organization the install belongs to', () => {
            it.each<[string, { id: string; tenantId: string } | null, string]>([
                ['an Organization linked to another Ever organization', elsewhere, EVER_ORG],
                ['an Organization that is not linked at all', unlinked, EVER_ORG],
                ['a personal scope', null, EVER_ORG],
                // A removed link binds nothing.
                ['an Organization whose link was removed', formerlyLinked, GONE_EVER_ORG],
                ['an Organization whose link was removed, by its handle', formerlyLinked, 'gone'],
                // The linked Organization, for an install of another Ever organization.
                ['the Ever organization of another Organization', linked, OTHER_EVER_ORG],
                ['the handle of another Organization', linked, 'globex'],
            ])('%s: 409 install_organization_mismatch', async (_name, organization, everOrg) => {
                const refusal = await refusalOf(
                    within(organization, () => claims.forSessionCreate(claim({ everOrg }))),
                );
                expect(refusal).toMatchObject({
                    status: 409,
                    code: INSTALL_ORGANIZATION_MISMATCH_CODE,
                });
                expect(INSTALL_ORGANIZATION_MISMATCH_CODE).toBe('install_organization_mismatch');
                // Says what to do, and nothing of anyone's ids.
                expect(JSON.stringify(refusal)).not.toContain(INSTALL);
                expect(JSON.stringify(refusal)).not.toContain(everOrg);
                expect(JSON.stringify(refusal)).not.toContain(linked.id);
            });
        });
    });
});
