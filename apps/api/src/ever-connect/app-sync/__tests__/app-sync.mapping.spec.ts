import {
    appDelete,
    appUpsert,
    deploymentExternalId,
    deploymentStatus,
    deploymentUpsert,
    deployTarget,
    publicAddress,
    type DeploymentFacts,
    type WorkFacts,
} from '../app-sync.mapping';

/**
 * What the apps mirror sends, field by field. The allow-lists below are the
 * whole of it: a field that is not in them never leaves the installation.
 */
const NOW = new Date('2026-11-13T10:00:00.000Z');
const WORK_ID = '9c0a3f7e-2b1d-4c8e-9f11-0a2b3c4d5e6f';
const LINK = { tenantId: '5f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f', productOrgRef: 'acme' };

const APP_DATA_KEYS = [
    'base_kind',
    'kind',
    'name',
    'product_org_id',
    'product_tenant_id',
    'slug',
    'status',
    'work_kind',
];
const DEPLOYMENT_DATA_KEYS = [
    'environment',
    'managed_by',
    'provider',
    'shape',
    'status',
    'target',
    'url',
];
const OP_KEYS = [
    'app_external_id',
    'data',
    'external_id',
    'external_version',
    'kind',
    'occurred_at',
    'op',
];

/** A Work as the database holds it, with everything the mirror must never send. */
const fullWork = (overrides: Record<string, unknown> = {}) =>
    ({
        id: WORK_ID,
        name: 'Acme Store',
        slug: 'acme-store',
        kind: 'website',
        status: 'active',
        updatedAt: new Date('2026-11-13T09:00:00.000Z'),
        description: 'SECRET-DESCRIPTION',
        owner: 'SECRET-OWNER',
        website: 'https://SECRET-WEBSITE.example',
        companyName: 'SECRET-COMPANY',
        committerEmail: 'secret@example.test',
        sourceRepository: { url: 'https://example.test/SECRET-REPO' },
        deployRuntimeEnvEncrypted: 'SECRET-ENV',
        webhookSecretEncrypted: 'SECRET-HOOK',
        readmeConfig: { header: 'SECRET-README' },
        user: { email: 'secret-user@example.test' },
        ...overrides,
    }) as unknown as WorkFacts;

const fullDeployment = (overrides: Record<string, unknown> = {}) =>
    ({
        workId: WORK_ID,
        environment: 'production',
        provider: 'ever-works',
        appTarget: null,
        state: 'READY',
        website: 'https://store.acme.example/',
        updatedAt: new Date('2026-11-13T09:30:00.000Z'),
        branch: 'SECRET-BRANCH',
        commitSha: 'SECRET-SHA',
        prNumber: 4242,
        lastError: 'SECRET-BUILD-LOG',
        providerProjectId: 'SECRET-PROJECT',
        providerDeploymentId: 'SECRET-DEPLOYMENT',
        triggeredByUserId: 'SECRET-USER',
        appRender: { namespace: 'SECRET-NAMESPACE' },
        componentStatuses: [{ name: 'SECRET-COMPONENT' }],
        ...overrides,
    }) as unknown as DeploymentFacts;

/** An operation's `data`, read loosely. */
const dataOf = (op: unknown) => (op as { data: Record<string, unknown> }).data;

