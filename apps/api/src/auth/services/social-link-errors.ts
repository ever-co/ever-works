import { ConflictException } from '@nestjs/common';

/**
 * A verified provider email matched an existing account whose OWN email was never verified,
 * and no link to this provider account exists yet. Refused rather than linked: anyone can
 * create an account with someone else's address and never verify it (a password
 * registration, a social sign-up whose provider reports the address unverified, an anonymous
 * account saved with that address), so linking the real owner's provider identity into it
 * would hand the creator the owner's sign-ins (account pre-hijacking). The web maps the code
 * to its own message.
 */
export const EXISTING_ACCOUNT_EMAIL_UNVERIFIED_CODE = 'EXISTING_ACCOUNT_EMAIL_UNVERIFIED';

/**
 * Never suggests verifying that account: the person reading it may not be the one who opened
 * it, and verifying evicts nobody (its creator keeps their session, password and links), so
 * it would complete the hijack instead of preventing it.
 */
export const EXISTING_ACCOUNT_EMAIL_UNVERIFIED_MESSAGE =
    "An account with this email already exists, but its email has never been verified, so we can't link this sign-in to it. If you created it, sign in the way you did then. If you didn't, contact support.";

export function existingAccountEmailUnverified(): ConflictException {
    return new ConflictException({
        code: EXISTING_ACCOUNT_EMAIL_UNVERIFIED_CODE,
        message: EXISTING_ACCOUNT_EMAIL_UNVERIFIED_MESSAGE,
    });
}
