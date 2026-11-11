import { TASK_PR_NOT_FOUND_RECHECK_MS } from './task-open-work';

/**
 * When the PR-status sweep reads a pull request again after a read that did not succeed: the
 * provider call threw (bad or missing credentials, a refusal, an outage, a rate limit), or it
 * answered "not found" and that answer is not confirmed yet. Pure on purpose, so the schedule is
 * provable without a database; `TaskPrStatusService` stamps the result on
 * `tasks.prReadRetryAt`, and `TaskRepository.findDuePrStatusSync` keeps the row out of the batch
 * until then.
 *
 * Why it exists: such a read stamps nothing the sweep orders by (`ciCheckedAt` is the last
 * SUCCESSFUL read), so the row stayed due and sorted first on every tick. A batch's worth of them
 * (one owner with a disconnected git account and 25 open pull requests) took every slot of every
 * tick, and no other owner's pull request was read at all.
 */

/** The first retry after an unsuccessful read: one sweep tick. */
export const TASK_PR_READ_RETRY_BASE_MS = 2 * 60 * 1000;

/**
 * The longest wait between two reads that keep failing: the cadence of the "not found" lane
 * (`TASK_PR_NOT_FOUND_RECHECK_MS`), so a pull request nobody can read is never asked about more
 * often than one that is gone, and a credential that comes back is noticed the same day.
 */
export const TASK_PR_READ_RETRY_CAP_MS = TASK_PR_NOT_FOUND_RECHECK_MS;

/**
 * How long a rate-limited connection is left alone when the provider did not say until when
 * (no reset or retry-after header).
 */
export const TASK_PR_READ_RATE_LIMIT_FALLBACK_MS = 15 * 60 * 1000;

/**
 * The wait before the next read of a pull request whose read did not succeed: as long as the pull
 * request has already gone unseen (`now - lastSeen`), between {@link TASK_PR_READ_RETRY_BASE_MS}
 * and {@link TASK_PR_READ_RETRY_CAP_MS}.
 *
 * `lastSeen` does not move while reads keep failing, so each wait doubles the time since the pull
 * request was last seen: read at +2 min after the last success fails, the next read is at +4, then
 * +8, +16 ... up to one read every 6 hours. No counter column is needed for that. `lastSeen` is
 * the last successful read (`ciCheckedAt`), or, never read, the last change to the Task (the write
 * that recorded the pull request); `null` (or an unreadable date) waits the base delay.
 */
export function prReadRetryDelayMs(now: Date, lastSeen: Date | string | null | undefined): number {
    const seenMs = lastSeen ? new Date(lastSeen).getTime() : Number.NaN;
    const unseenMs = Number.isFinite(seenMs) ? now.getTime() - seenMs : 0;
    return Math.min(TASK_PR_READ_RETRY_CAP_MS, Math.max(TASK_PR_READ_RETRY_BASE_MS, unseenMs));
}

/** The provider's typed rate-limit reasons (`GitProviderRequestError.reason`). */
const RATE_LIMIT_REASONS: ReadonlySet<string> = new Set(['rate_limited', 'secondary_rate_limited']);

/**
 * Whether a failed provider read was a RATE LIMIT, and if so until when the connection should be
 * left alone; `null` for any other failure.
 *
 * A rate limit is a fact about the connection, not about one pull request, so the caller defers
 * every pull-request read made with it (`TaskRepository.deferPrReadsForOwner`) instead of letting
 * each of the owner's rows spend a call to learn the same thing.
 *
 * Recognised, without importing any provider SDK:
 *  - a typed provider error (`reason` `rate_limited` / `secondary_rate_limited`, with its own
 *    `details.retryAt`);
 *  - an HTTP error object (`status` + `response.headers`): `429`, or `403` with a spent budget
 *    (`x-ratelimit-remaining: 0`), a `retry-after` header, or "rate limit" in the provider's
 *    message.
 *
 * A message alone, with no status, is never read as a rate limit: that would let any error text
 * defer a whole connection. The provider's own instant (`retryAt`, `retry-after`,
 * `x-ratelimit-reset`) is used when it names one, else {@link TASK_PR_READ_RATE_LIMIT_FALLBACK_MS};
 * either way clamped to [{@link TASK_PR_READ_RETRY_BASE_MS}, {@link TASK_PR_READ_RETRY_CAP_MS}]
 * from `now`.
 */
export function prReadRateLimitedUntil(error: unknown, now: Date): Date | null {
    if (!error || typeof error !== 'object') return null;
    const failure = error as {
        reason?: unknown;
        status?: unknown;
        message?: unknown;
        details?: { retryAt?: unknown } | null;
        response?: { headers?: unknown; data?: unknown } | null;
    };
    const headers = failure.response?.headers;
    const retryAfter = headerValue(headers, 'retry-after');
    const typed = typeof failure.reason === 'string' && RATE_LIMIT_REASONS.has(failure.reason);
    const status = typeof failure.status === 'number' ? failure.status : null;
    const limited =
        typed ||
        status === 429 ||
        (status === 403 &&
            (headerValue(headers, 'x-ratelimit-remaining') === '0' ||
                retryAfter !== undefined ||
                providerMessage(failure).includes('rate limit')));
    if (!limited) return null;

    const nowMs = now.getTime();
    const named =
        instantMs(failure.details?.retryAt) ??
        retryAfterMs(retryAfter, nowMs) ??
        epochSecondsMs(headerValue(headers, 'x-ratelimit-reset'));
    const untilMs = named ?? nowMs + TASK_PR_READ_RATE_LIMIT_FALLBACK_MS;
    return new Date(
        Math.min(
            nowMs + TASK_PR_READ_RETRY_CAP_MS,
            Math.max(nowMs + TASK_PR_READ_RETRY_BASE_MS, untilMs),
        ),
    );
}

/** One response header by name, case-insensitively, as a trimmed string. */
function headerValue(headers: unknown, name: string): string | undefined {
    if (!headers || typeof headers !== 'object') return undefined;
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (key.toLowerCase() !== name) continue;
        if (typeof value === 'number') return String(value);
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return undefined;
}

/** The provider's words for the failure, lowercased: the response body's `message` and the error's. */
function providerMessage(failure: {
    message?: unknown;
    response?: { data?: unknown } | null;
}): string {
    const data = failure.response?.data;
    const body =
        data &&
        typeof data === 'object' &&
        typeof (data as { message?: unknown }).message === 'string'
            ? (data as { message: string }).message
            : '';
    const own = typeof failure.message === 'string' ? failure.message : '';
    return `${body} ${own}`.toLowerCase();
}

/** An ISO instant (a typed error's `retryAt`) as epoch milliseconds. */
function instantMs(value: unknown): number | undefined {
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
}

/** `retry-after`: seconds from now, or an HTTP date. */
function retryAfterMs(value: string | undefined, nowMs: number): number | undefined {
    if (value === undefined) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return nowMs + seconds * 1000;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
}

/** `x-ratelimit-reset`: Unix seconds. */
function epochSecondsMs(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}
