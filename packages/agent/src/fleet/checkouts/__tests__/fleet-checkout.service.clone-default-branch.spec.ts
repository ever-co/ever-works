import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type { FleetLinkError, FleetNodeCheckoutRecord } from '@ever-works/contracts';
import type { FleetCheckout } from '../../../entities/fleet-checkout.entity';
import type { FleetNode } from '../../../entities/fleet-node.entity';
import type { FleetCheckoutNodePort, FleetCheckoutNodeRequest } from '../fleet-checkout-node.port';
import type { FleetCheckoutRepository } from '../fleet-checkout.repository';
import { FleetCheckoutException } from '../fleet-checkout.errors';
import { FleetCheckoutService } from '../fleet-checkout.service';

/**
 * FL-14 FR-16 — a fresh clone with no branch named (the New checkout dialog's
 * default, the CLI without `--branch`, `fleet_checkouts_create` and
 * `POST /api/fleet/checkouts` without one). The platform sends `branch: null`
 * and the node stays on what it cloned; a node from before that refuses
 * `branch: null` as an invalid branch, and the person is told what to do
 * instead of reading "branch".
 */

const NODE_ID = 'node-1';
const USER_ID = 'user-1';
const ROOT = '/home/nina/ever-works/checkouts';
const REMOTE = 'https://github.com/acme/api.git';

function nodeRow(): FleetNode {
    return {
        id: NODE_ID,
        userId: USER_ID,
        name: 'build-01',
        capabilities: ['git'],
        status: 'online',
    } as unknown as FleetNode;
}

function memoryCheckouts() {
    const rows = new Map<string, FleetCheckout>();
    const store = {
        rows,
        findById: async (id: string) => rows.get(id) ?? null,
        findForNode: async (nodeId: string) =>
            [...rows.values()].filter((row) => row.nodeId === nodeId),
        findForUser: async (userId: string) =>
            [...rows.values()].filter((row) => row.userId === userId),
        findByPath: async (nodeId: string, path: string) =>
            [...rows.values()].find((row) => row.nodeId === nodeId && row.path === path) ?? null,
        /** Called before each insert: a test stands in for a create in flight on the same node. */
        beforeInsert: null as null | ((data: Partial<FleetCheckout>) => void),
        create: async (data: Partial<FleetCheckout>) => {
            store.beforeInsert?.(data);
            // `uq_fleet_checkouts_node_path`, as the database holds it.
            if (
                [...rows.values()].some(
                    (row) => row.nodeId === data.nodeId && row.path === data.path,
                )
            ) {
                throw Object.assign(
                    new Error(
                        'duplicate key value violates unique constraint "uq_fleet_checkouts_node_path"',
                    ),
                    { code: '23505' },
                );
            }
            const row = {
                ...data,
                id: randomUUID(),
                createdAt: new Date(),
                updatedAt: new Date(),
            } as FleetCheckout;
            rows.set(row.id, row);
            return row;
        },
        update: async (id: string, patch: Partial<FleetCheckout>) => {
            const row = rows.get(id);
            if (row) rows.set(id, { ...row, ...patch } as FleetCheckout);
        },
        delete: async (id: string) => {
            rows.delete(id);
        },
    };
    return store;
}

const OPERATION_ID = '44444444-4444-4444-8444-444444444444';

/**
 * A node that clones and stays on the default branch — or, `older`, refuses `branch: null` as today's do.
 * `operation`: the clone outlasts the request and continues as a link operation (its result arrives later).
 */
