import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import type { EverIdDelegatedWriteScope } from '@ever-works/contracts';
import { NO_TOKEN_IN_QUERY, NoTokenInQueryGuard } from '../guards/no-token-in-query.guard';
import {
    DELEGATED_READ_ORIGINS,
    DELEGATED_READ_SCOPE,
    type DelegatedReadOriginsResolver,
} from './delegated-read.decorator';

/**
 * Route metadata marking a handler as one a delegated token may **write**
 * through. The scope itself travels under {@link DELEGATED_READ_SCOPE}, the key
 * `AuthSessionGuard`'s delegated branch already reads, so a write route is
 * admitted by exactly the same checks as a read route; this mark only tells the
 * guard that the handler is a write.
 */
export const DELEGATED_WRITE = 'everIdDelegatedWrite';

export interface DelegatedWriteOptions {
    /**
     * The exact browser origins (`https://host[:port]`) a delegated token is
     * accepted from on this handler, as for `@DelegatedRead`: when given, a
     * delegated token whose `Origin` header is absent or not in the list is
     * refused with `403 origin_not_allowed` before the token is read. Leave it
     * out for a route another app's server calls (such a call has no `Origin`).
     */
    allowedOrigins?: DelegatedReadOriginsResolver;
}

/**
 * Mark a handler as one another Ever app may call **to change something** for
 * the person, with a short-lived Ever ID access token carrying `scope` (a write
 * scope: `apps:write`).
 *
 * It reuses the delegated branch of `AuthSessionGuard` unchanged: the token is
 * admitted only if its signature, issuer and audience verify, it has not
 * expired, its lifetime is at most an hour, its authorised party is trusted
 * (when the installation lists trusted clients) and its subject is a connected
 * identity of an active account. Two answers differ from a read route:
 *
 * - a token **without the write scope** — one that may only read included — is
 *   refused with `403 insufficient_scope`: reading never allows writing;
 * - a valid token whose person has **no connected identity here** is refused
 *   with `403 no_linked_identity` rather than the plain 401, so the calling app
 *   can tell the person to sign in to Ever Works with Ever ID first. Nothing is
 *   learned from it that the token's own holder does not know.
 *
 * Everywhere else such a token is still answered like an invalid credential,
 * and the mark changes nothing for a session or an API key. A token in the
 * query string is refused (`400 token_in_query`) through
 * {@link NoTokenInQueryGuard}. The principal is stamped
 * `authMethod: 'ever-id-delegated'`, so every control that needs a person's own
 * session (`@HumanOnly()`, `SessionOnlyGuard`, the owner gates) keeps refusing
 * it: a delegated write is never an interactive session.
 */
export function DelegatedWrite(
    scope: EverIdDelegatedWriteScope,
    options: DelegatedWriteOptions = {},
) {
    const decorators = [
        SetMetadata(DELEGATED_READ_SCOPE, scope),
        SetMetadata(DELEGATED_WRITE, true),
        SetMetadata(NO_TOKEN_IN_QUERY, true),
        UseGuards(NoTokenInQueryGuard),
    ];
    if (options.allowedOrigins) {
        decorators.push(SetMetadata(DELEGATED_READ_ORIGINS, options.allowedOrigins));
    }
    return applyDecorators(...decorators);
}
