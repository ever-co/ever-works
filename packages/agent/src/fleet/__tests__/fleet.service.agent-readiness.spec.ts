import { createHash } from 'crypto';
import type { FleetAgentReadinessEntry, FleetAgentReadinessStored } from '@ever-works/contracts';
import { FleetNode } from '../../entities/fleet-node.entity';
import {
    FLEET_SHARED_VIEW_FIELDS,
    FleetService,
    agentReadinessView,
    applyReportedAgentReadiness,
} from '../fleet.service';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a'.repeat(43);
const TOKEN = 't'.repeat(43);

/** The sentence the production node failed every run with. */
const ORG_DISABLED =
    'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';

const node = (overrides: Partial<FleetNode> = {}): FleetNode =>
    ({
        id: NODE_ID,
        userId: 'user-1',
        organizationId: null,
        name: 'everdesk3-vm',
        kind: 'node',
        status: 'online',
        enrollmentTokenHash: sha256(SECRET),
        lastHeartbeatAt: new Date(),
        capabilities: ['claude-code'],
        capabilitiesPinned: false,
        platform: 'win32/x64',
        version: '0.2.10',
        cliVersion: 'claude 2.1.319',
        diskFreeBytes: null,
        minFreeDiskBytes: null,
        previousCredentialHash: null,
        previousCredentialExpiresAt: null,
        rotationRequestedAt: null,
        health: null,
        modelThrottles: null,
        agentReadiness: null,
        createdAt: new Date(),
        ...overrides,
    }) as FleetNode;

const agent = (overrides: Partial<FleetAgentReadinessEntry> = {}): FleetAgentReadinessEntry => ({
    provider: 'claude-code',
    installed: true,
    version: '2.1.319',
    signedIn: true,
    authMethod: 'subscription',
    account: 'owner@example.com (Acme, max)',
    status: 'ready',
    reason: null,
    checkedAt: '2026-11-10T12:00:00.000Z',
    ...overrides,
});

const report = (agents: FleetAgentReadinessEntry[]) => ({
    checkedAt: '2026-11-10T12:00:00.000Z',
    agents,
});

/**
 * Fleet agent readiness — the node's per-CLI report on the heartbeat path,
 * and the node-level answer every surface reads.
 *
 * The properties: the stored report carries the PLATFORM's receipt time; it
 * holds only what the contract knows, with anything credential-shaped
 * masked; a beat without one (an older daemon) leaves the stored one alone
 * and a node that never reported reads "unknown", never "no agent can work";
 * and `anyAgentReady` is true exactly when one installed agent is `ready`
 * and the platform is not throttling it.
 */
