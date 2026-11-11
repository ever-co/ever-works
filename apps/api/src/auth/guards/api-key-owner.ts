/**
 * Who may act through a personal API key: the key's owner exists and is
 * active. `AuthSessionGuard` refuses every other owner with a 401
 * ("User account is inactive") after the key itself verified.
 *
 * Kept in this dependency-free module so the account-import body parser gate
 * (`accountImportCallerCheck`, which runs before the guard) applies the very
 * same rule: a still-valid key of a deactivated account must not get the
 * large import parse before its 401.
 */
export function isActiveApiKeyOwner<T extends { isActive?: boolean | null }>(
    owner: T | null | undefined,
): owner is T {
    return Boolean(owner && owner.isActive);
}
