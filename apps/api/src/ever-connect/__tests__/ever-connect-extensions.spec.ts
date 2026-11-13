import {
    EverConnectExtensions,
    type EverConnectFeedHandler,
    type EverConnectRoundParticipant,
} from '../ever-connect-extensions';

/**
 * Where the separately switched parts join the feed and the worker's round:
 * with none registered nothing changes; a part that fails in a round does not
 * stop the others; a part that cannot read a feed event stops the feed at that
 * event, so it is read again.
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
});