describe('FleetService — agent readiness on the heartbeat', () => {
    let repository: {
        findById: jest.Mock;
        update: jest.Mock;
        consumeEnrollment: jest.Mock;
        findByCredentialHash: jest.Mock;
    };

    beforeEach(() => {
        repository = {
            findById: jest.fn(async () => node()),
            update: jest.fn(async () => undefined),
            consumeEnrollment: jest.fn(async () => true),
            findByCredentialHash: jest.fn(async () => null),
        };
    });

    const build = () => new FleetService(repository as never);
    const patchOf = () => repository.update.mock.calls[0][1] as Partial<FleetNode>;

    it('stores the report stamped with the platform’s receipt time and serves it on the view', async () => {
        const before = Date.now();
        const result = await build().heartbeat(NODE_ID, SECRET, {
            agents: report([agent()]),
        });

        const stored = patchOf().agentReadiness as FleetAgentReadinessStored;
        expect(stored.agents).toEqual([agent()]);
        expect(Date.parse(stored.at)).toBeGreaterThanOrEqual(before);
        expect(stored.at).toBe((patchOf().lastHeartbeatAt as Date).toISOString());
        expect(result?.node.agentReadiness).toEqual({ ...stored, anyReady: true });
        expect(result?.node.anyAgentReady).toBe(true);
    });

    it('online, CLI installed, signed in — and no agent can work (the production case)', async () => {
        const result = await build().heartbeat(NODE_ID, SECRET, {
            agents: report([
                agent({
                    status: 'access_denied',
                    reason: ORG_DISABLED,
                    lastFailureAt: '2026-11-10T11:59:00.000Z',
                }),
                agent({
                    provider: 'codex',
                    installed: false,
                    version: null,
                    signedIn: null,
                    authMethod: 'unknown',
                    account: null,
                    status: 'not_installed',
                }),
            ]),
        });

        expect(result?.node.status).toBe('online');
        expect(result?.node.cliVersion).toBe('claude 2.1.319');
        expect(result?.node.anyAgentReady).toBe(false);
        expect(result?.node.agentReadiness?.agents[0]).toMatchObject({
            status: 'access_denied',
            reason: ORG_DISABLED,
        });
    });

    it('a beat without a report leaves the stored one alone (an older daemon keeps beating)', async () => {
        const previous: FleetAgentReadinessStored = {
            at: '2026-11-10T11:00:00.000Z',
            ...report([agent()]),
        };
        repository.findById.mockResolvedValue(node({ agentReadiness: previous }));

        const result = await build().heartbeat(NODE_ID, SECRET, { version: '0.2.10' });

        expect(patchOf()).not.toHaveProperty('agentReadiness');
        expect(result?.node.status).toBe('online');
    });

    it('a node that kept beating without a report for long reads unknown again (a downgraded daemon)', async () => {
        const previous: FleetAgentReadinessStored = {
            at: new Date(Date.now() - 60 * 60_000).toISOString(),
            ...report([agent()]),
        };
        repository.findById.mockResolvedValue(node({ agentReadiness: previous }));

        const result = await build().heartbeat(NODE_ID, SECRET, { version: '0.2.9' });

        // Nothing is erased; the hour-old report is simply no longer served.
        expect(patchOf()).not.toHaveProperty('agentReadiness');
        expect(result?.node.agentReadiness).toBeNull();
        expect(result?.node.anyAgentReady).toBeNull();
    });

    it('a node that never reported reads unknown — never "no agent can work"', async () => {
        const result = await build().heartbeat(NODE_ID, SECRET, { version: '0.2.9' });
        expect(result?.node.agentReadiness).toBeNull();
        expect(result?.node.anyAgentReady).toBeNull();
    });

    it('an EMPTY list is a real report: this machine has no agent CLI', async () => {
        repository.findById.mockResolvedValue(
            node({ agentReadiness: { at: '2026-11-10T11:00:00.000Z', ...report([agent()]) } }),
        );
        const result = await build().heartbeat(NODE_ID, SECRET, { agents: report([]) });
        expect((patchOf().agentReadiness as FleetAgentReadinessStored).agents).toEqual([]);
        expect(result?.node.anyAgentReady).toBe(false);
    });

    it.each([[null], ['ready'], [42], [[]], [{}], [{ agents: 'none' }]])(
        'junk in the field (%j) is not a report: nothing is stored and the beat is still accepted',
        async (agents) => {
            const result = await build().heartbeat(NODE_ID, SECRET, { agents });
            expect(patchOf()).not.toHaveProperty('agentReadiness');
            expect(result?.node.status).toBe('online');
        },
    );

    it('stores only what the contract knows, with anything credential-shaped masked', async () => {
        // Credential-SHAPED fixtures, assembled at runtime from plainly fake
        // parts so no line here can be taken for a real key. Not credentials.
        const fakeApiKey = ['sk', 'ant', 'api03', 'FAKE'.repeat(8)].join('-');
        const fakeToken = ['sk', 'ant', 'oat01', 'FAKE'.repeat(4)].join('-');
        await build().heartbeat(NODE_ID, SECRET, {
            agents: {
                checkedAt: '2026-11-10T12:00:00.000Z',
                agents: [
                    {
                        ...agent({
                            status: 'not_signed_in',
                            reason: `Invalid API key ${fakeApiKey} · Fix external API key`,
                        }),
                        status: 'not_signed_in',
                        credentials: { accessToken: fakeToken },
                        configDirectory: 'C:\\Users\\owner\\.claude',
                    },
                    { provider: 'codex', installed: true, status: 'levitating' },
                ],
            },
        });

        const stored = patchOf().agentReadiness as FleetAgentReadinessStored;
        expect(stored.agents[0]).not.toHaveProperty('credentials');
        expect(stored.agents[0]).not.toHaveProperty('configDirectory');
        expect(stored.agents[0]?.reason).toBe('Invalid API key [redacted] · Fix external API key');
        // A status a newer node invented is "unknown", never trusted verbatim.
        expect(stored.agents[1]?.status).toBe('unknown');
        expect(JSON.stringify(stored)).not.toContain('FAKE');
    });

    it('enrolment stores a report the same way when one arrives (the DTO is shared with the beat)', async () => {
        repository.findByCredentialHash.mockResolvedValue(
            node({
                status: 'enrolling',
                enrollmentTokenHash: sha256(TOKEN),
                credentialIssuedAt: new Date(),
            }),
        );
        const result = await build().enroll(TOKEN, { agents: report([agent()]) });
        const patch = repository.consumeEnrollment.mock.calls[0][2] as Partial<FleetNode>;
        expect(patch.agentReadiness?.agents).toEqual([agent()]);
        expect(result?.node.anyAgentReady).toBe(true);
    });
});

