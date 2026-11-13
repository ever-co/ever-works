import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { In, type DataSource } from 'typeorm';
import type { ActivityLogService } from '@ever-works/agent/activity-log';
import {
    EverConnectConnection,
    EverConnectEntitlement,
    EverConnectIntegration,
    EverConnectLink,
    EverConnectOutbox,
    EverInstance,
    Organization,
    Work,
    WorkDeployment,
} from '@ever-works/agent/entities';
import { EverInstanceService } from '@ever-works/agent/ever-instance';
import { AppSyncListener } from '../app-sync/app-sync.listener';
import { APP_SYNC_KEY, APP_SYNC_OUTBOX_EVENTS } from '../app-sync/app-sync.mapping';
import { AppSyncService } from '../app-sync/app-sync.service';
import { readEverConnectConfig } from '../ever-connect.config';
import {
    EverConnectConnectionChangedEvent,
    EverConnectIntegrationChangedEvent,
    EverConnectLinkChangedEvent,
} from '../ever-connect.events';
import { EverConnectExtensions } from '../ever-connect-extensions';
import { EverConnectFeedService } from '../ever-connect-feed.service';
import { EverConnectIntegrationService } from '../ever-connect-integration.service';
import { withAppSyncLink } from '../ever-connect-link-header';
import { EverConnectKeyService } from '../ever-connect-key.service';
import { EverConnectService } from '../ever-connect.service';
import {
    EverConnectEntitlementService,
    linkEntitlementSubject,
} from '../entitlements/ever-connect-entitlement.service';
import { EverConnectHeartbeatService } from '../heartbeat/ever-connect-heartbeat.service';
import { PersonRequestsHandler } from '../identity/person-requests.handler';
import { createIdentityDataSource } from '../identity/__tests__/db.helper-spec';
import { IntegrationHandlerRegistry } from '../integrations/integration-handler.registry';
import { EverConnectLinkService } from '../links/ever-connect-link.service';

/**
 * Link codes, the heartbeat, entitlement documents and the apps mirror, end to
 * end against the MOCK PLATFORM of the Ever Platform SDK (`ever-mock-platform`
 * from the `@ever-co/connect-tools` pinned in `tools/egress-audit`): the
 * module's own services on a real database, the SDK client over real HTTP, the
 * mock's link codes, its signed documents and its call record.
 *
 * The documents are signed with the mock's TEST root, which the SDK trusts only
 * for a local address and only when `EVER_PLATFORM_ROOT_KEYS_FILE` names it: the
 * test writes that file. Against any other address the SDK's pinned roots are
 * the only ones, as in production.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const TOOLS = join(REPO_ROOT, 'tools/egress-audit/node_modules/@ever-co/connect-tools/dist');
const MOCK_BIN = join(TOOLS, 'mock-platform/bin/ever-mock-platform.mjs');
const MOCK_KEYS = join(TOOLS, 'mock-platform/src/keys.mjs');
const MOCK_ISSUER = 'https://mock-platform.test';
const GLOBEX = { id: '01JMQCK0RG000000000000000B', handle: 'globex' };
/**
 * A mock reached at `EVER_CONNECT_MOCK_URL` must have been started with
 * `EVER_MOCK_CONFIG_JSON` set to this as JSON.
 */
const MOCK_CONFIG = { clock: { real: true } };
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const describeMock =
    process.env.EVER_CONNECT_MOCK_URL || existsSync(MOCK_BIN) ? describe : describe.skip;

interface CallRecord {
    method: string;
    path_template: string;
    row: number | null;
    status: number;
}

async function startMock(): Promise<{ url: string; process: ChildProcess | null }> {
    if (process.env.EVER_CONNECT_MOCK_URL) {
        return { url: process.env.EVER_CONNECT_MOCK_URL.replace(/\/+$/, ''), process: null };
    }
    const child = spawn(process.execPath, [MOCK_BIN, '--host', '127.0.0.1', '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // The mock's clock follows real time, so its documents are current.
        env: { ...process.env, EVER_MOCK_CONFIG_JSON: JSON.stringify(MOCK_CONFIG) },
    });
    const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(
            () => reject(new Error(`mock platform did not start: ${out}`)),
            20_000,
        );
        child.stdout?.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            const match = /listening on (http:\/\/[^\s]+)/.exec(out);
            if (match) {
                clearTimeout(timer);
                resolve(match[1].replace(/\/+$/, ''));
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`mock platform exited (${code}): ${out}`));
        });
    });
    return { url, process: child };
}

