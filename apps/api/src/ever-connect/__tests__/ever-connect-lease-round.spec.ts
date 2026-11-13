import type { DataSource } from 'typeorm';
import {
    EVER_CONNECT_LEASE_ROW_ID,
    EverConnectLease,
    EverConnectOutbox,
} from '@ever-works/agent/entities';
import { readEverConnectConfig } from '../ever-connect.config';
import { EverConnectExtensions } from '../ever-connect-extensions';
import type { EverConnectFeedService } from '../ever-connect-feed.service';
import type { EverConnectIntegrationService } from '../ever-connect-integration.service';
import {
    EVER_CONNECT_LEASE_HELD,
    EVER_CONNECT_LEASE_RENEW_MS,
    EVER_CONNECT_LEASE_TTL_MS,
    EverConnectLeaseService,
    type EverConnectRoundLease,
} from '../ever-connect-lease.service';
import { EverConnectOutboxService, EverConnectOutboxWorker } from '../ever-connect-outbox.service';
import { EverConnectRunner, FEED_PAGES_PER_ROUND } from '../ever-connect.runner';
import type { EverConnectService } from '../ever-connect.service';
import type { EverIdLoginHandler } from '../identity/ever-id-login.handler';
import type { PersonLinkReport } from '../identity/ever-connect-identity.ports';
import type { PersonLinkReporter, PersonLinkSendOutcome } from '../identity/person-link.reporter';
import { createIdentityDataSource } from '../identity/__tests__/db.helper-spec';
import type { InstallRequestsIntegration } from '../installs/install-requests.integration';

/**
 * The worker's lease over a round that takes longer than the lease lasts.
 *
 * The lease is taken at the start of a round and lasts two minutes. A round can
 * take longer (a long-poll, a backlog of feed pages, a full send of the apps
 * mirror), so it is renewed between the steps of the round, and a round stops
 * as soon as a renewal fails: two replicas must never run the worker at once.
 *
 * - the lease itself on a real database, with two replicas and a clock;
 * - the runner's round with every collaborator played, so the order of its
 *   steps and where it stops are what is asserted;
 * - the outbox's pass, which stops between two reports.
 */
