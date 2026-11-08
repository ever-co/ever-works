import { createHash } from 'node:crypto';
import { INTEGRATIONS, type IntegrationKey } from '@ever-co/connect-contracts';
import {
    INSTANCE_WIDE_INTEGRATION_KEYS,
    WORKS_INTEGRATIONS,
    worksIntegration,
} from '../integration-definitions';
import {
    IntegrationHandlerConflictError,
    IntegrationHandlerRegistry,
} from '../integration-handler.registry';

/**
 * The scopes Works is reviewed against are the definitions of the SDK's
 * contracts package (`@ever-co/connect-contracts`), the data app.ever.co shows
 * its consent screen from. Each key Works offers pins the `scope_version` and
 * the SHA-256 of the scope; when a new package version changes a scope, this
 * fails until the pin is reviewed and updated.
 */

/** The SDK's digest of a scope: SHA-256 of its JSON with sorted keys, two-space indented, plus a newline. */
function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
                .sort()
                .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
        );
    }
    return value;
}
const scopeDigest = (scope: unknown): string =>
    createHash('sha256')
        .update(`${JSON.stringify(sortKeys(scope ?? []), null, 2)}\n`)
        .digest('hex');

describe('integration definitions', () => {
    it('Works offers exactly the SDK keys whose products include works', () => {
        const forWorks = Object.values(INTEGRATIONS)
            .filter((definition) => definition.products.includes('works'))
            .map((definition) => definition.key)
            .sort();
        expect(WORKS_INTEGRATIONS.map((definition) => definition.key).sort()).toEqual(forWorks);
    });

    it.each(WORKS_INTEGRATIONS.map((definition) => [definition.key, definition] as const))(
        '%s: the pinned scope version and digest are the scope shipped',
        (key, definition) => {
            const shared = INTEGRATIONS[key as IntegrationKey];
            expect(definition.scopeVersion).toBe(shared.scope_version);
            expect(scopeDigest(shared.scope)).toBe(definition.scopeSha256);
        },
    );

    it('provider_access and marketplace_installs are defined, per tenant link, gated by listings', () => {
        for (const key of ['provider_access', 'marketplace_installs'] as const) {
            const definition = worksIntegration(key);
            expect(definition).toMatchObject({ key, builtIn: false, instanceWide: false });
            expect(
                (INTEGRATIONS[key] as { requires_feature?: string | null }).requires_feature,
            ).toBe('listings');
        }
    });

    it('only the connection’s own integrations run without a handler', () => {
        expect(
            WORKS_INTEGRATIONS.filter((definition) => definition.builtIn)
                .map((definition) => definition.key)
                .sort(),
        ).toEqual(['ever_id_login', 'instance_url', 'stats_link', 'webhooks']);
        expect([...INSTANCE_WIDE_INTEGRATION_KEYS].sort()).toEqual([
            'ever_id_login',
            'instance_url',
            'stats_link',
            'webhooks',
        ]);
    });

    it('a changed scope without a new scope_version fails (control)', () => {
        const shared = INTEGRATIONS.marketplace_installs;
        const changed = [
            ...shared.scope,
            { ...shared.scope[0], field_path: 'install.tenant_name' },
        ];
        expect(scopeDigest(changed)).not.toBe(
            worksIntegration('marketplace_installs')!.scopeSha256,
        );
    });
});

describe('integration handler registry', () => {
    it('marketplace_installs is coming soon until its handler registers; provider_access stays so', () => {
        const registry = new IntegrationHandlerRegistry();
        expect(registry.offerable('marketplace_installs')).toBe(false);
        expect(registry.offerable('provider_access')).toBe(false);
        expect(registry.offerable('ever_id_login')).toBe(true);
        expect(registry.perLinkKeys()).toEqual([]);

        registry.register({ key: 'marketplace_installs' });
        expect(registry.offerable('marketplace_installs')).toBe(true);
        expect(registry.offerable('provider_access')).toBe(false);
        expect(registry.perLinkKeys()).toEqual(['marketplace_installs']);
    });

    it('a second handler for a key, or a key Works does not offer, is refused', () => {
        const registry = new IntegrationHandlerRegistry();
        const handler = { key: 'marketplace_installs' };
        registry.register(handler);
        registry.register(handler);
        expect(() => registry.register({ key: 'marketplace_installs' })).toThrow(
            IntegrationHandlerConflictError,
        );
        expect(() => registry.register({ key: 'billing_link' })).toThrow(/does not offer/);
    });
});
