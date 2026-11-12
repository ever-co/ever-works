import { randomUUID } from 'node:crypto';
import type { FleetNodeCheckoutRecord } from '@ever-works/contracts';
import type { FleetCheckout } from '../../../entities/fleet-checkout.entity';
import type { FleetNode } from '../../../entities/fleet-node.entity';
import type { FleetCheckoutNodePort, FleetCheckoutNodeRequest } from '../fleet-checkout-node.port';
import type { FleetCheckoutRepository } from '../fleet-checkout.repository';
import { FleetCheckoutService } from '../fleet-checkout.service';

/**
 * FL-14 create × FL-15 FR-20 — **Fix on computer** with a FRESH CLONE of a
 * pull request whose head branch another checkout already holds.
 *
 * The branch rule (FR-19) suffixes a NEW name that is taken, but a fresh
 * clone checks out an existing remote branch as it is. The platform cannot
 * see a fresh clone's remote (there is no checkout to ask yet), so it used to
 * treat the pull request's head as merely "taken" and send `<head>-2`: the
 * session then worked on a branch the pull request does not have.
 *
 * The fake node below follows the node's half of the contract
 * (`checkout-operations.ts`): the clone fetched every remote head, so the
 * asked `existingBranch` is checked out when the remote has it, else
 * `branch`; `branch` itself tracks the remote's when there is one, else it is
 * made new. It reports the branch it ended on, as the real node does.
 */

const NODE_ID = 'node-1';
const USER_ID = 'user-1';
const ROOT = '/home/nina/ever-works/checkouts';
const REMOTE = 'https://github.com/acme/api.git';
const HEAD = 'nina/fix-login';

function nodeRow(): FleetNode {
    return {
        id: NODE_ID,
        userId: USER_ID,
        name: 'build-01',
        capabilities: ['git'],
        status: 'online',
    } as unknown as FleetNode;
}

function checkoutRow(overrides: Partial<FleetCheckout>): FleetCheckout {
    return {
        id: randomUUID(),
        nodeId: NODE_ID,
        userId: USER_ID,
        path: '/home/nina/code/api',
        kind: 'discovered',
        parentCheckoutId: null,
        remoteUrl: 'https://github.com/acme/api',
        remoteHadCredential: false,
        workId: null,
        branch: 'main',
        baseRef: null,
        isolation: 'host',
        state: 'ready',
        createdBy: 'discovery',
        gitLine: null,
        lastCommand: null,
        sizeBytes: null,
        lastSeenAt: null,
        archivedAt: null,
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
        updatedAt: new Date('2026-11-01T00:00:00.000Z'),
        ...overrides,
    } as FleetCheckout;
}

