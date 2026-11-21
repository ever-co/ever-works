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
 */

/** Same cap `./app-launcher.ts` uses — a slow API must not hold up a render. */
const DEMO_CONFIG_BUDGET_MS = 1500;

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
 * How long an API answer is kept in this server process: about the endpoint's own
 * `Cache-Control: max-age=60`. A failure (timeout, non-200, unreadable body, unreachable API)
 * answers "not a demo" and is kept only briefly, so a transient API blip cannot pin the wrong
 * answer on a demo instance for the full minute.
 */
export const DEMO_CONFIG_TTL_MS = 60_000;
export const DEMO_CONFIG_FAILURE_TTL_MS = 5_000;

/** The last answer, shared by every request this server process serves. */
let cached: { config: DemoConfig; expiresAt: number } | undefined;
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
    inFlight = undefined;
}

async function readDemoConfigCached(): Promise<DemoConfig> {
    if (cached && Date.now() < cached.expiresAt) {
        return cached.config;
    }
    if (inFlight) {
        return inFlight;
    }
    const read = readDemoConfig()
        .then(({ config, answered }) => {
            // A reset while this read ran (tests) leaves the newer state alone.
            if (inFlight === read) {
                cached = {
                    config,
                    expiresAt:
                        Date.now() + (answered ? DEMO_CONFIG_TTL_MS : DEMO_CONFIG_FAILURE_TTL_MS),
                };
            }
            return config;
        })
        .finally(() => {
            if (inFlight === read) inFlight = undefined;
        });
    inFlight = read;
    return read;
}

/** One read of `GET /api/config`. `answered` is false when it failed closed. */
async function readDemoConfig(): Promise<{ config: DemoConfig; answered: boolean }> {
    try {
        const response = await fetch(`${API_URL}/config`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(DEMO_CONFIG_BUDGET_MS),
        });
        if (!response.ok) {
            return { config: DISABLED, answered: false };
        }

        const body = (await response.json()) as {
            features?: { demoMode?: unknown };
            demo?: { signUpUrl?: unknown; sandboxTtlHours?: unknown } | null;
        };
        if (body?.features?.demoMode !== true) {
            return { config: DISABLED, answered: true };
        }

        const signUpUrl = body.demo?.signUpUrl;
        const ttl = body.demo?.sandboxTtlHours;
        return {
            config: {
                enabled: true,
                signUpUrl:
                    typeof signUpUrl === 'string' && signUpUrl.length > 0
                        ? signUpUrl
                        : DEFAULT_DEMO_SIGN_UP_URL,
                sandboxTtlHours:
                    typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0
                        ? ttl
                        : DEFAULT_DEMO_SANDBOX_TTL_HOURS,
            },
            answered: true,
        };
    } catch {
        return { config: DISABLED, answered: false };
    }
}
