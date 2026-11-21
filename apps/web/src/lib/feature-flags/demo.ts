import 'server-only';
import { cache } from 'react';
import { API_URL } from '@/lib/constants';
import { DEFAULT_DEMO_SIGN_UP_URL } from '@/lib/demo/demo-errors';

export { DEFAULT_DEMO_SIGN_UP_URL };

/**
 * Demo mode — whether this instance is a public demo, and the two numbers the
 * demo screens print. Read from `GET /api/config` (`features.demoMode` plus the
 * top-level `demo` block), over HTTP rather than from this process's
 * environment: the web and the API are separate deployments, and a web-side
 * copy of `DEMO` would drift from the API's answer.
 *
 * Fails CLOSED, like `readApiSwitch` in `./app-launcher.ts`: a timeout, a
 * non-200, a parse error or an unreachable API all mean "not a demo", so a slow
 * API can never put a demo card on a real installation.
 *
 * The one exception is a web that is itself deployed as a demo (`DEMO=true` in
 * its own environment, see `isDemoHinted`). There a failed or slow read retries
 * once with a longer budget and then keeps the last good answer, else the code
 * defaults with `enabled: true`: the demo API is a single replica on SQLite and
 * now and then takes longer than the first budget, and failing closed there
 * showed the normal login form instead of the demo card. An API ANSWER always
 * wins over the hint. A web without `DEMO` (production) behaves as before: one
 * read, and a failure means "not a demo".
 */

/** Same cap `./app-launcher.ts` uses — a slow API must not hold up a render. */
export const DEMO_CONFIG_BUDGET_MS = 1500;
/**
 * A demo-hinted web's one retry after a failed first read. Only there: a web without the hint
 * (production) never waits for it.
 */
export const DEMO_CONFIG_RETRY_BUDGET_MS = 3000;

export const DEFAULT_DEMO_SANDBOX_TTL_HOURS = 24;

export interface DemoConfig {
    enabled: boolean;
    signUpUrl: string;
    sandboxTtlHours: number;
}

const DISABLED: DemoConfig = {
    enabled: false,
    signUpUrl: DEFAULT_DEMO_SIGN_UP_URL,
    sandboxTtlHours: DEFAULT_DEMO_SANDBOX_TTL_HOURS,
};

/**
 * What a demo-hinted web answers when the API cannot be read and there is no good answer yet:
 * a demo, with the defaults the API itself falls back to (`config.demo.signUpUrl()` and
 * `config.demo.sandboxTtlHours()` in `packages/agent/src/config`). The web does not depend on
 * the agent package, so its copies of those two defaults are `DEFAULT_DEMO_SIGN_UP_URL`
 * (`lib/demo/demo-errors.ts`) and `DEFAULT_DEMO_SANDBOX_TTL_HOURS` above; keep them equal.
 */
const DEMO_HINT_FALLBACK: DemoConfig = {
    enabled: true,
    signUpUrl: DEFAULT_DEMO_SIGN_UP_URL,
    sandboxTtlHours: DEFAULT_DEMO_SANDBOX_TTL_HOURS,
};

/**
 * Whether this web process is itself deployed as a demo: its own `DEMO` env, read with the
 * API's rule (`true`, `1` or `yes`, trimmed, any case; `config.demo.isEnabled()`). Only a
 * hint for when the API cannot be read; it never overrides an API answer.
 */
export function isDemoHinted(): boolean {
    return ['true', '1', 'yes'].includes((process.env.DEMO ?? '').trim().toLowerCase());
}

/**
 * How long an API answer is kept in this server process: about the endpoint's own
 * `Cache-Control: max-age=60`. A failure (timeout, non-200, unreadable body, unreachable API)
 * answers "not a demo" and is kept only briefly, so a transient API blip cannot pin the wrong
 * answer on a demo instance for the full minute.
 */
export const DEMO_CONFIG_TTL_MS = 60_000;
export const DEMO_CONFIG_FAILURE_TTL_MS = 5_000;

/** The last answer, shared by every request this server process serves. */
let cached: { config: DemoConfig; expiresAt: number } | undefined;
/** The last answer the API actually gave: a demo-hinted web's fallback when a read fails. */
let lastGood: DemoConfig | undefined;
/** The read in flight, shared by every caller that asks while it runs. */
let inFlight: Promise<DemoConfig> | undefined;

/**
 * Two layers. Per server request, `React.cache` dedupes the calls of one render (the login page,
 * the session check, the dashboard strip and the expiry redirect may each ask). Across requests,
 * the process-level cache below answers for `DEMO_CONFIG_TTL_MS`: outside a render (a route
 * handler such as the chat turn, a server action) `React.cache` passes every call through, and
 * without it every chat message cost an extra `GET /api/config`, production included.
 */
export const getDemoConfig = cache(readDemoConfigCached);

/** Test seam: forget the process-level answer (module state outlives a single test). */
export function resetDemoConfigCacheForTests(): void {
    cached = undefined;
    lastGood = undefined;
    inFlight = undefined;
}

async function readDemoConfigCached(): Promise<DemoConfig> {
    if (cached && Date.now() < cached.expiresAt) {
        return cached.config;
    }
    if (inFlight) {
        return inFlight;
    }
    const read = resolveDemoConfig()
        .then(({ config, answered }) => {
            // A reset while this read ran (tests) leaves the newer state alone.
            if (inFlight === read) {
                cached = {
                    config,
                    expiresAt:
                        Date.now() + (answered ? DEMO_CONFIG_TTL_MS : DEMO_CONFIG_FAILURE_TTL_MS),
                };
                if (answered) lastGood = config;
            }
            return config;
        })
        .finally(() => {
            if (inFlight === read) inFlight = undefined;
        });
    inFlight = read;
    return read;
}

/**
 * The answer for this read: the API's, or (`answered: false`) the fallback for a failed read.
 * Without the hint that fallback is "not a demo" after one try, exactly as before. With it, one
 * retry on a longer budget, then the last good answer, else `DEMO_HINT_FALLBACK`.
 */
async function resolveDemoConfig(): Promise<{ config: DemoConfig; answered: boolean }> {
    const hinted = isDemoHinted();
    let config = await readDemoConfig(DEMO_CONFIG_BUDGET_MS);
    if (config === undefined && hinted) {
        config = await readDemoConfig(DEMO_CONFIG_RETRY_BUDGET_MS);
    }
    if (config !== undefined) {
        return { config, answered: true };
    }
    return { config: hinted ? (lastGood ?? DEMO_HINT_FALLBACK) : DISABLED, answered: false };
}

/** One read of `GET /api/config` within `budgetMs`; `undefined` when it fails. */
async function readDemoConfig(budgetMs: number): Promise<DemoConfig | undefined> {
    try {
        const response = await fetch(`${API_URL}/config`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(budgetMs),
        });
        if (!response.ok) {
            return undefined;
        }

        const body = (await response.json()) as {
            features?: { demoMode?: unknown };
            demo?: { signUpUrl?: unknown; sandboxTtlHours?: unknown } | null;
        };
        if (body?.features?.demoMode !== true) {
            return DISABLED;
        }

        const signUpUrl = body.demo?.signUpUrl;
        const ttl = body.demo?.sandboxTtlHours;
        return {
            enabled: true,
            signUpUrl:
                typeof signUpUrl === 'string' && signUpUrl.length > 0
                    ? signUpUrl
                    : DEFAULT_DEMO_SIGN_UP_URL,
            sandboxTtlHours:
                typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0
                    ? ttl
                    : DEFAULT_DEMO_SANDBOX_TTL_HOURS,
        };
    } catch {
        return undefined;
    }
}