describeMock('Ever Connect — link codes, heartbeat, entitlements and the apps mirror', () => {
    jest.setTimeout(120_000);

    let mock: { url: string; process: ChildProcess | null };
    let scratch: string;
    let dataSource: DataSource;
    let events: EventEmitter2;
    let connection: EverConnectService;
    let integrations: EverConnectIntegrationService;
    let entitlements: EverConnectEntitlementService;
    let heartbeat: EverConnectHeartbeatService;
    let links: EverConnectLinkService;
    let mirror: AppSyncService;
    let listener: AppSyncListener;
    let feed: EverConnectFeedService;
    let fetchSpy: jest.SpyInstance;
    const savedEnv = { ...process.env };

    const TENANT = randomUUID();
    const OTHER_TENANT = randomUUID();
    const acme = { id: randomUUID(), tenantId: TENANT, slug: 'acme-works' };
    const second = { id: randomUUID(), tenantId: TENANT, slug: 'acme-second' };
    const stranger = { id: randomUUID(), tenantId: OTHER_TENANT, slug: 'stranger' };
    const USER = randomUUID();
    const site = randomUUID();
    const app = randomUUID();
    const company = randomUUID();

    const admin = async (path: string, body: unknown = {}) => {
        const res = await fetch(`${mock.url}/__mock/${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (res.status >= 300) throw new Error(`mock ${path}: ${res.status} ${await res.text()}`);
        return res.json();
    };
    const record = async (): Promise<CallRecord[]> =>
        (await fetch(`${mock.url}/__mock/requests`)).json() as Promise<CallRecord[]>;
    const rowCalls = async (row: number) => (await record()).filter((entry) => entry.row === row);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
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
    /** The JSON body of a request the client made (it sends bytes). */
    const bodyOf = (init: unknown): Record<string, unknown> => {
        const body = (init as RequestInit | undefined)?.body;
        const text =
            typeof body === 'string' ? body : Buffer.from(body as Uint8Array).toString('utf8');
        return JSON.parse(text);
    };
    const linkCode = (code: string, org = GLOBEX) =>
        admin('codes', { code, kind: 'link', product: 'works', org, expires_in_s: 900 });
    /** The mirror batches sent so far (the bodies of `POST /v1/instances/me/mirror/apps`). */
    const batches = (): Array<{ ops: Array<Record<string, unknown>> }> =>
        fetchSpy.mock.calls
            .filter(
                ([url, init]) =>
                    String(url).endsWith('/v1/instances/me/mirror/apps') &&
                    (init as RequestInit | undefined)?.method === 'POST',
            )
            .map(([, init]) => bodyOf(init) as { ops: Array<Record<string, unknown>> });
    /** What the platform holds of the mirror: its inventory, by external id. */
    const inventory = async () => {
        const client = await connection.client();
        const held = new Map<string, { kind: string; external_version: number }>();
        let cursor: string | undefined;
        do {
            const link = await linkRow(acme.id);
            const page = (await withAppSyncLink(link?.platformLinkId as string, () =>
                client!.instances.mirrorApps.list(cursor, 100),
            )) as unknown as {
                items: Array<{ external_id: string; kind: string; external_version: number }>;
                next_cursor: string | null;
            };
            for (const item of page.items) held.set(item.external_id, item);
            cursor = page.next_cursor ?? undefined;
        } while (cursor);
        return held;
    };
    const outboxRows = () =>
        dataSource
            .getRepository(EverConnectOutbox)
            .find({ where: { event: In([...APP_SYNC_OUTBOX_EVENTS]) } });
    const linkRow = (organizationId: string) =>
        dataSource.getRepository(EverConnectLink).findOne({ where: { organizationId } });

    beforeAll(async () => {
        mock = await startMock();
        scratch = mkdtempSync(join(tmpdir(), 'ever-connect-links-'));
        // The mock's TEST root, for this local address only.
        const root = execFileSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `import { testRootEntry } from ${JSON.stringify(pathToFileURL(MOCK_KEYS).href)};
                 process.stdout.write(JSON.stringify(testRootEntry(${JSON.stringify(MOCK_ISSUER)})));`,
            ],
            { encoding: 'utf8' },
        );
        const rootsFile = join(scratch, 'roots.json');
        writeFileSync(rootsFile, JSON.stringify({ keys: [JSON.parse(root)] }));
        process.env.EVER_PLATFORM_ROOT_KEYS_FILE = rootsFile;
        process.env.WEB_URL = 'https://works.example.test';
        process.env.EVER_CONNECT_ENABLED = 'true';
        process.env.EVER_CONNECT_LINK_CODES_ENABLED = 'true';
        process.env.EVER_CONNECT_HEARTBEAT_ENABLED = 'true';
        process.env.EVER_CONNECT_ENTITLEMENTS_ENABLED = 'true';
        process.env.EVER_CONNECT_APP_SYNC_ENABLED = 'true';

        dataSource = await createIdentityDataSource();
        events = new EventEmitter2();
        fetchSpy = jest.spyOn(globalThis, 'fetch');

        const config = readEverConnectConfig({
            EVER_PLATFORM_API_URL: mock.url,
            EVER_PLATFORM_ISSUER: MOCK_ISSUER,
        });
        const instances = dataSource.getRepository(EverInstance);
        const keys = new EverConnectKeyService(instances, new EverInstanceService(instances));
        connection = new EverConnectService(
            dataSource.getRepository(EverConnectConnection),
            keys,
            config,
            events,
        );
        const extensions = new EverConnectExtensions();
        const registry = new IntegrationHandlerRegistry();
        integrations = new EverConnectIntegrationService(
            dataSource.getRepository(EverConnectIntegration),
            connection,
            events,
            undefined,
            registry,
        );
        entitlements = new EverConnectEntitlementService(
            dataSource.getRepository(EverConnectEntitlement),
            dataSource.getRepository(EverConnectLink),
            connection,
            extensions,
        );
        heartbeat = new EverConnectHeartbeatService(
            dataSource.getRepository(EverConnectConnection),
            connection,
            extensions,
        );
        links = new EverConnectLinkService(
            dataSource.getRepository(EverConnectLink),
            connection,
            integrations,
            events,
            entitlements,
            extensions,
        );
        mirror = new AppSyncService(dataSource, connection, integrations, registry, extensions);
        listener = new AppSyncListener(mirror);
        const requests = new PersonRequestsHandler(connection, dataSource, {
            log: jest.fn().mockResolvedValue({}),
        } as unknown as ActivityLogService);
        feed = new EverConnectFeedService(
            connection,
            integrations,
            requests,
            undefined,
            extensions,
        );
        entitlements.onModuleInit();
        heartbeat.onModuleInit();
        links.onModuleInit();
        mirror.onModuleInit();

        // The in-process listeners, wired as Nest wires @OnEvent.
        events.on(EverConnectIntegrationChangedEvent.EVENT_NAME, (event) =>
            mirror.onIntegrationChanged(event),
        );
        events.on(EverConnectLinkChangedEvent.EVENT_NAME, (event) => mirror.onLinkChanged(event));
        events.on(EverConnectConnectionChangedEvent.EVENT_NAME, (event) =>
            Promise.all([
                integrations.onConnectionChanged(event),
                links.onConnectionChanged(event),
                entitlements.onConnectionChanged(event),
                heartbeat.onConnectionChanged(event),
            ]),
        );

        await dataSource.getRepository(Organization).insert(
            [acme, second, stranger].map((organization) => ({
                ...organization,
                displayName: `SECRET-ORG-NAME ${organization.slug}`,
                legalName: 'SECRET-LEGAL-NAME',
            })),
        );
        const work = (id: string, values: Partial<Work>) =>
            ({
                id,
                userId: USER,
                organizationId: acme.id,
                tenantId: TENANT,
                description: 'SECRET-DESCRIPTION',
                owner: 'SECRET-OWNER',
                companyName: 'SECRET-COMPANY',
                website: 'https://SECRET-WEBSITE.example.test',
                committerEmail: 'secret-committer@example.test',
                deployRuntimeEnvEncrypted: 'SECRET-ENV',
                webhookSecretEncrypted: 'SECRET-HOOK',
                ...values,
            }) as Partial<Work>;
        await dataSource.getRepository(Work).insert([
            work(site, {
                name: 'Acme Store',
                slug: 'acme-store',
                kind: 'website',
                status: 'active',
            }),
            work(app, { name: 'Acme Portal', slug: 'acme-portal', kind: 'app', status: 'draft' }),
            work(company, {
                name: 'Acme Inc',
                slug: 'acme-inc',
                kind: 'company',
                status: 'registered',
                deployProvider: null,
            }),
            // Another Organization's Work: never mirrored.
            work(randomUUID(), {
                name: 'SECRET-STRANGER-WORK',
                slug: 'stranger-work',
                organizationId: stranger.id,
                tenantId: OTHER_TENANT,
            }),
        ]);
        const deployment = (values: Partial<WorkDeployment>) =>
            ({
                id: randomUUID(),
                branch: 'SECRET-BRANCH',
                commitSha: 'SECRET-SHA',
                lastError: 'SECRET-BUILD-LOG',
                providerProjectId: 'SECRET-PROJECT',
                organizationId: acme.id,
                tenantId: TENANT,
                ...values,
            }) as Partial<WorkDeployment>;
        await dataSource.getRepository(WorkDeployment).insert([
            // An older deploy of the site: only the newest row of an environment is told.
            deployment({
                workId: site,
                provider: 'ever-works',
                state: 'ERROR',
                website: 'https://old.acme.example.test/',
                createdAt: new Date('2026-11-01T10:00:00Z'),
            }),
            deployment({
                workId: site,
                provider: 'ever-works',
                state: 'READY',
                website: 'https://store.acme.example.test/?token=SECRET-TOKEN',
                createdAt: new Date('2026-11-10T10:00:00Z'),
            }),
            deployment({
                workId: site,
                provider: 'ever-works',
                environment: 'preview' as WorkDeployment['environment'],
                state: 'BUILDING',
                prNumber: 4242,
                createdAt: new Date('2026-11-11T10:00:00Z'),
            }),
            deployment({
                workId: app,
                provider: 'k8s',
                appTarget: 'your-cluster',
                state: 'READY',
                website: 'https://portal.acme.example.test/',
                createdAt: new Date('2026-11-12T10:00:00Z'),
            }),
        ]);
    });

    afterAll(async () => {
        fetchSpy?.mockRestore();
        await dataSource?.destroy();
        mock?.process?.kill();
        if (scratch) rmSync(scratch, { recursive: true, force: true });
        process.env = { ...savedEnv };
    });

    it('a link code is refused before any request while the installation is not connected', async () => {
        expect(await refusal(links.link(acme, 'not a code'))).toEqual({
            status: 400,
            code: 'code_invalid',
        });
        expect(await refusal(links.link(acme, 'EVC-TEST-0000-0004'))).toEqual({
            status: 400,
            code: 'code_invalid',
        });
        expect(await refusal(links.link(acme, 'EVL-TEST-0000-0009'))).toEqual({
            status: 409,
            code: 'not_connected',
        });
        expect(await links.view(acme)).toEqual({
            connected: false,
            link: null,
            entitlement: null,
            appSync: false,
            // The service says "may change it" only when its caller says so.
            canManage: false,
        });
        expect((await links.view(acme, true)).canManage).toBe(true);
        expect(await record()).toEqual([]);
    });

    it('the heartbeat reports the version once after a start, then waits a day', async () => {
        // Nothing while not connected.
        await heartbeat.round();
        expect(await rowCalls(6)).toEqual([]);

        const status = await connection.connect('evc-test-0000-0004');
        expect(status.status).toBe('active');

        const start = new Date();
        await heartbeat.round(start);
        expect((await rowCalls(6)).map((entry) => entry.status)).toEqual([200]);
        expect(await heartbeat.lastSentAt()).toBe(start.toISOString());

        // The next rounds send nothing until a day has passed.
        await heartbeat.round(new Date(start.getTime() + 60_000));
        await heartbeat.round(new Date(start.getTime() + 23 * 3_600_000));
        expect(await rowCalls(6)).toHaveLength(1);
        const body = fetchSpy.mock.calls
            .filter(([url]) => String(url).endsWith('/v1/instances/me/heartbeat'))
            .map(([, init]) => bodyOf(init));
        expect(body).toHaveLength(1);
        expect(Object.keys(body[0]).sort()).toEqual(['serves_products', 'version']);
        expect(body[0].serves_products).toEqual(['works']);
    });

    it("the installation's entitlement document is verified, kept and shown without the document", async () => {
        await entitlements.round();
        const view = await entitlements.instanceView();
        expect(view).toMatchObject({
            status: 'valid',
            handle: 'acme',
            tier: 'paid',
            lastError: null,
        });
        expect(view?.plan).toBeTruthy();
        expect(view?.features).toMatchObject({ handle: true });
        expect(view?.seq).toBeGreaterThanOrEqual(1);
        // Never the signed document, in the view or anywhere near it.
        expect(JSON.stringify(view)).not.toMatch(/eyJ/);

        const stored = await dataSource
            .getRepository(EverConnectEntitlement)
            .findOne({ where: { subject: 'instance' } });
        expect(stored?.document).toMatch(/^eyJ/);
        // The key set the document was verified with is kept (public keys only).
        const keySet = await dataSource
            .getRepository(EverConnectEntitlement)
            .findOne({ where: { subject: 'key-set' } });
        expect(JSON.parse(keySet?.document ?? '{}')).toHaveProperty('document');

        // Read again: the same document costs a 304 and changes nothing.
        expect(await entitlements.refreshInstance()).toBe('unchanged');
        const reads = await rowCalls(8);
        expect(reads.map((entry) => entry.status)).toEqual([200, 304]);
        // Not due again for hours: a round reads nothing.
        await entitlements.round();
        expect(await rowCalls(8)).toHaveLength(2);
    });

    it('a document that does not verify is not kept: the stored one stays and the refusal is named', async () => {
        const repository = dataSource.getRepository(EverConnectEntitlement);
        const before = await repository.findOne({ where: { subject: 'instance' } });
        // Ever Platform's entitlement key rotates and a new document is issued;
        // the kept key set does not know the key until it is read again, which
        // the verifier does once. Then the same with the key set unavailable.
        await admin('keys/rotate');
        await admin('entitlement/reissue', {
            instance_id: (await connection.status()).platformInstanceId,
        });
        await admin('faults', { keys_unavailable: true });
        const later = new Date(Date.now() + 3_600_000);
        expect(await entitlements.refreshInstance(later)).toBe('refused');
        const refused = await repository.findOne({ where: { subject: 'instance' } });
        expect(refused?.document).toBe(before?.document);
        expect(refused?.seq).toBe(before?.seq);
        expect(refused?.lastError).toBeTruthy();
        expect((await entitlements.instanceView())?.lastError).toBe(refused?.lastError);

        // The key set can be read again: the new document verifies and replaces the old one.
        await admin('faults', { keys_unavailable: false });
        expect(await entitlements.refreshInstance(new Date(later.getTime() + 3_600_000))).toBe(
            'stored',
        );
        const kept = await repository.findOne({ where: { subject: 'instance' } });
        expect(Number(kept?.seq)).toBeGreaterThan(Number(before?.seq));
        expect(kept?.lastError).toBeNull();
    });

    it('links the Organization with a link code: the tenant id and the slug travel, nothing else', async () => {
        await linkCode('EVL-TEST-0000-0009');
        const view = await links.link(acme, ' evl-test-0000-0009 ');
        expect(view).toMatchObject({
            connected: true,
            link: { everOrgId: GLOBEX.id, handle: 'globex', createdVia: 'link_code' },
            appSync: false,
            // Only an administrator of the Organization reaches link().
            canManage: true,
        });
        // The link's own entitlement document was read and verified.
        expect(view.entitlement).toMatchObject({ status: 'valid', handle: 'globex' });

        const row = await linkRow(acme.id);
        expect(row).toMatchObject({
            tenantId: TENANT,
            everOrgId: GLOBEX.id,
            productOrgRef: 'acme-works',
            createdVia: 'link_code',
            status: 'active',
        });
        expect(row?.platformLinkId).toMatch(ULID);

        const creates = fetchSpy.mock.calls
            .filter(
                ([url, init]) =>
                    String(url).endsWith('/v1/instances/me/tenant-links') &&
                    (init as RequestInit | undefined)?.method === 'POST',
            )
            .map(([, init]) => bodyOf(init));
        expect(creates).toEqual([
            {
                link_code: 'EVL-TEST-0000-0009',
                product: 'works',
                product_tenant_id: TENANT,
                product_org_id: 'acme-works',
            },
        ]);
        expect(JSON.stringify(creates)).not.toMatch(/SECRET/);
        expect((await rowCalls(5)).map((entry) => `${entry.method} ${entry.status}`)).toEqual([
            'POST 201',
        ]);
    });

    it('one link per Organization and per tenant; a code Ever Platform refuses stores nothing', async () => {
        await linkCode('EVL-TEST-0000-0008');
        expect(await refusal(links.link(acme, 'EVL-TEST-0000-0008'))).toEqual({
            status: 409,
            code: 'already_linked',
        });
        expect(await refusal(links.link(second, 'EVL-TEST-0000-0008'))).toEqual({
            status: 409,
            code: 'tenant_already_linked',
        });
        // Both refused here: Ever Platform was not asked, the code is still good.
        expect(await rowCalls(5)).toHaveLength(1);

        // A used code, and one that never existed: one answer, nothing stored.
        expect(await refusal(links.link(stranger, 'EVL-TEST-0000-0009'))).toEqual({
            status: 422,
            code: 'code_invalid',
        });
        expect(await refusal(links.link(stranger, 'EVL-ZZZZ-ZZZZ-ZZZZ'))).toEqual({
            status: 422,
            code: 'code_invalid',
        });
        expect(await linkRow(stranger.id)).toBeNull();
        expect(await refusal(links.unlink(stranger))).toEqual({ status: 404, code: 'not_linked' });
    });

    it('nothing of a Work moves without the consent, nor on a consent older than the mirror’s scope', async () => {
        await listener.onWorkStatusChanged({ workId: site } as never);
        await mirror.round();
        expect(await outboxRows()).toEqual([]);
        expect(await rowCalls(15)).toEqual([]);

        // An owner enables `app_sync` for the link in app.ever.co; the feed tells.
        const link = await linkRow(acme.id);
        await admin('consent', {
            instance_id: (await connection.status()).platformInstanceId,
            integration: APP_SYNC_KEY,
            link: link?.platformLinkId,
            enabled: true,
        });
        await feed.pollOnce(0);
        await settle();
        const state = await dataSource.getRepository(EverConnectIntegration).findOne({
            where: { integrationKey: APP_SYNC_KEY, linkId: link?.platformLinkId as string },
        });
        expect(state).toMatchObject({ enabled: true, scopeVersion: 1 });

        // The mock serves the catalog pinned in this SDK release, where `app_sync`
        // is at scope version 1: it does not list the name and the slug the
        // mirror sends, so nothing moves.
        expect((await mirror.enabledLinks()).size).toBe(0);
        await listener.onWorkStatusChanged({ workId: site } as never);
        await mirror.round();
        expect(await outboxRows()).toEqual([]);
        expect(await rowCalls(15)).toEqual([]);
        expect((await links.view(acme)).appSync).toBe(false);
    });

    it('with the consent at the current scope, every Work of the Organization and its current deployments are sent', async () => {
        // From here on the test stands in for a platform whose catalog lists the
        // mirror's fields at the version this mock serves.
        mirror.minScopeVersion = 1;
        expect([...(await mirror.enabledLinks()).keys()]).toEqual([acme.id]);
        await dataSource
            .getRepository(EverConnectConnection)
            .update({ id: 'self' }, { appSyncReconciledAt: null });

        await mirror.round();
        expect((await rowCalls(15)).filter((entry) => entry.method === 'POST')).toHaveLength(1);
        expect(await outboxRows()).toEqual([]);

        const held = await inventory();
        expect([...held.keys()].sort()).toEqual(
            [
                site,
                `${site}:production`,
                `${site}:preview`,
                app,
                `${app}:production`,
                company,
            ].sort(),
        );

        const [batch] = batches();
        const byId = new Map(batch.ops.map((op) => [op.external_id as string, op]));
        expect(byId.get(site)).toMatchObject({
            op: 'upsert',
            kind: 'app',
            data: {
                product_tenant_id: TENANT,
                product_org_id: 'acme-works',
                kind: 'work',
                work_kind: 'website',
                name: 'Acme Store',
                slug: 'acme-store',
                base_kind: 'none',
                status: 'live',
            },
        });
        expect(byId.get(app)).toMatchObject({ data: { kind: 'app', status: 'draft' } });
        expect(byId.get(company)).toMatchObject({
            data: { kind: 'work', work_kind: 'company', status: 'registered' },
        });
        // The site's newest production row, with its address stripped of the query.
        expect(byId.get(`${site}:production`)).toMatchObject({
            kind: 'deployment',
            app_external_id: site,
            data: {
                target: 'ever-works',
                provider: 'ever-works',
                shape: 'k8s-works-shared',
                managed_by: 'ever',
                environment: 'production',
                status: 'ready',
                url: 'https://store.acme.example.test/',
            },
        });
        expect(byId.get(`${site}:preview`)).toMatchObject({
            data: { environment: 'preview', status: 'pending' },
        });
        expect(byId.get(`${app}:production`)).toMatchObject({
            data: {
                target: 'your-cluster',
                provider: 'k8s',
                shape: 'custom-kubeconfig',
                managed_by: 'customer',
            },
        });
        // An app comes before its deployments, and versions only grow.
        const order = batch.ops.map((op) => op.external_id);
        expect(order.indexOf(site)).toBeLessThan(order.indexOf(`${site}:production`));
        const versions = batch.ops.map((op) => op.external_version as number);
        expect([...versions].sort((a, b) => a - b)).toEqual(versions);
        expect(new Set(versions).size).toBe(versions.length);

        // Every call of the mirror names the tenant link it acts for.
        const linkId = (await linkRow(acme.id))?.platformLinkId;
        const named = fetchSpy.mock.calls
            .filter(([url]) => String(url).split('?')[0].endsWith('/v1/instances/me/mirror/apps'))
            .map(
                ([, init]) =>
                    ((init as RequestInit).headers as Record<string, string>)['ever-link-id'],
            );
        expect(named.length).toBeGreaterThanOrEqual(2);
        expect(new Set(named)).toEqual(new Set([linkId]));

        // Nothing but identifiers and status left the installation.
        const sent = JSON.stringify(batches());
        expect(sent).not.toMatch(/SECRET|secret-|4242|old\.acme/);
        expect(sent).not.toContain('stranger');
        expect((await links.view(acme)).appSync).toBe(true);
        expect(await mirror.status()).toMatchObject({ linksEnabled: 1, pending: 0, failed: 0 });
    });

    it('a change of a Work is queued once and sent with a higher version; sending again changes nothing', async () => {
        const before = (await inventory()).get(site)?.external_version as number;
        await dataSource.getRepository(Work).update({ id: site }, { status: 'archived' });
        await listener.onWorkStatusChanged({ workId: site } as never);
        await listener.onWorkDomainEvent({
            aggregate: { type: 'work', id: site },
            organizationId: acme.id,
        });
        // Two announcements of one Work: one row.
        expect(await outboxRows()).toHaveLength(1);
        // Another Organization's Work, and a Work of an Organization without the consent: none.
        await listener.onWorkDomainEvent({
            aggregate: { type: 'work', id: randomUUID() },
            organizationId: stranger.id,
        });
        expect(await outboxRows()).toHaveLength(1);

        expect(await mirror.drainOnce()).toBe(1);
        expect(await outboxRows()).toEqual([]);
        expect((await inventory()).get(site)?.external_version).toBeGreaterThan(before);
        const last = batches().at(-1);
        expect(last?.ops.find((op) => op.external_id === site)).toMatchObject({
            data: { status: 'archived' },
        });
        // Nothing owed: a pass sends nothing.
        const posts = (await rowCalls(15)).filter((entry) => entry.method === 'POST').length;
        expect(await mirror.drainOnce()).toBe(0);
        expect((await rowCalls(15)).filter((entry) => entry.method === 'POST')).toHaveLength(posts);
    });

    it('a row changed while its batch is on the way stays owed', async () => {
        await listener.onWorkStatusChanged({ workId: app } as never);
        const [row] = await outboxRows();
        // The Work changes again after the pass read the row: the row moves.
        const original = mirror.enabledLinks.bind(mirror);
        const spy = jest.spyOn(mirror, 'enabledLinks').mockImplementationOnce(async () => {
            await mirror.workChanged(app);
            return original();
        });
        await mirror.drainOnce();
        spy.mockRestore();
        const [after] = await outboxRows();
        expect(after?.id).toBe(row.id);
        expect(after?.seq).not.toBe(row.seq);
        expect(await mirror.drainOnce()).toBe(1);
        expect(await outboxRows()).toEqual([]);
    });

    it('a removed Work is deleted on Ever Platform; one removed unnoticed is found by the reconciliation', async () => {
        await dataSource.getRepository(WorkDeployment).delete({ workId: app });
        await dataSource.getRepository(Work).delete({ id: app });
        await listener.onWorkDomainEvent({
            aggregate: { type: 'work', id: app },
            organizationId: acme.id,
        });
        expect(await mirror.drainOnce()).toBe(1);
        const deleted = batches().at(-1);
        expect(deleted?.ops).toEqual([
            expect.objectContaining({ op: 'delete', kind: 'app', external_id: app }),
        ]);
        expect((await inventory()).has(app)).toBe(false);

        // The company Work disappears with no event at all.
        await dataSource.getRepository(Work).delete({ id: company });
        expect(await mirror.reconcile()).toBe(true);
        await mirror.drainOnce();
        const held = await inventory();
        expect(held.has(company)).toBe(false);
        expect(held.has(site)).toBe(true);
        // The reconciliation deletes nothing here.
        expect(await dataSource.getRepository(Work).count()).toBe(2);
        expect((await mirror.status())?.reconciledAt).toBeTruthy();
    });

    it('the consent revoked in app.ever.co stops the mirror and drops what was owed', async () => {
        await listener.onWorkStatusChanged({ workId: site } as never);
        expect(await outboxRows()).toHaveLength(1);
        const link = await linkRow(acme.id);
        await admin('consent', {
            instance_id: (await connection.status()).platformInstanceId,
            integration: APP_SYNC_KEY,
            link: link?.platformLinkId,
            enabled: false,
        });
        await feed.pollOnce(0);
        await settle();
        expect(await outboxRows()).toEqual([]);
        expect((await mirror.enabledLinks()).size).toBe(0);

        const posts = (await rowCalls(15)).filter((entry) => entry.method === 'POST').length;
        await listener.onWorkStatusChanged({ workId: site } as never);
        await mirror.round();
        expect(await outboxRows()).toEqual([]);
        expect((await rowCalls(15)).filter((entry) => entry.method === 'POST')).toHaveLength(posts);
    });

    it('removing the link tells Ever Platform, archives it here and forgets its document', async () => {
        const link = await linkRow(acme.id);
        const subject = linkEntitlementSubject(link?.platformLinkId as string);
        const documents = dataSource.getRepository(EverConnectEntitlement);
        expect(await documents.findOne({ where: { subject } })).not.toBeNull();

        expect(await links.unlink(acme)).toEqual({
            connected: true,
            link: null,
            entitlement: null,
            appSync: false,
            canManage: true,
        });
        expect((await linkRow(acme.id))?.status).toBe('archived');
        expect(await documents.findOne({ where: { subject } })).toBeNull();
        expect(
            (await rowCalls(5)).filter((entry) => entry.method === 'DELETE').map((e) => e.status),
        ).toEqual([204]);

        // Ever Platform's own announcement of the unlink arrives on the feed: nothing more to do.
        await feed.pollOnce(0);
        expect((await linkRow(acme.id))?.status).toBe('archived');
        expect(await refusal(links.unlink(acme))).toEqual({ status: 404, code: 'not_linked' });
    });

    it('an Organization can be linked again; a link ended in app.ever.co ends here through the feed', async () => {
        await linkCode('EVL-TEST-0000-0007');
        const view = await links.link(acme, 'EVL-TEST-0000-0007');
        expect(view.link).toMatchObject({ everOrgId: GLOBEX.id, createdVia: 'link_code' });
        // The Organization's one row, active again under the new link.
        const rows = await dataSource
            .getRepository(EverConnectLink)
            .find({ where: { organizationId: acme.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('active');
        const linkId = rows[0].platformLinkId as string;

        // The link ends at Ever Platform (as when an owner removes it in
        // app.ever.co): this installation hears of it on its feed only.
        const client = await connection.client();
        await client!.instances.tenantLinks.remove(linkId);
        expect((await linkRow(acme.id))?.status).toBe('active');
        await feed.pollOnce(0);
        expect((await linkRow(acme.id))?.status).toBe('archived');
    });

    it('disconnecting ends the links, forgets the documents and the last heartbeat', async () => {
        await linkCode('EVL-TEST-0000-0006');
        await links.link(acme, 'EVL-TEST-0000-0006');
        expect((await linkRow(acme.id))?.status).toBe('active');

        await connection.disconnect();
        await settle();
        expect((await linkRow(acme.id))?.status).toBe('archived');
        const kept = await dataSource.getRepository(EverConnectEntitlement).find();
        expect(kept.map((row) => row.subject)).toEqual(['key-set']);
        expect(await heartbeat.lastSentAt()).toBeNull();
        expect(await entitlements.instanceView()).toBeNull();

        // Nothing is called after it.
        const calls = (await record()).length;
        await heartbeat.round();
        await entitlements.round();
        await mirror.round();
        expect(await record()).toHaveLength(calls);
    });
});
