import { isAppWorkKind, isProjectWorkKind, isRepositoryWorkKind } from '@ever-works/contracts';
import type { GitProviderConnectionInfo } from '@/lib/api';

/**
 * Rules the Work settings save (`updateWork` server action) applies before it
 * calls the API, kept out of the `'use server'` file so they are unit tested.
 */

type WorkKindSubject = { readonly kind?: string | null };

/**
 * Does `POST /api/works/:id/update-readme` accept this Work's kind?
 *
 * The API refuses Repository, App and Project Works
 * (`WorkGenerationService.ensureNotRepositoryWork` → `assertNotRepositoryWork`
 * + `assertNotAppWork`): their repository is someone's code, or there is none.
 * The settings save used to call it for every Work, so a successful rename of
 * such a Work ended with an error toast and no refresh.
 */
export function workRegeneratesReadmeOnSave(work: WorkKindSubject): boolean {
    return (
        !isRepositoryWorkKind(work.kind) &&
        !isAppWorkKind(work.kind) &&
        !isProjectWorkKind(work.kind)
    );
}

/**
 * Does the Source settings card offer its "keep in sync" switch?
 *
 * The switch enables or pauses the Work's update schedule
 * (`PUT /api/works/:id/schedule`), which the API refuses for Repository,
 * Project and App Works (`WorkScheduleService` → `assertNotRepositoryWork` +
 * `assertNotAppWork`). App Works carry `app_link` / `app_fork` /
 * `app_private_copy` sources, so checking only `link_existing` offered the
 * switch on every App Work, and each click answered a 400.
 */
export function workSupportsSourceSync(
    work: WorkKindSubject,
    sourceType: string | null | undefined,
): boolean {
    if (sourceType === 'link_existing') {
        return false;
    }
    return (
        !isRepositoryWorkKind(work.kind) &&
        !isAppWorkKind(work.kind) &&
        !isProjectWorkKind(work.kind)
    );
}

/**
 * May a settings save still choose where the Work's repositories live
 * (`owner` / `organization`)?
 *
 * Only before the repositories exist: the settings form disables the fields
 * once the Work has generated (`canEditOrganization = !isGenerated` in
 * `SettingsContext`). A Repository Work's owner is the owner of the repository
 * it wraps and the API refuses any change; an App Work's repository is the one
 * its source mode made; a Project Work has none.
 */
export function mayChooseRepositoryOwner(
    work: WorkKindSubject & { readonly generateStatus?: unknown },
): boolean {
    if (
        isRepositoryWorkKind(work.kind) ||
        isAppWorkKind(work.kind) ||
        isProjectWorkKind(work.kind)
    ) {
        return false;
    }
    return work.generateStatus === null || work.generateStatus === undefined;
}

/**
 * Where a NEW Work's repositories go: the connected account's own login, or
 * an organization the user named. Used by every create path and by a settings
 * save that may still choose (see {@link mayChooseRepositoryOwner}).
 */
export function resolveRepositoryOwnership(
    connectionInfo: GitProviderConnectionInfo | null,
    data: { owner?: string; organization?: boolean },
): { organization: boolean; owner: string | undefined } {
    if (!connectionInfo?.connected) {
        return {
            organization: data.organization || false,
            owner: data.owner || undefined,
        };
    }

    const username = connectionInfo.username;

    if (!data.organization) {
        return {
            organization: false,
            owner: username || undefined,
        };
    }

    const owner = data.owner?.trim();

    if (owner && username && owner !== username) {
        return {
            organization: true,
            owner: owner || undefined,
        };
    }

    return {
        organization: false,
        owner: username || undefined,
    };
}

/**
 * The `owner` / `organization` a settings save sends: re-derived only while
 * the Work may still choose, otherwise left out so the API keeps the stored
 * values (`updateDto.owner ?? work.owner`).
 *
 * Re-deriving them on every save (what it did) rewrote a personal Work's owner
 * to the login of WHOEVER saved — a manager renaming a member's Work, or the
 * chat's rename tool — and the Work's repositories then resolved under that
 * account; for a Repository Work the API refused the save outright.
 */
export function ownershipForSettingsSave(
    work: WorkKindSubject & { readonly generateStatus?: unknown },
    connectionInfo: GitProviderConnectionInfo | null,
    data: { owner?: string; organization?: boolean },
): { organization: boolean; owner: string | undefined } | null {
    if (!mayChooseRepositoryOwner(work)) {
        return null;
    }
    return resolveRepositoryOwnership(connectionInfo, data);
}