describe("Ever Connect — the worker's lease during a round", () => {
    let dataSource: DataSource;

    beforeAll(async () => {
        dataSource = await createIdentityDataSource();
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await dataSource.getRepository(EverConnectLease).clear();
        await dataSource.getRepository(EverConnectOutbox).clear();
    });

    describe('the lease', () => {
        const T0 = Date.parse('2026-11-13T10:00:00.000Z');
        const replica = () =>
            new EverConnectLeaseService(dataSource.getRepository(EverConnectLease));
        const expiry = async () =>
            new Date(
                (
                    await dataSource
                        .getRepository(EverConnectLease)
                        .findOneOrFail({ where: { id: EVER_CONNECT_LEASE_ROW_ID } })
                ).expiresAt as Date,
            ).getTime();

        it('is not renewed while it is fresh, and is renewed once a renewal is due', async () => {
            const first = replica();
            let now = T0;
            expect(await first.hold(new Date(now))).toBe(true);
            const lease = first.roundLease(() => now);
            const hold = jest.spyOn(first, 'hold');

            now = T0 + EVER_CONNECT_LEASE_RENEW_MS - 1;
            expect(await lease.keep()).toBe(true);
            expect(hold).not.toHaveBeenCalled();
            expect(await expiry()).toBe(T0 + EVER_CONNECT_LEASE_TTL_MS);

            now = T0 + EVER_CONNECT_LEASE_RENEW_MS;
            expect(await lease.keep()).toBe(true);
            expect(hold).toHaveBeenCalledTimes(1);
            expect(await expiry()).toBe(now + EVER_CONNECT_LEASE_TTL_MS);
            expect(lease.held).toBe(true);

            // Fresh again: the next step costs no statement.
            now += 1000;
            expect(await lease.keep()).toBe(true);
            expect(hold).toHaveBeenCalledTimes(1);
        });

        it('a round longer than the lease keeps it, step after step; without renewal another replica takes it', async () => {
            const first = replica();
            const second = replica();
            let now = T0;
            expect(await first.hold(new Date(now))).toBe(true);
            const lease = first.roundLease(() => now);
            // Ten steps of 45 seconds: seven and a half minutes, almost four leases.
            for (let step = 0; step < 10; step += 1) {
                now += 45_000;
                expect(await lease.keep()).toBe(true);
                expect(await second.hold(new Date(now))).toBe(false);
            }
            expect(now - T0).toBeGreaterThan(3 * EVER_CONNECT_LEASE_TTL_MS);

            // Control: the same round without renewals loses the lease to the
            // other replica once it has run out.
            await dataSource.getRepository(EverConnectLease).clear();
            now = T0;
            expect(await first.hold(new Date(now))).toBe(true);
            now += EVER_CONNECT_LEASE_TTL_MS + 1000;
            expect(await second.hold(new Date(now))).toBe(true);
        });

        it('a renewal that finds the lease taken ends it for the round: no later step asks again', async () => {
            const first = replica();
            const second = replica();
            let now = T0;
            expect(await first.hold(new Date(now))).toBe(true);
            const lease = first.roundLease(() => now);

            // One step took longer than the lease lasts, and the other replica took over.
            now = T0 + EVER_CONNECT_LEASE_TTL_MS + 1000;
            expect(await second.hold(new Date(now))).toBe(true);
            const hold = jest.spyOn(first, 'hold');
            expect(await lease.keep()).toBe(false);
            expect(lease.held).toBe(false);
            expect(hold).toHaveBeenCalledTimes(1);

            now += 10 * EVER_CONNECT_LEASE_TTL_MS;
            expect(await lease.keep()).toBe(false);
            expect(hold).toHaveBeenCalledTimes(1);
            // The other replica's lease was not touched.
            expect(await second.hold(new Date(T0 + EVER_CONNECT_LEASE_TTL_MS + 2000))).toBe(true);
        });

        it('a renewal the database does not answer is a lost lease, not an error', async () => {
            const first = replica();
            let now = T0;
            await first.hold(new Date(now));
            const lease = first.roundLease(() => now);
            jest.spyOn(first, 'hold').mockRejectedValueOnce(new Error('database unavailable'));
            now += EVER_CONNECT_LEASE_RENEW_MS;
            await expect(lease.keep()).resolves.toBe(false);
            expect(lease.held).toBe(false);
        });

        it('a part run on its own, outside a round, is never held back', async () => {
            expect(await EVER_CONNECT_LEASE_HELD.keep()).toBe(true);
            expect(EVER_CONNECT_LEASE_HELD.held).toBe(true);
        });
    });

    describe("the runner's round", () => {
        /** A lease held for the first `keeps` renewals of a round and lost after. */
        const leaseLostAfter = (keeps: number) => {
            const lease = {
                asked: 0,
                held: true,
                keep: async () => {
                    lease.asked += 1;
                    lease.held = lease.held && lease.asked <= keeps;
                    return lease.held;
                },
            };
            return lease;
        };

        const setup = (
            lease: EverConnectRoundLease,
            options: { pages?: number; taken?: boolean } = {},
        ) => {
            const steps: string[] = [];
            let pagesLeft = options.pages ?? 1;
            const feed = {
                pollOnce: jest.fn(async () => {
                    steps.push('feed');
                    pagesLeft -= 1;
                    return { handled: 1, more: pagesLeft > 0 };
                }),
            };
            const outbox = {
                drainOnce: jest.fn(async (_now?: Date, given?: EverConnectRoundLease) => {
                    steps.push(given === lease ? 'outbox' : 'outbox without the lease');
                    return 0;
                }),
            };
            const installs = {
                round: jest.fn(async () => {
                    steps.push('installs');
                }),
            };
            const extensions = new EverConnectExtensions();
            for (const name of ['heartbeat', 'apps mirror']) {
                extensions.addRoundParticipant({
                    name,
                    round: async (_now, given) => {
                        steps.push(given === lease ? name : `${name} without the lease`);
                    },
                });
            }
            const runner = new EverConnectRunner(
                readEverConnectConfig({}),
                { client: async () => ({}) } as unknown as EverConnectService,
                {} as EverConnectIntegrationService,
                {} as EverIdLoginHandler,
                {
                    hold: jest.fn(async () => !options.taken),
                    release: jest.fn(),
                    roundLease: () => lease,
                } as unknown as EverConnectLeaseService,
                feed as unknown as EverConnectFeedService,
                outbox as unknown as EverConnectOutboxWorker,
                installs as unknown as InstallRequestsIntegration,
                extensions,
            );
            return { runner, steps, feed };
        };

        it('with the lease held: every step runs, in order, each with the lease of the round', async () => {
            const lease = leaseLostAfter(1000);
            const { runner, steps } = setup(lease);
            expect(await runner.round()).toBe(true);
            expect(steps).toEqual(['feed', 'outbox', 'installs', 'heartbeat', 'apps mirror']);
            // Renewed between the steps: before the outbox, the install reports
            // and each separately switched part.
            expect(lease.asked).toBe(4);
        });

        it('another replica holds the lease: nothing runs', async () => {
            const { runner, steps } = setup(leaseLostAfter(1000), { taken: true });
            expect(await runner.round()).toBe(false);
            expect(steps).toEqual([]);
        });

        it.each([
            ['after the feed', 0, ['feed']],
            ['after the outbox', 1, ['feed', 'outbox']],
            ['after the install reports', 2, ['feed', 'outbox', 'installs']],
            ['between two parts', 3, ['feed', 'outbox', 'installs', 'heartbeat']],
        ])('the lease is lost %s: the round stops there', async (_name, keeps, expected) => {
            const { runner, steps } = setup(leaseLostAfter(keeps as number));
            expect(await runner.round()).toBe(false);
            expect(steps).toEqual(expected);
        });

        it('a backlog of feed pages is read with the lease renewed before each page, and stops when it is lost', async () => {
            const held = leaseLostAfter(1000);
            const full = setup(held, { pages: 100 });
            expect(await full.runner.round()).toBe(true);
            expect(full.feed.pollOnce).toHaveBeenCalledTimes(FEED_PAGES_PER_ROUND);
            // Once before each further page, then before the three later steps.
            expect(held.asked).toBe(FEED_PAGES_PER_ROUND - 1 + 4);

            // Lost before the fourth page: three pages are read, and nothing after.
            const lost = setup(leaseLostAfter(2), { pages: 100 });
            expect(await lost.runner.round()).toBe(false);
            expect(lost.steps).toEqual(['feed', 'feed', 'feed']);
        });
    });

    describe("the outbox's pass", () => {
        const report = (id: string, userRef: string): PersonLinkReport => ({
            id,
            op: 'link',
            userRef,
            issuer: 'https://id.example.test',
            subject: `sub-${userRef}`,
            linkMethod: 'explicit',
        });

        it('renews the lease before each report and stops when it is lost; the rest stays owed, untouched', async () => {
            const repository = dataSource.getRepository(EverConnectOutbox);
            const queue = new EverConnectOutboxService(repository);
            for (const [id, user] of [
                ['r1', 'ada'],
                ['r2', 'bob'],
                ['r3', 'cy'],
            ]) {
                await queue.enqueue(report(id, user));
            }
            const sent: string[] = [];
            const reporter = {
                send: jest.fn(async (item: PersonLinkReport) => {
                    sent.push(item.id);
                    return { outcome: 'sent' } as PersonLinkSendOutcome;
                }),
            };
            const worker = new EverConnectOutboxWorker(
                repository,
                reporter as unknown as PersonLinkReporter,
            );
            let asked = 0;
            const lease: EverConnectRoundLease = {
                held: true,
                // Held before the first two reports, lost before the third.
                keep: async () => (asked += 1) <= 2,
            };
            const later = new Date(Date.now() + 1000);
            expect(await worker.drainOnce(later, lease)).toBe(2);
            expect(sent).toEqual(['r1', 'r2']);
            const left = await repository.find();
            expect(left).toHaveLength(1);
            expect(left[0]).toMatchObject({ state: 'pending', attempts: 0, lastError: null });
            expect((left[0].payload as { id: string }).id).toBe('r3');

            // The next pass that holds the lease sends it.
            expect(await worker.drainOnce(later)).toBe(1);
            expect(sent).toEqual(['r1', 'r2', 'r3']);
        });
    });
});
