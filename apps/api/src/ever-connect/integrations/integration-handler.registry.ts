import { Injectable } from '@nestjs/common';
import { WORKS_INTEGRATIONS, worksIntegration } from './integration-definitions';

/**
 * What one integration runs on this installation once Ever Platform reads it
 * as enabled: the code that makes it more than a row of the consent catalog.
 *
 * - `onDisabled`: it went off (switched off, revoked, denied, unlinked or the
 *   connection ended). It must not throw: the integration is off whatever it
 *   does.
 */
export interface IntegrationHandler {
    readonly key: string;
    onDisabled?(): Promise<void>;
}

/** A second handler for a key that already has one. */
export class IntegrationHandlerConflictError extends Error {
    constructor(key: string) {
        super(`The integration ${key} already has a handler.`);
        this.name = 'IntegrationHandlerConflictError';
    }
}

/**
 * The handlers of the integrations this installation runs beyond the ones the
 * connection itself runs. An integration Works offers without a handler here
 * stays "coming soon": its state is not kept and nothing of it moves, whatever
 * Ever Platform says. Registering a handler is all it takes to make one
 * offerable.
 */
@Injectable()
export class IntegrationHandlerRegistry {
    private readonly handlers = new Map<string, IntegrationHandler>();

    /** Adds the handler of `handler.key`; a key Works does not offer, or a second handler, is refused. */
    register(handler: IntegrationHandler): void {
        if (!worksIntegration(handler.key)) {
            throw new Error(`Ever Works does not offer the integration ${handler.key}.`);
        }
        const existing = this.handlers.get(handler.key);
        if (existing && existing !== handler) {
            throw new IntegrationHandlerConflictError(handler.key);
        }
        this.handlers.set(handler.key, handler);
    }

    has(key: string): boolean {
        return this.handlers.has(key);
    }

    get(key: string): IntegrationHandler | null {
        return this.handlers.get(key) ?? null;
    }

    /** Whether `key` is offerable here: built into the connection, or with a registered handler. */
    offerable(key: string): boolean {
        const definition = worksIntegration(key);
        return definition !== null && (definition.builtIn || this.handlers.has(key));
    }

    /** The per-link keys with a handler: their states are kept for each tenant link. */
    perLinkKeys(): string[] {
        return WORKS_INTEGRATIONS.filter(
            (definition) => !definition.instanceWide && this.handlers.has(definition.key),
        ).map((definition) => definition.key);
    }
}
