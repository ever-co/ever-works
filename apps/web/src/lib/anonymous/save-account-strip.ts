import 'server-only';
import { authAPI, type UserProfile } from '@/lib/api/auth';
import { getAuthFromRequest } from '@/lib/auth/middleware';
import { getDemoConfig } from '@/lib/feature-flags/demo';
import type { SaveAccountStripProps } from './types';

export type { SaveAccountStripProps };

type StripProfile = Pick<
    UserProfile,
    'isAnonymous' | 'anonymousExpiresAt' | 'registrationProvider' | 'demo'
>;

/**
 * The "you are on a temporary account" strip: shown to an anonymous (zero-friction) account
 * that can still be saved with `POST /auth/claim`, null for everyone else.
 *
 *  - A registered account, or a profile that could not be read, never sees it. Only an
 *    explicit `isAnonymous: true` counts, so a payload that drops the field shows nothing.
 *  - A demo sandbox has its own strip and sign-up link, and the API refuses its claim, so a
 *    `demo` block or the `demo` provider ends it without asking anything else.
 *  - On a demo instance it never shows either: there the demo strip is the one that talks
 *    about signing up. Asked only for an anonymous account, so nobody else pays for the read.
 */
export async function buildSaveAccountStrip(
    profile: StripProfile | null | undefined,
): Promise<SaveAccountStripProps | null> {
    if (profile?.isAnonymous !== true) return null;
    if (profile.demo || profile.registrationProvider === 'demo') return null;
    if ((await getDemoConfig()).enabled) return null;
    return { expiresAt: profile.anonymousExpiresAt ?? null };
}

/**
 * Whether this request is signed in as a temporary account that can be saved. For pages
 * outside the dashboard that must not let such a visitor make a SECOND account: signing up
 * there replaces the session, and the Works stay behind on the anonymous one until the
 * cleanup deletes them. Reads the API only when a session cookie is present.
 */
export async function hasSavableAnonymousSession(): Promise<boolean> {
    const auth = await getAuthFromRequest();
    if (!auth.isAuthenticated || auth.isExpired) return false;
    const profile = await authAPI.getFreshProfile().catch(() => null);
    return (await buildSaveAccountStrip(profile)) !== null;
}