function fakeNode(behaviour: 'current' | 'older', mode: 'inline' | 'operation' = 'inline') {
    const requests: FleetCheckoutNodeRequest[] = [];
    const port: FleetCheckoutNodePort = {
        isConnected: () => true,
        liveConsents: () => ({ work: false, attend: false, manage: true, usageScan: false }),
        request: async (input) => {
            requests.push(input);
            if (input.verb === 'checkouts.list') {
                return {
                    result: {
                        checkouts: [],
                        complete: false,
                        truncated: false,
                        codeFolders: [],
                        scannedAt: null,
                        checkoutsRoot: ROOT,
                    },
                };
            }
            const params = input.params;
            if (behaviour === 'older' && typeof params.branch !== 'string') {
                // The link's envelope for the node's refusal (FleetLinkException).
                const error: FleetLinkError = {
                    code: 'invalid',
                    hint: 'branch',
                    details: { field: 'branch' },
                };
                throw new HttpException({ error }, 400);
            }
            if (mode === 'operation') return { operationId: OPERATION_ID };
            const record: FleetNodeCheckoutRecord = {
                path: params.path as string,
                checkoutId: params.checkoutId as string,
                kind: 'clone',
                origin: 'platform',
                parentPath: null,
                remoteUrl: REMOTE,
                remoteHadCredential: false,
                branch: typeof params.branch === 'string' ? params.branch : 'main',
                baseRef: null,
                headSha: null,
                isolation: 'host',
                present: true,
                gitLine: null,
                sizeBytes: null,
                busy: null,
                reaperNote: null,
                lastUsedAt: null,
            };
            return {
                result: {
                    checkoutId: params.checkoutId,
                    path: params.path,
                    exitCode: 0,
                    stderrHead: null,
                    checkout: record,
                },
            };
        },
    };
    return { port, requests };
}

function build(behaviour: 'current' | 'older', mode: 'inline' | 'operation' = 'inline') {
    const checkouts = memoryCheckouts();
    const node = fakeNode(behaviour, mode);
    const audits: Array<{ action: string; details: Record<string, unknown> }> = [];
    const service = new FleetCheckoutService(
        checkouts as unknown as FleetCheckoutRepository,
        { findById: async () => nodeRow(), findByUser: async () => [nodeRow()] } as never,
        {
            resolveForFamily: async () => ({ node: nodeRow() }),
            listSharedWith: async () => [],
        } as never,
        { isStopped: async () => false } as never,
        { find: async () => [] } as never,
        {
            tryRecord: async (entry: { action: string; details: Record<string, unknown> }) => {
                audits.push(entry);
            },
        } as never,
        node.port,
    );
    const createParams = () =>
        node.requests.find((request) => request.verb === 'checkouts.create')?.params ?? null;
    const createAudit = () =>
        audits.find((entry) => entry.action === 'node.checkout.create')?.details ?? null;
    return { service, checkouts, node, createParams, createAudit };
}

describe('FleetCheckoutService.create — a clone with no branch named (FL-14 FR-16)', () => {
    it('asks the node for the clone with branch null and ends on the branch the node reports', async () => {
        const { service, createParams } = build('current');

        const created = await service.create(
            { userId: USER_ID },
            { nodeId: NODE_ID, source: { kind: 'clone', repoUrl: REMOTE } },
        );

        expect(createParams()).toMatchObject({ branch: null, baseRef: null });
        expect(created.checkout.path).toBe(`${ROOT}/acme-api/api`);
        expect(created.checkout.state).toBe('ready');
        expect(created.checkout.branch).toBe('main');
    });

    it('tells the person what to do when an older node refuses the branchless clone', async () => {
        const { service, checkouts } = build('older');

        const refusal = await service
            .create(
                { userId: USER_ID },
                { nodeId: NODE_ID, source: { kind: 'clone', repoUrl: REMOTE } },
            )
            .then(
                () => null,
                (error: unknown) => error,
            );

        expect(refusal).toBeInstanceOf(FleetCheckoutException);
        const typed = (refusal as FleetCheckoutException).checkoutError;
        expect(typed.code).toBe('invalid');
        expect(typed.hint).toMatch(/older Ever Works node/);
        expect(typed.hint).toMatch(/name one, or update the node/);
        expect(typed.details).toMatchObject({ field: 'branch' });
        // Refused before the machine did anything: no row is left behind.
        expect(checkouts.rows.size).toBe(0);
    });

    it('lets a named branch through untouched, as before', async () => {
        const { service, createParams } = build('older');

        const created = await service.create(
            { userId: USER_ID },
            {
                nodeId: NODE_ID,
                source: { kind: 'clone', repoUrl: REMOTE },
                branch: 'nina/fix-login',
            },
        );

        expect(createParams()).toMatchObject({ branch: 'nina/fix-login' });
        expect(created.checkout.branch).toBe('nina/fix-login');
    });
});

