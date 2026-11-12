import {
    TASK_PR_READ_RATE_LIMIT_FALLBACK_MS,
    TASK_PR_READ_RETRY_BASE_MS,
    TASK_PR_READ_RETRY_CAP_MS,
    prReadCredentialKey,
    prReadEffectiveRetryAt,
    prReadNextDueMs,
    prReadRateLimitedUntil,
    prReadRetryDelayMs,
} from '../task-pr-read-retry';
import { TASK_PR_NOT_FOUND_RECHECK_MS, TASK_PR_NOT_FOUND_STATE } from '../task-open-work';

/**
 * The PR-status sweep's retry rules for a read that did not succeed, as pure functions: the
 * backoff (as long as the pull request has gone unseen, 2 minutes to 6 hours) and what counts as
 * a rate limit, until when.
 */
describe('task-pr-read-retry', () => {
    const NOW = new Date('2026-11-11T10:00:00.000Z');
    const MINUTE = 60_000;
    const ago = (ms: number) => new Date(NOW.getTime() - ms);

    describe('prReadRetryDelayMs', () => {
        it('waits as long as the pull request has gone unseen, so the waits double while it stays unseen', () => {
            expect(prReadRetryDelayMs(NOW, ago(5 * MINUTE))).toBe(5 * MINUTE);
            expect(prReadRetryDelayMs(NOW, ago(90 * MINUTE))).toBe(90 * MINUTE);
            // Read at lastSeen + 2^k minutes, each wait is 2^k minutes: the next read lands at 2^(k+1).
            const lastSeen = ago(0);
            let at = NOW.getTime() + 2 * MINUTE;
            const waits: number[] = [];
            for (let i = 0; i < 4; i += 1) {
                const wait = prReadRetryDelayMs(new Date(at), lastSeen);
                waits.push(wait / MINUTE);
                at += wait;
            }
            expect(waits).toEqual([2, 4, 8, 16]);
        });

        it('never waits less than one tick, nor more than the "not found" lane', () => {
            expect(prReadRetryDelayMs(NOW, ago(10_000))).toBe(TASK_PR_READ_RETRY_BASE_MS);
            expect(prReadRetryDelayMs(NOW, ago(3 * 24 * 60 * MINUTE))).toBe(
                TASK_PR_READ_RETRY_CAP_MS,
            );
            expect(TASK_PR_READ_RETRY_BASE_MS).toBe(2 * MINUTE);
            expect(TASK_PR_READ_RETRY_CAP_MS).toBe(TASK_PR_NOT_FOUND_RECHECK_MS);
            // A last read in the future (clock skew) is not a negative wait.
            expect(prReadRetryDelayMs(NOW, new Date(NOW.getTime() + MINUTE))).toBe(
                TASK_PR_READ_RETRY_BASE_MS,
            );
        });

        it('waits one tick when it cannot tell when the pull request was last seen', () => {
            expect(prReadRetryDelayMs(NOW, null)).toBe(TASK_PR_READ_RETRY_BASE_MS);
            expect(prReadRetryDelayMs(NOW, undefined)).toBe(TASK_PR_READ_RETRY_BASE_MS);
            expect(prReadRetryDelayMs(NOW, 'not a date')).toBe(TASK_PR_READ_RETRY_BASE_MS);
        });
    });

    describe('prReadRateLimitedUntil', () => {
        /** What a git provider's HTTP client throws. */
        const httpError = (status: number, message: string, headers: Record<string, string> = {}) =>
            Object.assign(new Error(message), {
                status,
                response: { status, headers, data: { message } },
            });
        const at = (ms: number) => new Date(NOW.getTime() + ms);

        it('a spent budget (403 + x-ratelimit-remaining: 0) waits for the reset the provider names', () => {
            const reset = Math.floor(at(40 * MINUTE).getTime() / 1000);
            expect(
                prReadRateLimitedUntil(
                    httpError(403, 'API rate limit exceeded', {
                        'X-RateLimit-Remaining': '0',
                        'X-RateLimit-Reset': String(reset),
                    }),
                    NOW,
                ),
            ).toEqual(at(40 * MINUTE));
        });

        it('a secondary limit waits retry-after seconds; a 429 is a rate limit whatever it says', () => {
            expect(
                prReadRateLimitedUntil(
                    httpError(403, 'You have exceeded a secondary rate limit', {
                        'retry-after': '300',
                    }),
                    NOW,
                ),
            ).toEqual(at(5 * MINUTE));
            expect(prReadRateLimitedUntil(httpError(429, 'Too Many Requests'), NOW)).toEqual(
                at(TASK_PR_READ_RATE_LIMIT_FALLBACK_MS),
            );
            expect(
                prReadRateLimitedUntil(httpError(403, 'secondary rate limit, slow down'), NOW),
            ).toEqual(at(TASK_PR_READ_RATE_LIMIT_FALLBACK_MS));
        });

        it('a typed provider error carries its own retry instant', () => {
            const typed = Object.assign(new Error('rate_limited'), {
                reason: 'secondary_rate_limited',
                status: 403,
                details: { retryAt: at(7 * MINUTE).toISOString() },
            });
            expect(prReadRateLimitedUntil(typed, NOW)).toEqual(at(7 * MINUTE));
            expect(
                prReadRateLimitedUntil(
                    Object.assign(new Error('x'), { reason: 'rate_limited' }),
                    NOW,
                ),
            ).toEqual(at(TASK_PR_READ_RATE_LIMIT_FALLBACK_MS));
        });

        it('clamps the provider’s instant between one tick and 6 hours', () => {
            expect(
                prReadRateLimitedUntil(httpError(429, 'slow down', { 'retry-after': '0' }), NOW),
            ).toEqual(at(TASK_PR_READ_RETRY_BASE_MS));
            const nextWeek = Math.floor(at(7 * 24 * 60 * MINUTE).getTime() / 1000);
            expect(
                prReadRateLimitedUntil(
                    httpError(403, 'API rate limit exceeded', {
                        'x-ratelimit-remaining': '0',
                        'x-ratelimit-reset': String(nextWeek),
                    }),
                    NOW,
                ),
            ).toEqual(at(TASK_PR_READ_RETRY_CAP_MS));
        });

        it('anything else is not a rate limit: a refusal, bad credentials, an outage, a bare message', () => {
            for (const error of [
                httpError(403, 'Resource not accessible by integration'),
                httpError(401, 'Bad credentials'),
                httpError(404, 'Not Found'),
                httpError(502, 'Bad gateway'),
                new Error('403 rate limited'),
                Object.assign(new Error('x'), { reason: 'unauthorized', status: 401 }),
                'rate limit',
                null,
                undefined,
            ]) {
                expect(prReadRateLimitedUntil(error, NOW)).toBeNull();
            }
        });
    });

    describe('prReadEffectiveRetryAt', () => {
        it('obeys an instant up to 6 hours ahead, and nothing further (a clock that was ahead)', () => {
            expect(prReadEffectiveRetryAt(new Date(NOW.getTime() + MINUTE), NOW)).toEqual(
                new Date(NOW.getTime() + MINUTE),
            );
            expect(prReadEffectiveRetryAt(ago(MINUTE), NOW)).toEqual(ago(MINUTE));
            const cap = new Date(NOW.getTime() + TASK_PR_READ_RETRY_CAP_MS);
            expect(prReadEffectiveRetryAt(cap, NOW)).toEqual(cap);
            expect(prReadEffectiveRetryAt(new Date(cap.getTime() + 1), NOW)).toBeNull();
            expect(
                prReadEffectiveRetryAt(new Date(NOW.getTime() + 365 * 24 * 60 * MINUTE), NOW),
            ).toBeNull();
            expect(prReadEffectiveRetryAt(null, NOW)).toBeNull();
            expect(prReadEffectiveRetryAt('not a date', NOW)).toBeNull();
        });
    });

    describe('prReadNextDueMs', () => {
        it('a retry instant when there is one, the 6-hourly re-check for "not found", else now', () => {
            const retryAt = new Date(NOW.getTime() + 20 * MINUTE);
            expect(prReadNextDueMs({ prState: 'open', prReadRetryAt: retryAt }, NOW)).toBe(
                retryAt.getTime(),
            );
            expect(
                prReadNextDueMs(
                    { prState: TASK_PR_NOT_FOUND_STATE, ciCheckedAt: ago(60 * MINUTE) },
                    NOW,
                ),
            ).toBe(NOW.getTime() - 60 * MINUTE + TASK_PR_NOT_FOUND_RECHECK_MS);
            expect(prReadNextDueMs({ prState: 'open', ciCheckedAt: ago(MINUTE) }, NOW)).toBe(
                NOW.getTime(),
            );
            // A retry instant beyond the ceiling is not one: due on the usual cadence.
            expect(
                prReadNextDueMs(
                    {
                        prState: 'open',
                        prReadRetryAt: new Date(NOW.getTime() + 365 * 24 * 60 * MINUTE),
                    },
                    NOW,
                ),
            ).toBe(NOW.getTime());
            // A "not found" never read: due now.
            expect(prReadNextDueMs({ prState: TASK_PR_NOT_FOUND_STATE }, NOW)).toBe(NOW.getTime());
        });
    });

    describe('prReadCredentialKey', () => {
        const OWNER = 'user-1';
        const installed = (installationId: string) => ({
            gitProvider: 'github',
            storageProvider: 'user-github',
            sourceRepository: {
                auth: { mode: 'github_app_installation', installationId },
            },
        });

        it('keys a Work by the credential the git facade reads it with', () => {
            const off = { platformTokenActive: false };
            // An app installation: one key per installation, whoever owns the Task.
            expect(prReadCredentialKey(installed('X'), OWNER, off)).toBe('installation:X');
            expect(prReadCredentialKey(installed('Y'), OWNER, off)).toBe('installation:Y');
            // The owner's own account, per provider.
            expect(prReadCredentialKey({ gitProvider: 'github' }, OWNER, off)).toBe(
                'owner:user-1:github',
            );
            expect(prReadCredentialKey({ gitProvider: 'gitlab' }, OWNER, off)).toBe(
                'owner:user-1:gitlab',
            );
            expect(
                prReadCredentialKey(
                    { gitProvider: 'github', sourceRepository: { auth: { mode: 'none' } } },
                    OWNER,
                    off,
                ),
            ).toBe('owner:user-1:github');
            // An installation is a git-provider-specific credential: another provider ignores it.
            expect(
                prReadCredentialKey({ ...installed('X'), gitProvider: 'gitlab' }, OWNER, off),
            ).toBe('owner:user-1:gitlab');
        });

        it('the platform storage is read with the platform token only while that is configured', () => {
            const platformWork = { ...installed('X'), storageProvider: 'ever-works-git' };
            expect(prReadCredentialKey(platformWork, OWNER, { platformTokenActive: true })).toBe(
                'platform',
            );
            expect(prReadCredentialKey(platformWork, OWNER, { platformTokenActive: false })).toBe(
                'installation:X',
            );
            expect(prReadCredentialKey(installed('X'), OWNER, { platformTokenActive: true })).toBe(
                'installation:X',
            );
        });
    });
});