describe('applyReportedAgentReadiness', () => {
    it('falls back to the receipt time when the node sent no usable instant', () => {
        const patch: Partial<FleetNode> = {};
        applyReportedAgentReadiness(
            { agents: { agents: [{ provider: 'codex', installed: true, status: 'ready' }] } },
            patch,
            new Date('2026-11-10T12:00:05.000Z'),
        );
        expect(patch.agentReadiness).toMatchObject({
            at: '2026-11-10T12:00:05.000Z',
            checkedAt: '2026-11-10T12:00:05.000Z',
        });
        expect(patch.agentReadiness?.agents[0]?.checkedAt).toBe('2026-11-10T12:00:05.000Z');
    });

    it('writes nothing when the beat carried no report', () => {
        const patch: Partial<FleetNode> = {};
        applyReportedAgentReadiness({}, patch, new Date());
        applyReportedAgentReadiness({ agents: undefined }, patch, new Date());
        expect(patch).toEqual({});
    });
});

describe('agentReadinessView — the node-level answer', () => {
    const stored = (agents: FleetAgentReadinessEntry[]): FleetAgentReadinessStored => ({
        at: '2026-11-10T12:00:01.000Z',
        ...report(agents),
    });

    it('true when at least one installed agent is ready', () => {
        expect(
            agentReadinessView({
                agentReadiness: stored([
                    agent({ status: 'access_denied', reason: ORG_DISABLED }),
                    agent({ provider: 'codex', authMethod: 'api_key', account: null }),
                ]),
                modelThrottles: null,
            }).anyAgentReady,
        ).toBe(true);
    });

    it.each([
        ['not_signed_in'],
        ['access_denied'],
        ['limit_reached'],
        ['not_installed'],
        ['unsupported'],
        ['unknown'],
    ] as const)('false when the only agent is %s', (status) => {
        expect(
            agentReadinessView({
                agentReadiness: stored([agent({ status })]),
                modelThrottles: null,
            }).anyAgentReady,
        ).toBe(false);
    });

    it('false when the node reported no agent at all; null when it never reported', () => {
        expect(
            agentReadinessView({ agentReadiness: stored([]), modelThrottles: null }).anyAgentReady,
        ).toBe(false);
        expect(agentReadinessView({ agentReadiness: null, modelThrottles: null })).toEqual({
            agentReadiness: null,
            anyAgentReady: null,
        });
    });

    it('an agent the platform is throttling is not ready, until the throttle has passed', () => {
        const row = {
            agentReadiness: stored([agent()]),
            modelThrottles: [
                {
                    provider: 'claude-code',
                    window: 'weekly' as const,
                    until: new Date(Date.now() + 3_600_000).toISOString(),
                    reason: "You've hit your weekly limit",
                    since: new Date().toISOString(),
                },
            ],
        };
        const throttled = agentReadinessView(row);
        expect(throttled.anyAgentReady).toBe(false);
        expect(throttled.agentReadiness?.agents[0]).toMatchObject({
            status: 'limit_reached',
            reason: "You've hit your weekly limit",
            limitResetsAt: row.modelThrottles[0].until,
        });

        // An expired throttle is not in force: the node's own word stands.
        const expired = agentReadinessView({
            ...row,
            modelThrottles: [{ ...row.modelThrottles[0], until: '2020-01-01T00:00:00.000Z' }],
        });
        expect(expired.anyAgentReady).toBe(true);
    });

    it('a row holding junk reads never reported rather than throwing', () => {
        expect(
            agentReadinessView({ agentReadiness: 'oops' as never, modelThrottles: null })
                .anyAgentReady,
        ).toBeNull();
    });
});

describe('the shared view (someone else’s computer)', () => {
    it('does not carry the report, the answer or the run stats — sharing them is a decision, not a side effect', () => {
        for (const field of ['agentReadiness', 'anyAgentReady', 'runStats'] as const) {
            expect(FLEET_SHARED_VIEW_FIELDS).not.toContain(field);
        }
    });
});
