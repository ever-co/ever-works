/**
 * In-process events of the Ever Connect module (never forwarded by the public
 * webhook dispatcher; ids and states only).
 */

/** The connection changed: connected, approved, disconnected or revoked. */
export class EverConnectConnectionChangedEvent {
    static readonly EVENT_NAME = 'ever_connect.connection_changed';
    constructor(readonly status: 'disconnected' | 'pending_approval' | 'active' | 'revoked') {}
}

/**
 * An integration was turned on or off at Ever Platform: an installation-wide
 * one, or (with `linkId`) a per-link one for one tenant link.
 */
export class EverConnectIntegrationChangedEvent {
    static readonly EVENT_NAME = 'ever_connect.integration_changed';
    constructor(
        readonly integrationKey: string,
        readonly enabled: boolean,
        readonly linkId?: string,
    ) {}
}

/**
 * An Organization's link to its Ever organization was made (`linked`) or ended
 * (`unlinked`), here or at Ever Platform.
 */
export class EverConnectLinkChangedEvent {
    static readonly EVENT_NAME = 'ever_connect.link_changed';
    constructor(
        readonly organizationId: string,
        readonly change: 'linked' | 'unlinked',
        /** Ever Platform's id of the link, when it is known. */
        readonly platformLinkId: string | null,
    ) {}
}
