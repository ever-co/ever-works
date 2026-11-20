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
 * Read once per server request (`React.cache`): the login page, the session check, the dashboard
 * strip and the expiry redirect may each ask during one render. Outside a render (a server action,
 * a route handler) every call reads the API, as before.
 */
export const getDemoConfig = cache(readDemoConfig);

async function readDemoConfig(): Promise<DemoConfig> {
    try {
        const response = await fetch(`${API_URL}/config`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(DEMO_CONFIG_BUDGET_MS),
        });
        if (!response.ok) {
            return DISABLED;
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
        return DISABLED;
    }
}
