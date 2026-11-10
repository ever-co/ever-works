import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FLEET_AGENT_READINESS_STATUSES } from '@ever-works/contracts';
import { EnrollFleetNodeDto, FleetHeartbeatDto } from './fleet.dto';

/**
 * Fleet agent readiness — the heartbeat DTO's half of the compatibility
 * contract, both ways.
 *
 * The global pipe runs `whitelist + forbidNonWhitelisted`, so a field the
 * DTO does not accept is not dropped: it fails the whole request, and a
 * failed heartbeat is a node that goes offline. Pinned here:
 *
 *   - an OLDER node that sends no `agents` must still beat (`@IsOptional`);
 *   - a NEWER node whose report carries a status, a key or a whole nested
 *     shape this API has never heard of must still beat (`@IsObject`, no
 *     nested whitelist) — the service keeps what it knows and drops the rest.
 *
 * The node-side half — that a daemon keeps beating when a 400 says the API
 * predates the field — lives in `apps/node/src/core/heartbeat.spec.ts`.
 */

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a'.repeat(43);

async function failingProperties(dto: object): Promise<string[]> {
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    return errors.map((error) => error.property).sort();
}

const beat = (extra: Record<string, unknown>) =>
    plainToInstance(FleetHeartbeatDto, { nodeId: NODE_ID, secret: SECRET, ...extra });

const agent = (overrides: Record<string, unknown> = {}) => ({
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

describe('FleetHeartbeatDto — agent readiness', () => {
    it('accepts a beat that says nothing about its agents (every daemon in the field today)', async () => {
        await expect(failingProperties(beat({}))).resolves.toEqual([]);
    });

    it.each(FLEET_AGENT_READINESS_STATUSES.map((status) => [status]))(
        'accepts a report whose agent is %s',
        async (status) => {
            await expect(
                failingProperties(
                    beat({
                        agents: {
                            checkedAt: '2026-11-10T12:00:00.000Z',
                            agents: [agent({ status })],
                        },
                    }),
                ),
            ).resolves.toEqual([]);
        },
    );

    it('accepts the full shape: usage windows, reset, last success', async () => {
        const dto = beat({
            agents: {
                checkedAt: '2026-11-10T12:00:00.000Z',
                agents: [
                    agent({
                        status: 'limit_reached',
                        reason: "You've hit your weekly limit · resets Nov 12, 3am",
                        limitResetsAt: '2026-11-12T02:00:00.000Z',
                        usage: [
                            {
                                window: 'five_hour',
                                usedPercent: 42.5,
                                resetsAt: '2026-11-10T15:00:00.000Z',
                            },
                            { window: 'weekly', usedPercent: 100, resetsAt: null, limited: true },
                        ],
                        usageObservedAt: '2026-11-10T11:30:00.000Z',
                        lastSuccessAt: '2026-11-10T10:00:00.000Z',
                        lastFailureAt: '2026-11-10T11:30:00.000Z',
                    }),
                    agent({ provider: 'codex', installed: false, status: 'not_installed' }),
                ],
            },
        });
        await expect(failingProperties(dto)).resolves.toEqual([]);
    });

    it('accepts what a NEWER node invented, rather than failing the beat', async () => {
        // A 400 here would take a live machine offline for reporting the
        // truth about itself; the service reads the unknown status as
        // "unknown" and drops the keys it does not know.
        const dto = beat({
            agents: {
                checkedAt: '2026-11-10T12:00:00.000Z',
                schemaVersion: 7,
                agents: [
                    agent({
                        status: 'needs_reauthentication',
                        authMethod: 'passkey',
                        quota: { tokensLeft: 12 },
                    }),
                ],
                fleetWide: { anything: ['goes'] },
            },
        });
        await expect(failingProperties(dto)).resolves.toEqual([]);
    });

    it('accepts an empty list: "this machine has no agent CLI" is a real report', async () => {
        await expect(
            failingProperties(
                beat({ agents: { checkedAt: '2026-11-10T12:00:00.000Z', agents: [] } }),
            ),
        ).resolves.toEqual([]);
    });

    it.each([['ready'], [42], [true], [[agent()]]])(
        'rejects a value that is not an object at all (%j)',
        async (agents) => {
            await expect(failingProperties(beat({ agents }))).resolves.toEqual(['agents']);
        },
    );

    it('is accepted on the enrol body too — the self-description is shared', async () => {
        const dto = plainToInstance(EnrollFleetNodeDto, {
            token: 't'.repeat(43),
            agents: { checkedAt: '2026-11-10T12:00:00.000Z', agents: [agent()] },
        });
        await expect(failingProperties(dto)).resolves.toEqual([]);
    });

    it('passes the global pipe exactly as the API configures it, nested keys intact', async () => {
        const pipe = new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        });
        const body = {
            nodeId: NODE_ID,
            secret: SECRET,
            agents: {
                checkedAt: '2026-11-10T12:00:00.000Z',
                agents: [agent({ status: 'access_denied', future: 'field' })],
            },
        };
        const result = (await pipe.transform(body, {
            type: 'body',
            metatype: FleetHeartbeatDto,
        })) as FleetHeartbeatDto;
        // Not whitelisted field by field: the service does the normalising.
        expect(result.agents).toEqual(body.agents);

        // And the pipe still refuses a top-level field nobody declared — the
        // very behaviour an OLDER API shows a newer node's `agents`.
        await expect(
            pipe.transform(
                { ...body, somethingNobodyDeclared: 1 },
                { type: 'body', metatype: FleetHeartbeatDto },
            ),
        ).rejects.toMatchObject({ status: 400 });
    });
});