function memoryCheckouts(initial: FleetCheckout[]) {
    const rows = new Map(initial.map((row) => [row.id, { ...row }]));
    const repository = {
        rows,
        findById: async (id: string) => rows.get(id) ?? null,
        findForNode: async (nodeId: string) =>
            [...rows.values()].filter((row) => row.nodeId === nodeId),
        findForUser: async (userId: string) =>
            [...rows.values()].filter((row) => row.userId === userId),
        findByPath: async (nodeId: string, path: string) =>
            [...rows.values()].find((row) => row.nodeId === nodeId && row.path === path) ?? null,
        create: async (data: Partial<FleetCheckout>) => {
            const row = checkoutRow({ ...data, id: randomUUID() });
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
    return repository;
}

/** What the node would end on after `git clone` + its branch choice. */
function nodeBranchChoice(params: Record<string, unknown>, remoteHeads: readonly string[]): string {
    const existing = typeof params.existingBranch === 'string' ? params.existingBranch : null;
    if (existing && remoteHeads.includes(existing)) return existing;
    return params.branch as string;
}

function fakeNode(remoteHeads: readonly string[]) {
    const requests: FleetCheckoutNodeRequest[] = [];
    const port: FleetCheckoutNodePort = {
        isConnected: () => true,
        liveConsents: () => ({ work: true, attend: false, manage: true, usageScan: false }),
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
            if (input.verb === 'checkouts.create') {
                const params = input.params;
                const record: FleetNodeCheckoutRecord = {
                    path: params.path as string,
                    checkoutId: params.checkoutId as string,
                    kind: 'clone',
                    origin: 'platform',
                    parentPath: null,
                    remoteUrl: 'https://github.com/acme/api.git',
                    remoteHadCredential: false,
                    branch: nodeBranchChoice(params, remoteHeads),
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
            }
            throw new Error(`unexpected verb ${input.verb}`);
        },
    };
    return { port, requests };
}

function build(rows: FleetCheckout[], remoteHeads: readonly string[]) {
    const checkouts = memoryCheckouts(rows);
    const node = fakeNode(remoteHeads);
    const service = new FleetCheckoutService(
        checkouts as unknown as FleetCheckoutRepository,
        { findById: async () => nodeRow(), findByUser: async () => [nodeRow()] } as never,
        {
            resolveForFamily: async () => ({ node: nodeRow() }),
            listSharedWith: async () => [],
        } as never,
        { isStopped: async () => false } as never,
        { find: async () => [] } as never,
        undefined,
        node.port,
    );
    const createParams = () =>
        node.requests.find((request) => request.verb === 'checkouts.create')?.params ?? null;
    return { service, checkouts, createParams };
}

/** A worktree of the user's own clone, on this same computer, already on the pull request's head. */
const otherCheckoutOnHead = () =>
    checkoutRow({
        path: `${ROOT}/acme-api/fix-login`,
        kind: 'worktree',
        branch: HEAD,
        createdBy: 'user',
    });

describe('FleetCheckoutService.create — a fresh clone keeps the pull request’s branch (FL-15 FR-20)', () => {
    it('checks out the head branch the remote has, even though another checkout on this computer holds it', async () => {
        const { service, checkouts, createParams } = build(
            [checkoutRow({}), otherCheckoutOnHead()],
            ['main', HEAD],
        );

        const created = await service.create(
            { userId: USER_ID },
            { nodeId: NODE_ID, source: { kind: 'clone', repoUrl: REMOTE }, branch: HEAD },
        );

        // The checkout is on the pull request's branch — not on `<head>-2`.
        expect(created.checkout.branch).toBe(HEAD);
        expect(checkouts.rows.get(created.checkout.id)?.branch).toBe(HEAD);
        // The node is told which branch the person asked for, and the unique NEW name to make only when its clone
        // shows the remote does not have that branch (FR-19 still holds for a new branch).
        expect(createParams()).toMatchObject({ existingBranch: HEAD, branch: `${HEAD}-2` });
        // Named for the branch asked for; the other checkout's folder keeps the path unique.
        expect(created.checkout.path).toBe(`${ROOT}/acme-api/fix-login-2`);
    });

    it('checks out the head branch when a checkout on another computer holds it, in a folder named for it', async () => {
        const elsewhere = checkoutRow({ ...otherCheckoutOnHead(), nodeId: 'node-2' });
        const { service, createParams } = build([checkoutRow({}), elsewhere], ['main', HEAD]);

        const created = await service.create(
            { userId: USER_ID },
            { nodeId: NODE_ID, source: { kind: 'clone', repoUrl: REMOTE }, branch: HEAD },
        );

        expect(created.checkout.branch).toBe(HEAD);
        expect(created.checkout.path).toBe(`${ROOT}/acme-api/fix-login`);
        expect(createParams()).toMatchObject({ existingBranch: HEAD, branch: `${HEAD}-2` });
    });

    it('still makes a unique NEW branch when the remote does not have the asked one (FR-19)', async () => {
        const { service, createParams } = build([checkoutRow({}), otherCheckoutOnHead()], ['main']);

        const created = await service.create(
            { userId: USER_ID },
            { nodeId: NODE_ID, source: { kind: 'clone', repoUrl: REMOTE }, branch: HEAD },
        );

        expect(createParams()).toMatchObject({ existingBranch: HEAD, branch: `${HEAD}-2` });
        expect(created.checkout.branch).toBe(`${HEAD}-2`);
    });

    it('sends the branch as it is, with no existingBranch, when no checkout holds the name (the wire is unchanged)', async () => {
        const { service, createParams } = build([checkoutRow({})], ['main', HEAD]);

        const created = await service.create(
            { userId: USER_ID },
            { nodeId: NODE_ID, source: { kind: 'clone', repoUrl: REMOTE }, branch: HEAD },
        );

        expect(createParams()).toMatchObject({ branch: HEAD });
        expect(createParams()).not.toHaveProperty('existingBranch');
        expect(created.checkout.branch).toBe(HEAD);
        expect(created.checkout.path).toBe(`${ROOT}/acme-api/fix-login`);
    });

    it('leaves a worktree’s rule alone: a new worktree always cuts a NEW, unique branch', async () => {
        const parent = checkoutRow({
            kind: 'clone',
            createdBy: 'user',
            path: '/home/nina/code/api',
        });
        const { service, createParams } = build([parent, otherCheckoutOnHead()], ['main', HEAD]);

        await service.create(
            { userId: USER_ID },
            {
                nodeId: NODE_ID,
                source: { kind: 'worktree', parentCheckoutId: parent.id },
                branch: HEAD,
            },
        );

        expect(createParams()).toMatchObject({ branch: `${HEAD}-2` });
        expect(createParams()).not.toHaveProperty('existingBranch');
    });
});
