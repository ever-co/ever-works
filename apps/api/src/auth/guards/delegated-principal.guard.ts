import {
    CanActivate,
    ExecutionContext,
    HttpException,
    HttpStatus,
    Injectable,
} from '@nestjs/common';
import type { AuthenticatedUser, EverIdDelegationBinding } from '../types/auth.types';

/** The code of the refusal {@link DelegatedPrincipalGuard} gives. */
export const DELEGATED_TOKEN_REQUIRED_CODE = 'delegated_token_required';

/**
 * Admits only another Ever app acting for a person with a delegated Ever ID
 * access token (`authMethod: 'ever-id-delegated'`, stamped by
 * `AuthSessionGuard` on a handler marked `@DelegatedRead` / `@DelegatedWrite`).
 *
 * For a route that exists for such a caller alone. Runs after the global
 * `AuthSessionGuard`; anything else that authenticated the request — a person's
 * session, a personal API key, a fleet-run token, an integration key — or a
 * request with no stamp at all is refused with `403 delegated_token_required`.
 * Those callers have their own routes, with their own rules.
 */
@Injectable()
export class DelegatedPrincipalGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<{
            user?: AuthenticatedUser;
            everIdDelegation?: EverIdDelegationBinding;
        }>();
        if (request.user?.authMethod !== 'ever-id-delegated' || !request.everIdDelegation) {
            throw new HttpException(
                {
                    status: 'error',
                    code: DELEGATED_TOKEN_REQUIRED_CODE,
                    message:
                        'This endpoint takes a delegated Ever ID access token only (Authorization: Bearer).',
                },
                HttpStatus.FORBIDDEN,
            );
        }
        return true;
    }
}
