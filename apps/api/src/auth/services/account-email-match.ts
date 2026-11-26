import type { UserRepository } from '@ever-works/agent/database';
import type { User } from '@ever-works/agent/entities';
import { socialEmailAmbiguous } from './social-link-errors';

/** What {@link findAccountByEmail} reads through; a transaction-bound copy works the same. */
export type AccountEmailLookup = Pick<
    UserRepository,
    'findByEmail' | 'findByEmailCaseInsensitiveForSocialAuth'
>;

/**
 * What an account found by {@link findAccountByEmail} is guaranteed to carry: the columns
 * `UserRepository.findByEmailCaseInsensitiveForSocialAuth` selects (`SOCIAL_AUTH_USER_SELECT`).
 * An exact match is a full row, but a case-insensitive one holds only these, so any other
 * column (tenantId, role, ...) must be re-read, as `UserRepository.update` does.
 */
export type AccountEmailMatch = Pick<
    User,
    | 'id'
    | 'username'
    | 'email'
    | 'registrationProvider'
    | 'isAnonymous'
    | 'avatar'
    | 'emailVerified'
    | 'isActive'
    | 'lastLoginAt'
    | 'lastLoginIp'
    | 'committerName'
    | 'committerEmail'
    | 'defaultPlanId'
    | 'createdAt'
    | 'updatedAt'
>;

/**
 * An account email as it is stored: trimmed and lower case (the unique index is
 * case-sensitive, so the provider's casing would otherwise create case variants).
 * Null for a missing or blank address.
 */
export function normalizeAccountEmail(email: string | null | undefined): string | null {
    return email?.trim().toLowerCase() || null;
}

/** The repository's `fallbackEmail` test: the case-insensitive fallback runs for ASCII only. */
function isAscii(value: string): boolean {
    return [...value].every((ch) => ch.charCodeAt(0) < 128);
}

/**
 * The existing account a provider email names, for a path that found no linked identity first:
 *
 *  1. an exact match on the normalised address (how accounts are stored now);
 *  2. for a NON-ASCII address only, when its case differs: an exact match on the address as
 *     received (trimmed). Step 3 never runs for non-ASCII input, so an older row stored in the
 *     provider's case would otherwise be missed where an exact match used to find it (and its
 *     refusals with it). For an ASCII address step 3 already finds that row, and also sees any
 *     other case variant next to it, so step 2 is skipped and cannot pick one of several;
 *  3. a case-insensitive match (ASCII addresses only, see the repository): exactly one is that
 *     account. Two or more differ only in case, so none is picked: this throws
 *     `SOCIAL_EMAIL_AMBIGUOUS` (409) before the caller writes anything, and the caller never
 *     creates yet another variant.
 *
 * Steps 1 and 3 are the rule `AuthService.validateSocialUser` applies. Step 2 is not part of it:
 * the social sign-in mappings lower-case the address before that lookup, so the received casing
 * is gone there, and a non-ASCII account stored in another case is missed. Steps 1 and 2 also
 * read the full row (`findByEmail`) where the social sign-in reads the social-auth columns.
 *
 * Null when nothing matches. The caller still applies its own verified-email rules to the
 * account it gets, which is typed {@link AccountEmailMatch} because a step-3 row holds only
 * the social-auth columns.
 */
export async function findAccountByEmail(
    users: AccountEmailLookup,
    email: string | null | undefined,
): Promise<AccountEmailMatch | null> {
    const normalized = normalizeAccountEmail(email);
    if (!normalized) return null;

    const exact = await users.findByEmail(normalized);
    if (exact) return exact;

    const received = email?.trim();
    if (received && received !== normalized && !isAscii(received)) {
        const asReceived = await users.findByEmail(received);
        if (asReceived) return asReceived;
    }

    const variants = await users.findByEmailCaseInsensitiveForSocialAuth(normalized);
    if (variants.length > 1) throw socialEmailAmbiguous();
    return variants[0] ?? null;
}