describe('apps mirror — what an operation carries', () => {
    it('an app upsert carries the id, the kind, the name, the slug and the status, and nothing else', () => {
        const op = appUpsert(fullWork(), LINK, 1_800_000_000_000, NOW);
        expect(op).toEqual({
            op: 'upsert',
            kind: 'app',
            external_id: WORK_ID,
            external_version: 1_800_000_000_000,
            occurred_at: '2026-11-13T09:00:00.000Z',
            data: {
                product_tenant_id: LINK.tenantId,
                product_org_id: 'acme',
                kind: 'work',
                work_kind: 'website',
                name: 'Acme Store',
                slug: 'acme-store',
                base_kind: 'none',
                status: 'active',
            },
        });
        expect(Object.keys(op as object).every((key) => OP_KEYS.includes(key))).toBe(true);
        expect(Object.keys(dataOf(op)).sort()).toEqual(APP_DATA_KEYS);
        expect(JSON.stringify(op)).not.toMatch(/SECRET|secret|@/);
    });

    it('a deployment upsert carries where it runs, its state and its address, and nothing else', () => {
        const op = deploymentUpsert(fullDeployment(), 1_800_000_000_001, NOW);
        expect(op).toEqual({
            op: 'upsert',
            kind: 'deployment',
            external_id: `${WORK_ID}:production`,
            external_version: 1_800_000_000_001,
            occurred_at: '2026-11-13T09:30:00.000Z',
            app_external_id: WORK_ID,
            data: {
                target: 'ever-works',
                provider: 'ever-works',
                shape: 'k8s-works-shared',
                managed_by: 'ever',
                environment: 'production',
                status: 'READY',
                url: 'https://store.acme.example/',
            },
        });
        expect(Object.keys(dataOf(op)).sort()).toEqual(DEPLOYMENT_DATA_KEYS);
        expect(JSON.stringify(op)).not.toMatch(/SECRET|4242/);
    });

    it('a delete carries the id and a version', () => {
        expect(appDelete(WORK_ID, 7, NOW)).toEqual({
            op: 'delete',
            kind: 'app',
            external_id: WORK_ID,
            external_version: 7,
            occurred_at: NOW.toISOString(),
        });
        expect(appDelete('not an id', 7, NOW)).toBeNull();
    });

    it("a Work's kind is told in Ever Platform's words, or left out", () => {
        const kindOf = (kind: string | null) => dataOf(appUpsert(fullWork({ kind }), LINK, 1, NOW));
        expect(kindOf('app')).toMatchObject({ kind: 'app' });
        expect(kindOf('app')).not.toHaveProperty('work_kind');
        expect(kindOf('landing-page')).toMatchObject({ kind: 'work', work_kind: 'website' });
        expect(kindOf('awesome-repo')).toMatchObject({ kind: 'work', work_kind: 'awesome' });
        expect(kindOf('company')).toMatchObject({ kind: 'work', work_kind: 'company' });
        expect(kindOf('campaign')).toMatchObject({ kind: 'work', work_kind: 'campaign' });
        expect(kindOf(null)).toMatchObject({ kind: 'work', work_kind: 'default' });
        // A kind Ever Platform has no word for is sent without one.
        expect(kindOf('repo')).toMatchObject({ kind: 'work' });
        expect(kindOf('repo')).not.toHaveProperty('work_kind');
        expect(kindOf('project')).not.toHaveProperty('work_kind');
    });

    it('every lifecycle status of a Work is sent as it is; any other word is not sent', () => {
        for (const status of ['draft', 'active', 'registered', 'archived']) {
            expect(appUpsert(fullWork({ status }), LINK, 1, NOW)).toMatchObject({
                data: { status },
            });
        }
        expect(appUpsert(fullWork({ status: 'generating' }), LINK, 1, NOW)).toBeNull();
        expect(appUpsert(fullWork({ status: null }), LINK, 1, NOW)).toBeNull();
    });

    it('a name is plain text of at most 200 characters; without one the slug stands in', () => {
        const nameOf = (overrides: Record<string, unknown>) =>
            dataOf(appUpsert(fullWork(overrides), LINK, 1, NOW)).name as string;
        expect(nameOf({ name: '  Acme\u0000\nStore\t ' })).toBe('Acme  Store');
        expect(nameOf({ name: 'x'.repeat(500) })).toHaveLength(200);
        expect(nameOf({ name: '   ' })).toBe('acme-store');
        expect(appUpsert(fullWork({ slug: '' }), LINK, 1, NOW)).toBeNull();
    });

    it('a Work whose ids cannot be told is not sent', () => {
        expect(appUpsert(fullWork({ id: 'has space' }), LINK, 1, NOW)).toBeNull();
        expect(
            appUpsert(fullWork(), { ...LINK, productOrgRef: 'no spaces allowed' }, 1, NOW),
        ).toBeNull();
        expect(appUpsert(fullWork(), { ...LINK, tenantId: '' }, 1, NOW)).toBeNull();
    });

    it('a change dated in the future is dated now', () => {
        const op = appUpsert(fullWork({ updatedAt: new Date('2030-01-01') }), LINK, 1, NOW);
        expect(op?.occurred_at).toBe(NOW.toISOString());
    });
});

