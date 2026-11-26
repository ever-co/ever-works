import type { EverPlatformEntitlementView } from '@ever-works/contracts';

/**
 * The Ever Platform integrations Ever Works runs for a linked Organization
 * whose availability a plan decides, and the entitlement feature each one
 * needs: Ever Platform's integration catalog (`requires_feature`, spelled
 * there `apps` and `listings`) in the feature keys of an entitlement document.
 * Ever Platform refuses to enable such an integration for an organization
 * whose plan lacks the feature; with `EVER_CONNECT_ENTITLEMENT_GATES_ENABLED`
 * Ever Works also stops running it when a later document no longer grants the
 * feature, or when the document is past its grace period.
 *
 * - `app_sync` (the apps mirror) needs `app_sync`;
 * - `marketplace_installs` (install requests from apps.ever.co) needs
 *   `listings`.
 *
 * Nothing else is gated. Ever Works' own features (Works, Apps, builds,
 * deployments, members) never depend on a document; the document's limits are
 * enforced by Ever Platform. Sign in with Ever ID (`ever_id_login`) is left
 * out on purpose: a document that could not be refreshed must never lock
 * people out of their installation.
 */
export const ENTITLEMENT_GATED_INTEGRATIONS: Readonly<Record<string, string>> = Object.freeze({
    app_sync: 'app_sync',
    marketplace_installs: 'listings',
});

/** The entitlement feature an integration needs, or `null` when a plan does not decide it. */
export function entitlementFeatureOf(integrationKey: string): string | null {
    return Object.prototype.hasOwnProperty.call(ENTITLEMENT_GATED_INTEGRATIONS, integrationKey)
        ? ENTITLEMENT_GATED_INTEGRATIONS[integrationKey]
        : null;
}

/**
 * Whether a stored document grants `feature`: a document in date or in its
 * grace period whose `features` say `true`. No document, a paused one (past
 * its grace period, or one that could never be read) and a feature it does
 * not name all answer `false`: closed, like the document's own key set.
 */
export function grantsFeature(
    view: Pick<EverPlatformEntitlementView, 'status' | 'features'> | null | undefined,
    feature: string,
): boolean {
    if (!view || (view.status !== 'valid' && view.status !== 'grace')) return false;
    return view.features?.[feature] === true;
}
