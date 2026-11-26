/**
 * The k8s plugin's "Default ingress host" (`ingressHost`) may not be saved under a platform root
 * domain.
 *
 * A shared-cluster k8s Work with no website deploys on the member's saved `ingressHost`, so a saved
 * `login.ever.works` reaches the shared cluster's Ingress exactly as a custom domain would. The
 * refusal happens when the value is SAVED; deploy time only warns (`DeployService`), because a
 * platform-owned Work already deploys on a saved host under the root and must keep working.
 *
 * The rule looks at the NEW value only:
 * - it applies to plugin `k8s` and its `ingressHost` field, nothing else;
 * - a value that is absent, `null` (cleared) or blank is never refused;
 * - a value equal (after normalization) to one already stored is never refused, so a stored value
 *   cannot block saving the plugin's other settings;
 * - anything else equal to or under one of `config.everWorks.platformRootDomains()` is refused with
 *   the same coded 400 as "Add custom domain" (`PLATFORM_DOMAIN_NOT_ALLOWED`).
 *
 * Every member-facing writer calls it before it writes: `PluginSettingsService`
 * (`validateAndSeparateSettings`, user and Work scope), `PluginOperationsService` (enable and update,
 * user and Work scope) and the account import.
 */
import { BadRequestException } from '@nestjs/common';

import { config } from '../../config';
import {
    matchPlatformRootDomain,
    normalizePlatformHost,
    platformDomainNotAllowedBody,
    platformIngressHostRefusalMessage,
} from '../../utils/platform-host';

/** The plugin the rule applies to. */
export const K8S_INGRESS_HOST_PLUGIN_ID = 'k8s';

/** The setting the rule applies to. */
export const K8S_INGRESS_HOST_SETTING = 'ingressHost';

type SettingsBag = Readonly<Record<string, unknown>> | null | undefined;

/**
 * The platform root a NEW k8s `ingressHost` in `incoming` is under, or `null` when the value may be
 * saved. `stored` holds the settings already saved (the same scope, and for a Work the inherited
 * user scope); a value equal to one of them is not new.
 */
export function refusedK8sIngressHostRoot(
    pluginId: string,
    incoming: SettingsBag,
    ...stored: SettingsBag[]
): string | null {
    if (pluginId !== K8S_INGRESS_HOST_PLUGIN_ID || !incoming) return null;

    const next = incoming[K8S_INGRESS_HOST_SETTING];
    if (typeof next !== 'string') return null;
    const normalized = normalizePlatformHost(next);
    if (!normalized) return null;

    const unchanged = stored.some((bag) => {
        const previous = bag?.[K8S_INGRESS_HOST_SETTING];
        return typeof previous === 'string' && normalizePlatformHost(previous) === normalized;
    });
    if (unchanged) return null;

    return matchPlatformRootDomain(normalized, config.everWorks.platformRootDomains());
}

/**
 * Throws the coded 400 (`{ status: 'error', code: 'PLATFORM_DOMAIN_NOT_ALLOWED', message }`) when
 * {@link refusedK8sIngressHostRoot} refuses the incoming value.
 */
export function assertK8sIngressHostAllowed(
    pluginId: string,
    incoming: SettingsBag,
    ...stored: SettingsBag[]
): void {
    const root = refusedK8sIngressHostRoot(pluginId, incoming, ...stored);
    if (root !== null) {
        throw new BadRequestException(
            platformDomainNotAllowedBody(root, platformIngressHostRefusalMessage(root)),
        );
    }
}
