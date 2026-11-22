/**
 * The handle a typed username becomes, by the API's rule (`UsernameAllocatorService.normalize`
 * in apps/api): lowercase, runs of anything but `a-z`, `0-9` and `-` become one dash, and no
 * leading or trailing dash. Unlike the API it never falls back to a random `u-<hex>`: an input
 * with nothing usable answers '' so the form can say so instead of saving something unexpected.
 * Keep the two rules equal.
 */
export function normalizeUsername(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** The username floor `ClaimAccountDto` and `RegisterDto` enforce. */
export const USERNAME_MIN_LENGTH = 3;

/**
 * Whether a typed username can be saved: empty is fine (the API derives one from the email);
 * otherwise it needs an ASCII letter or digit and a normalized length of at least 3.
 */
export function isUsableUsername(input: string): boolean {
    const typed = input.trim();
    if (!typed) return true;
    return /[a-z0-9]/i.test(typed) && normalizeUsername(typed).length >= USERNAME_MIN_LENGTH;
}
