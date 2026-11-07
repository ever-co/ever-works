// Types only: the SDK's contracts package is a test dependency of the API (the
// drift spec reads the definitions from it); nothing here loads it at run time.
import type { IntegrationKey } from '@ever-co/connect-contracts';

/**
 * The Ever Platform integrations Ever Works offers, as data. What each one
 * moves (its scope rows, purpose, retention and frequency) comes from the Ever
 * Platform SDK's definitions, the same data app.ever.co renders its consent
 * screen from; this file adds what is Works' own:
 *
 * - `scopeVersion` and `scopeSha256` pin the scope this release was reviewed
 *   with: when the SDK's scope changes, `definitions.drift.spec.ts` fails until
 *   the pin is reviewed and updated;
 * - `builtIn`: the integrations the connection itself runs (`instance_url`,
 *   `stats_link`, `ever_id_login`, `webhooks`: accepted by the operator on the
 *   connection's own routes). Every other one is offerable only once a handler
 *   is registered for it ({@link IntegrationHandlerRegistry}); without one it
 *   is "coming soon" here whatever Ever Platform says, and nothing of it moves.
 *   `marketplace_installs` has its handler (install requests from apps.ever.co);
 *   `provider_access` has none in Works;
 * - `instanceWide`: the integration acts for the whole installation; every
 *   other one is consented per tenant link.
 */
export interface WorksIntegrationDefinition {
    readonly key: IntegrationKey;
    readonly scopeVersion: number;
    readonly scopeSha256: string;
    readonly builtIn: boolean;
    readonly instanceWide: boolean;
}

/** The integrations that act for the whole installation (as Ever Platform's consent catalog). */
export const INSTANCE_WIDE_INTEGRATION_KEYS: ReadonlySet<string> = new Set([
    'instance_url',
    'stats_link',
    'ever_id_login',
    'webhooks',
]);

const pin = (
    key: IntegrationKey,
    scopeSha256: string,
    builtIn: boolean,
    scopeVersion = 1,
): WorksIntegrationDefinition =>
    Object.freeze({
        key,
        scopeVersion,
        scopeSha256,
        builtIn,
        instanceWide: INSTANCE_WIDE_INTEGRATION_KEYS.has(key),
    });

/** Every integration key Ever Works offers, with its pinned scope. */
export const WORKS_INTEGRATIONS: ReadonlyArray<WorksIntegrationDefinition> = Object.freeze([
    pin('instance_url', '4d49f2e6b58f02e7476680daad357fba6a3f0af18e7c1e393e8707d7ca120cf3', true),
    pin('stats_link', '390773fb3fbffb6d5b48d2d6f220a2a0a827fd6ff01cbd66cd3186062eabe437', true),
    pin(
        'ever_id_login',
        '38f54c9ca4d9fc6f09208a38d07c0bd0bbbfd4fda1b6e9cdbe4cadc4163cd87e',
        true,
        2,
    ),
    pin('webhooks', 'f96fa2e6fd604320f3649e8d9200b270927cc32ff9af6c78b2ca7b66e08c3bc7', true),
    pin(
        'counterparty_lookup',
        '67ad3983e9ac1f6cafdeee3aacf8b6ecad95bc72d878cd92f7711031bcfc88ce',
        false,
    ),
    pin(
        'counterparty_discoverable',
        '170ea9ef4df68381e0b94f81b83154e0a67b7d3b7a59269b09462c22f1171c9f',
        false,
    ),
    pin(
        'profile_import',
        '23cc377dc8172f610704e18908a826c45d03a1096fa43f0c907d842568f6d582',
        false,
    ),
    pin(
        'usage_reporting',
        'b4c8eb301eca01068617b749162548324275e8ee6d3bd82e68cf8809eadcde2f',
        false,
    ),
    pin('app_sync', '12e10672c4e3d16a1440c5c9483e91cc1db31793f231601456b198f83f887000', false),
    pin(
        'managed_operations',
        '4c09674f3374371a30cb96298e1fda97277ba2ad13ca05accbe2362938a1db93',
        false,
    ),
    // A service provider's access to the installation: no handler in Works, so
    // it stays "coming soon" here and nothing of it moves.
    pin(
        'provider_access',
        '8f7f959b0ba746bd27f97426aad84e7e5bf7571293a40fc115d86af16dbce23a',
        false,
    ),
    // Install requests from apps.ever.co: offerable once its handler is
    // registered (the install-requests module of Ever Connect).
    pin(
        'marketplace_installs',
        '467cea708e8881aa2a03feaeb6dedf08a7960c2b583c3f321628f0aaf399b3e6',
        false,
    ),
]);

/** Works' definition of `key`, or `null` when Works does not offer it. */
export function worksIntegration(key: string): WorksIntegrationDefinition | null {
    return WORKS_INTEGRATIONS.find((definition) => definition.key === key) ?? null;
}
