import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { ApiKey, AuthSession } from '@ever-works/agent/entities';
import { INTEGRATION_API_KEY_KIND, PERSONAL_API_KEY_KIND } from '@ever-works/contracts';
import { AUTH_PROVIDER } from '../providers/auth-provider.constants';
import { AuthProvider } from '../providers/auth-provider.abstract';

/**
 * EW-617 — the session rotation both ways of saving a temporary account share
 * (`POST /api/auth/claim`, `POST /api/oauth/:providerId/claim`).
 *
 * Saving turns a throwaway account into a durable one, so every credential the temporary account
 * had before is ended, not only the bearer that asked:
 *
 *  1. a regular session is issued FIRST (the anonymous ones end with the anonymous TTL, which
 *     would sign a just-saved account out within days);
 *  2. then every OTHER session row of the user is deleted;
 *  3. then the user's personal and integration API keys are deactivated.
 *
 * Why all of them: the web session cookie can be planted by a Work on a sibling subdomain, so a
 * victim's browser can be signed in to an ATTACKER's temporary account. If the victim then saves
 * it, the attacker must not keep a way in through a second session or a key minted earlier.
 * Fleet run tokens (`kind = 'fleet-run'`, bound to a job) are left alone: the platform mints them
 * per lease for a running Work, and ending them would break that run.
 *
 * Every step is best effort, as before: the save is committed and still answers 200. If no
 * session can be issued, nothing is ended (the caller keeps the anonymous one).
 */
@Injectable()
export class SavedAccountSessionService {
    private readonly logger = new Logger(SavedAccountSessionService.name);

    constructor(
        @Inject(AUTH_PROVIDER)
        private readonly authProvider: AuthProvider,
        private readonly dataSource: DataSource,
    ) {}

    /** The fresh session's token, or undefined when none could be issued. */
    async rotate(
        userId: string,
        client: { ipAddress: string | null; userAgent: string | null },
        how: string,
    ): Promise<string | undefined> {
        let accessToken: string | undefined;
        try {
            accessToken = (await this.authProvider.issueSession(userId, client)).access_token;
        } catch (error) {
            this.logger.warn(
                `User ${userId} saved ${how}: could not issue a fresh session, keeping the anonymous one: ${message(error)}`,
            );
            return undefined;
        }
        // No fresh session means nothing may be ended: the caller keeps the anonymous one.
        if (!accessToken) {
            return undefined;
        }

        try {
            await this.endOtherSessions(userId, accessToken);
        } catch (error) {
            this.logger.warn(
                `User ${userId} saved ${how}: could not end the other sessions: ${message(error)}`,
            );
        }

        try {
            await this.dataSource
                .getRepository(ApiKey)
                .update(
                    {
                        userId,
                        kind: In([PERSONAL_API_KEY_KIND, INTEGRATION_API_KEY_KIND]),
                        isActive: true,
                    },
                    { isActive: false },
                );
        } catch (error) {
            this.logger.warn(
                `User ${userId} saved ${how}: could not deactivate its API keys: ${message(error)}`,
            );
        }

        return accessToken;
    }

    /**
     * Deletes every session row of the user except the one for `keepAccessToken`. Rows are read
     * and deleted by id, so a legacy row with a plaintext `token` and no `tokenHash` goes too.
     */
    private async endOtherSessions(userId: string, keepAccessToken: string): Promise<void> {
        const sessions = this.dataSource.getRepository(AuthSession);
        const keep = hashSessionToken(keepAccessToken);
        const others = (
            await sessions.find({ where: { userId }, select: ['id', 'tokenHash'] })
        ).filter((session) => session.tokenHash !== keep);
        if (others.length > 0) {
            await sessions.delete(others.map((session) => session.id));
        }
    }
}

/**
 * The digest a session row stores (`AuthProviderService.hashSessionToken`, kept local here as in
 * `AnonymousAuthService`, so this service does not load the Better Auth runtime).
 */
function hashSessionToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