describe('apps mirror — where a deployment runs', () => {
    it.each([
        [
            { provider: 'k8s', appTarget: 'your-cluster' },
            undefined,
            {
                target: 'your-cluster',
                provider: 'k8s',
                shape: 'custom-kubeconfig',
                managed_by: 'customer',
            },
        ],
        [
            { provider: 'k8s', appTarget: 'ever-works-apps' },
            undefined,
            {
                target: 'ever-works-apps',
                provider: 'k8s',
                shape: 'k8s-works-shared',
                managed_by: 'ever',
            },
        ],
        [
            { provider: 'ever-works', appTarget: null },
            undefined,
            {
                target: 'ever-works',
                provider: 'ever-works',
                shape: 'k8s-works-shared',
                managed_by: 'ever',
            },
        ],
        [
            { provider: 'k8s', appTarget: null },
            'custom-kubeconfig',
            { target: 'k8s', provider: 'k8s', shape: 'custom-kubeconfig', managed_by: 'customer' },
        ],
        [
            { provider: 'k8s', appTarget: null },
            'k8s-works-shared',
            { target: 'k8s', provider: 'k8s', shape: 'k8s-works-shared', managed_by: 'ever' },
        ],
        [
            { provider: 'k8s', appTarget: null },
            'k8s-works',
            { target: 'k8s', provider: 'k8s', shape: 'k8s-works', managed_by: 'ever' },
        ],
        [
            // The cluster source could not be read: the plugin's own default.
            { provider: 'k8s', appTarget: null },
            null,
            { target: 'k8s', provider: 'k8s', shape: 'custom-kubeconfig', managed_by: 'customer' },
        ],
        [
            { provider: 'some-host', appTarget: null },
            undefined,
            {
                target: 'some-host',
                provider: 'some-host',
                shape: 'provider-plugin',
                managed_by: 'third_party',
            },
        ],
        [
            // A provider id is made a word of the open vocabulary.
            { provider: 'Some Host!', appTarget: null },
            undefined,
            {
                target: 'some-host',
                provider: 'some-host',
                shape: 'provider-plugin',
                managed_by: 'third_party',
            },
        ],
    ])('%j (cluster source %s)', (deployment, clusterSource, expected) => {
        expect(deployTarget(deployment, clusterSource)).toEqual(expected);
    });

    it('a deployment without a provider is not sent', () => {
        expect(deployTarget({ provider: null, appTarget: null })).toBeNull();
        expect(deployTarget({ provider: '   ', appTarget: null })).toBeNull();
        expect(deploymentUpsert(fullDeployment({ provider: '' }), 1, NOW)).toBeNull();
    });

    it('every state of a deployment row is sent in the words Ever Platform reads', () => {
        for (const state of [
            'INITIALIZING',
            'BUILDING',
            'DEPLOYING',
            'VERIFYING',
            'READY',
            'ERROR',
            'CANCELED',
            'TIMEOUT',
            'ROLLED_BACK',
            'SUPERSEDED',
        ]) {
            expect(deploymentStatus(state)).toBe(state);
        }
        expect(deploymentStatus('not a state')).toBe('pending');
        expect(deploymentStatus(null)).toBe('pending');
        expect(deploymentStatus('X'.repeat(33))).toBe('pending');
    });

    it('an address is sent without credentials, a query or a fragment, or not at all', () => {
        expect(publicAddress('https://store.acme.example')).toBe('https://store.acme.example/');
        expect(publicAddress('store.acme.example/shop')).toBe('https://store.acme.example/shop');
        expect(publicAddress('http://store.acme.example:8080/a?token=SECRET#frag')).toBe(
            'http://store.acme.example:8080/a',
        );
        for (const bad of [
            'https://user:password@store.acme.example/',
            'javascript:alert(1)',
            'ftp://store.acme.example/',
            'data:text/html,x',
            '',
            '   ',
            null,
            `https://store.acme.example/${'a'.repeat(2100)}`,
        ]) {
            expect(publicAddress(bad)).toBeNull();
        }
        const op = deploymentUpsert(
            fullDeployment({ website: 'https://user:password@store.acme.example/' }),
            1,
            NOW,
        );
        expect(dataOf(op)).not.toHaveProperty('url');
    });

    it('a deployment is one per Work and environment', () => {
        expect(deploymentExternalId(WORK_ID, 'preview')).toBe(`${WORK_ID}:preview`);
        expect(deploymentUpsert(fullDeployment({ environment: 'preview' }), 1, NOW)).toMatchObject({
            external_id: `${WORK_ID}:preview`,
            data: { environment: 'preview' },
        });
        // An environment the contract has no word for is the production one.
        expect(deploymentUpsert(fullDeployment({ environment: 'staging' }), 1, NOW)).toMatchObject({
            external_id: `${WORK_ID}:production`,
            data: { environment: 'production' },
        });
    });
});