describe('FleetCheckoutService.create — review fixes for a clone with no branch named (FL-14 FR-16)', () => {
    const clone = { nodeId: NODE_ID, source: { kind: 'clone' as const, repoUrl: REMOTE } };

    it('leaves `branch` out of the audit row while a slow clone is still choosing (CONTRACTS Revision 27)', async () => {
        const { service, createAudit } = build('current', 'operation');

        const created = await service.create({ userId: USER_ID }, clone);

        expect(created.operationId).toBe(OPERATION_ID);
        expect(created.checkout.state).toBe('creating');
        const details = createAudit();
        expect(details).toMatchObject({ kind: 'clone', outcome: 'started' });
        // Not `branch: null` for good: the clone ends on the default branch, which nothing knows yet.
        expect(details).not.toHaveProperty('branch');
    });

    it('records the branch the node reported when the clone answers within the request', async () => {
        const { service, createAudit } = build('current');

        await service.create({ userId: USER_ID }, clone);

        expect(createAudit()).toMatchObject({ branch: 'main', outcome: 'done' });
    });

    it('treats an explicit `branch: null` and `baseRef: null` as absent, as MCP tools and generated clients send them', async () => {
        const { service, createParams } = build('current');

        const created = await service.create(
            { userId: USER_ID },
            { ...clone, branch: null, baseRef: null },
        );

        expect(createParams()).toMatchObject({ branch: null, baseRef: null });
        expect(created.checkout.state).toBe('ready');
        expect(created.checkout.branch).toBe('main');
    });

    it('still refuses a branch name that is not one', async () => {
        const { service } = build('current');

        const refusal = await service.create({ userId: USER_ID }, { ...clone, branch: '-x' }).then(
            () => null,
            (error: unknown) => error,
        );

        expect((refusal as FleetCheckoutException).checkoutError).toMatchObject({
            code: 'invalid',
            details: { field: 'branch' },
        });
    });

    it('takes the next free folder when a create in flight took the one it picked (uq_fleet_checkouts_node_path)', async () => {
        const { service, checkouts, createParams } = build('current');
        // Another clone of the same repository, with no branch named either, inserts `…/api` between this
        // create's read of the node's rows and its own insert.
        let raced = false;
        checkouts.beforeInsert = (data) => {
            if (raced) return;
            raced = true;
            const racing = {
                ...data,
                id: randomUUID(),
                createdAt: new Date(),
                updatedAt: new Date(),
            } as FleetCheckout;
            checkouts.rows.set(racing.id, racing);
        };

        const created = await service.create({ userId: USER_ID }, clone);

        expect(created.checkout.path).toBe(`${ROOT}/acme-api/api-2`);
        expect(createParams()).toMatchObject({ path: `${ROOT}/acme-api/api-2` });
        expect([...checkouts.rows.values()].map((row) => row.path).sort()).toEqual([
            `${ROOT}/acme-api/api`,
            `${ROOT}/acme-api/api-2`,
        ]);
    });

    it('two clones of one repository at once on one computer end in two folders', async () => {
        const { service } = build('current');

        const [first, second] = await Promise.all([
            service.create({ userId: USER_ID }, clone),
            service.create({ userId: USER_ID }, clone),
        ]);

        expect([first.checkout.path, second.checkout.path].sort()).toEqual([
            `${ROOT}/acme-api/api`,
            `${ROOT}/acme-api/api-2`,
        ]);
    });

    it('does not retry an insert that failed for another reason', async () => {
        const { service, checkouts, node } = build('current');
        checkouts.beforeInsert = () => {
            throw new Error('connection reset');
        };

        await expect(service.create({ userId: USER_ID }, clone)).rejects.toThrow(
            'connection reset',
        );
        expect(node.requests.some((request) => request.verb === 'checkouts.create')).toBe(false);
    });
});
