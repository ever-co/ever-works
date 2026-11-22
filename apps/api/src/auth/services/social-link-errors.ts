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

export function existingAccountEmailUnverified(): ConflictException {
    return new ConflictException({
        code: EXISTING_ACCOUNT_EMAIL_UNVERIFIED_CODE,
        message:
            'An account with this email already exists but its email has not been verified. Sign in the way you created it, or verify its email first.',
    });
}
