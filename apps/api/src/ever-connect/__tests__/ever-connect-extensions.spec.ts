import { EverConnectFeedService } from '../ever-connect-feed.service';
import type { EverConnectIntegrationService } from '../ever-connect-integration.service';
import type { EverConnectRoundLease } from '../ever-connect-lease.service';
import type { EverConnectService } from '../ever-connect.service';
import type { PersonRequestsHandler } from '../identity/person-requests.handler';
import {
    EverConnectExtensions,
    type EverConnectFeedHandler,
    type EverConnectRoundParticipant,
} from '../ever-connect-extensions';

/**
 * Where the separately switched parts join the feed and the worker's round:
 * with none registered nothing changes; a part that fails in a round does not
 * stop the others; the worker's lease is renewed before each part and the round
 * stops when it is lost; a part that cannot read a feed event stops the feed at
 * that event, so it is read again.
 */
describe('EverConnectExtensions', () => {
    const NOW = new Date('2026-11-13T10:00:00.000Z');

    it('with nothing registered: no event is read, a round does nothing, the mirror is off', async () => {
        const extensions = new EverConnectExtensions();
        expect(extensions.handlesFeedEvent('ever.registry.tenant_link.unlinked')).toBe(false);
        await extensions.dispatchFeedEvent({ id: 'e1', type: 'anything', data: {} });
        await extensions.runRound(NOW);
        expect(await extensions.appSyncStatus()).toBeNull();
        expect(await extensions.appSyncRunsFor('organization')).toBe(false);
    });

    it('a part that fails in a round does not stop the others, and the round does not throw', async () => {
        const extensions = new EverConnectExtensions();
        const ran: string[] = [];
        const part = (name: string, fail = false): EverConnectRoundParticipant => ({
            name,
            round: async (now) => {
                ran.push(`${name}@${now.toISOString()}`);
                if (fail) throw new Error('boom');
            },
        });
        const first = part('first');
        extensions.addRoundParticipant(first);
        extensions.addRoundParticipant(part('failing', true));
        extensions.addRoundParticipant(part('last'));
        // Registered twice: runs once.
        extensions.addRoundParticipant(first);
        await expect(extensions.runRound(NOW)).resolves.toBeUndefined();
        expect(ran).toEqual([
            `first@${NOW.toISOString()}`,
            `failing@${NOW.toISOString()}`,
            `last@${NOW.toISOString()}`,
        ]);
    });

    it("the worker's lease is renewed before each part, handed to it, and a lost lease stops the round", async () => {
        const extensions = new EverConnectExtensions();
        const ran: string[] = [];
        const handed: EverConnectRoundLease[] = [];
        for (const name of ['heartbeat', 'entitlements', 'apps mirror']) {
            extensions.addRoundParticipant({
                name,
                round: async (_now, lease) => {
                    ran.push(name);
                    handed.push(lease);
                },
            });
        }
        let asked = 0;
        const lease: EverConnectRoundLease = {
            held: true,
            // Held before the first two parts, lost before the third.
            keep: async () => (asked += 1) <= 2,
        };
        await extensions.runRound(NOW, lease);
        expect(ran).toEqual(['heartbeat', 'entitlements']);
        expect(asked).toBe(3);
        expect(handed).toEqual([lease, lease]);

        // Control: a lease that is held runs all three.
        ran.length = 0;
        await extensions.runRound(NOW, { held: true, keep: async () => true });
        expect(ran).toEqual(['heartbeat', 'entitlements', 'apps mirror']);
        // Run on its own (no lease given): nothing holds a part back.
        ran.length = 0;
        await extensions.runRound(NOW);
        expect(ran).toEqual(['heartbeat', 'entitlements', 'apps mirror']);
    });

    it('a feed event goes to every part that reads its type, and only to those', async () => {
        const extensions = new EverConnectExtensions();
        const seen: string[] = [];
        const handler = (name: string, type: string): EverConnectFeedHandler => ({
            name,
            handles: (candidate) => candidate === type,
            handle: async (event) => {
                seen.push(`${name}:${event.id}`);
            },
        });
        extensions.addFeedHandler(handler('links', 'ever.registry.tenant_link.unlinked'));
        extensions.addFeedHandler(handler('entitlements', 'ever.entitlements.entitlement.issued'));
        extensions.addFeedHandler(handler('audit', 'ever.registry.tenant_link.unlinked'));
        expect(extensions.handlesFeedEvent('ever.registry.tenant_link.unlinked')).toBe(true);
        expect(extensions.handlesFeedEvent('ever.consent.consent.granted')).toBe(false);
        await extensions.dispatchFeedEvent({
            id: 'e1',
            type: 'ever.registry.tenant_link.unlinked',
            data: {},
        });
        expect(seen).toEqual(['links:e1', 'audit:e1']);
    });

    it('a part that cannot read a feed event stops the feed there (the event is read again)', async () => {
        const extensions = new EverConnectExtensions();
        extensions.addFeedHandler({
            name: 'links',
            handles: () => true,
            handle: async () => {
                throw new Error('database unavailable');
            },
        });
        await expect(
            extensions.dispatchFeedEvent({ id: 'e1', type: 'x', data: {} }),
        ).rejects.toThrow('database unavailable');
    });

    it('a mirror that cannot answer reads as off, never as an error', async () => {
        const extensions = new EverConnectExtensions();
        extensions.provideAppSync({
            status: async () => {
                throw new Error('boom');
            },
            runsFor: async () => {
                throw new Error('boom');
            },
        });
        expect(await extensions.appSyncStatus()).toBeNull();
        expect(await extensions.appSyncRunsFor('organization')).toBe(false);
    });

    it('on the feed: an event a part could not read is not acknowledged, and is read again on the next pass', async () => {
        const events = ['e1', 'e2', 'e3'].map((id) => ({
            id,
            type: 'ever.registry.tenant_link.unlinked',
            data: { tenant_link_id: id },
        }));
        let cursor: string | null = null;
        const acknowledged: string[] = [];
        const client = {
            instances: {
                events: async (after: string | null) => ({
                    events: events.slice(events.findIndex((event) => event.id === after) + 1),
                    has_more: false,
                    last_id: 'e3',
                }),
                ackEvents: async (id: string) => {
                    acknowledged.push(id);
                    return { acknowledged: id };
                },
            },
        };
        const connection = {
            client: async () => client,
            connection: async () => ({ lastFeedCursor: cursor }),
            saveFeedCursor: async (next: string) => {
                cursor = next;
            },
        } as unknown as EverConnectService;

        const extensions = new EverConnectExtensions();
        const read: string[] = [];
        let broken = true;
        extensions.addFeedHandler({
            name: 'links',
            handles: (type) => type === 'ever.registry.tenant_link.unlinked',
            handle: async (event) => {
                if (event.id === 'e2' && broken) throw new Error('database unavailable');
                read.push(event.id);
            },
        });
        const feed = new EverConnectFeedService(
            connection,
            { refresh: async () => [] } as unknown as EverConnectIntegrationService,
            { handles: () => false } as unknown as PersonRequestsHandler,
            undefined,
            extensions,
        );

        // The pass stops at the event that failed: only what came before is acknowledged.
        expect(await feed.pollOnce(0)).toEqual({ handled: 1, more: false });
        expect(read).toEqual(['e1']);
        expect(acknowledged).toEqual(['e1']);
        expect(cursor).toBe('e1');

        // Still failing: nothing moves, nothing is skipped.
        expect(await feed.pollOnce(0)).toEqual({ handled: 0, more: false });
        expect(acknowledged).toEqual(['e1']);

        // Readable again: the same event is delivered again, then the rest.
        broken = false;
        expect(await feed.pollOnce(0)).toEqual({ handled: 2, more: false });
        expect(read).toEqual(['e1', 'e2', 'e3']);
        expect(acknowledged).toEqual(['e1', 'e3']);
        expect(cursor).toBe('e3');
    });
});
