import 'server-only';
import { appsCatalogAPI } from '@/lib/api/apps-catalog';
import { everConnectAPI } from '@/lib/api/ever-connect';
import { isOrganizationSlug, type WorkspaceScope } from '@/lib/workspace-scope';
import {
    organizationOfEverOrg,
    type AppBlueprintHandoff,
    type BlueprintHandoff,
} from './blueprint-handoff.shared';

/**
 * The server half of a Blueprint hand-off (`blueprint-handoff.shared.ts`): what
 * this installation's own Apps catalog and the person's own Organizations say
 * about the values the address carried. Neither function throws, and neither
 * decides anything: the create form still inspects the repository, and the API
 * settles the Blueprint and the Organization on its own.
 */

/**
 * What the App create form is given: the repository this installation's Apps
 * catalog names for the Blueprint, or none when the catalog does not have it,
 * lists it as not selectable, or cannot be read (the form then opens on the
 * catalog, without the Blueprint).
 *
 * The install travels on only with `keepInstall`: the caller says so when the
 * form is opened in the person's Organization linked to the Ever organization
 * the address named. Otherwise the form gets no install and no Ever
 * organization (the App can still be created; it is not bound to an install).
 */
export async function resolveBlueprintHandoff(
    handoff: BlueprintHandoff,
    { keepInstall = false }: { readonly keepInstall?: boolean } = {},
): Promise<AppBlueprintHandoff> {
    let repositoryUrl: string | null = null;
    try {
        const listing = await appsCatalogAPI.list(handoff.blueprint);
        const entry = listing.items.find((item) => item.id === handoff.blueprint);
        if (entry?.selectable && entry.upstream) repositoryUrl = entry.upstream.url;
    } catch {
        // Not readable here: the form says so and offers the catalog.
    }
    const bound = keepInstall && handoff.install !== null && handoff.everOrg !== null;
    return {
        blueprintId: handoff.blueprint,
        repositoryUrl,
        installId: bound ? handoff.install : null,
        everOrg: bound ? handoff.everOrg : null,
    };
}

/**
 * The workspace of the person's Organization linked to the Ever organization a
 * hand-off names, or `null` when there is none to go to: the hand-off names no
 * Ever organization, linking is not switched on here, the person has no
 * Organization linked to it, or the answer could not be read.
 */
export async function workspaceOfBlueprintHandoff(
    handoff: BlueprintHandoff,
): Promise<WorkspaceScope | null> {
    if (!handoff.everOrg) return null;
    try {
        const links = await everConnectAPI.organizationLinks({ kind: 'unknown' });
        if (!links) return null;
        const organization = organizationOfEverOrg(
            handoff.everOrg,
            links.map((item) => ({
                slug: item.slug,
                everOrgId: item.view?.link?.everOrgId ?? null,
                handle: item.view?.link?.handle ?? null,
            })),
        );
        return organization && isOrganizationSlug(organization.slug)
            ? { kind: 'organization', slug: organization.slug }
            : null;
    } catch {
        return null;
    }
}
