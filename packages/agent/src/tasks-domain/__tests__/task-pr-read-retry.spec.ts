import {
    TASK_PR_READ_RATE_LIMIT_FALLBACK_MS,
    TASK_PR_READ_RETRY_BASE_MS,
    TASK_PR_READ_RETRY_CAP_MS,
    prReadRateLimitedUntil,
    prReadRetryDelayMs,
} from '../task-pr-read-retry';
import { TASK_PR_NOT_FOUND_RECHECK_MS } from '../task-open-work';

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
});
