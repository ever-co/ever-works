import type { UserRepository } from '@ever-works/agent/database';
import type { User } from '@ever-works/agent/entities';
import { socialEmailAmbiguous } from './social-link-errors';

/** What {@link findAccountByEmail} reads through; a transaction-bound copy works the same. */
export type AccountEmailLookup = Pick<
    UserRepository,
    'findByEmail' | 'findByEmailCaseInsensitiveForSocialAuth'
>;

/**
 * An account email as it is stored: trimmed and lower case (the unique index is
 * case-sensitive, so the provider's casing would otherwise create case variants).
 * Null for a missing or blank address.
 */
export function normalizeAccountEmail(email: string | null | undefined): string | null {
    return email?.trim().toLowerCase() || null;
}

/**
 * The existing account a provider email names, for a path that found no linked identity
 * first. The rule `AuthService.validateSocialUser` applies:
 *
 *  1. an exact match on the normalised address (how accounts are stored now);
 *  2. an exact match on the address as received (trimmed), when its case differs: an older
 *     row stored in the provider's case. Step 3 cannot find it when the address is not ASCII,
 *     so without this step such an account would be missed where an exact match found it;
 *  3. a case-insensitive match (ASCII addresses only, see the repository): exactly one is that
 *     account. Two or more differ only in case, so none is picked: this throws
 *     `SOCIAL_EMAIL_AMBIGUOUS` (409) before the caller writes anything, and the caller never
 *     creates yet another variant.
 *
 * Null when nothing matches. The caller still applies its own verified-email rules to the
 * account it gets. A step-3 row carries the social-auth columns only (id, username, email,
 * avatar, emailVerified, isActive, ...), not every column of the entity.
 */
export async function findAccountByEmail(
    users: AccountEmailLookup,
    email: string | null | undefined,
): Promise<User | null> {
    const normalized = normalizeAccountEmail(email);
    if (!normalized) return null;

    const exact = await users.findByEmail(normalized);
    if (exact) return exact;

    const received = email?.trim();
    if (received && received !== normalized) {
        const asReceived = await users.findByEmail(received);
        if (asReceived) return asReceived;
    }

    const variants = await users.findByEmailCaseInsensitiveForSocialAuth(normalized);
    if (variants.length > 1) throw socialEmailAmbiguous();
    return variants[0] ?? null;
}
