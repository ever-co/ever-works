import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `register()` reads its config straight from `process.env`, so we reset the
// module registry and re-import per test to get a clean evaluation each time.
// We also pin the env we care about (NEXT_RUNTIME so the body actually runs,
// a valid 32+ char secret so it reaches the ALLOWED_REDIRECT_URLS guard, and
// NODE_ENV / ALLOWED_REDIRECT_URLS which are the inputs under test).
const ORIGINAL_ENV = { ...process.env };

async function loadRegister(): Promise<typeof import('./instrumentation').register> {
    vi.resetModules();
    const mod = await import('./instrumentation');
    return mod.register;
}

const VALID_SECRET = 'a'.repeat(32);

describe('instrumentation register() — ALLOWED_REDIRECT_URLS prod guard', () => {
    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV };
        // Run the Node-runtime branch and pass the AUTH_SECRET checks so the
        // new ALLOWED_REDIRECT_URLS guard is reached.
        process.env.NEXT_RUNTIME = 'nodejs';
        process.env.COOKIE_SECRET = VALID_SECRET;
        delete process.env.AUTH_SECRET;
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        vi.restoreAllMocks();
    });

    it('warns when NODE_ENV=production and ALLOWED_REDIRECT_URLS is unset', async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        delete process.env.ALLOWED_REDIRECT_URLS;

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const register = await loadRegister();
        await register();

        const warned = warnSpy.mock.calls
            .flat()
            .map((arg) => String(arg))
            .join(' ');
        expect(warned).toMatch(/ALLOWED_REDIRECT_URLS is not set/i);
        expect(warned).toMatch(/\[security\]/i);
    });

    it('does NOT warn when ALLOWED_REDIRECT_URLS is set in production', async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        process.env.ALLOWED_REDIRECT_URLS = 'app.ever.works,ever.works';

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const register = await loadRegister();
        await register();

        const warned = warnSpy.mock.calls
            .flat()
            .map((arg) => String(arg))
            .join(' ');
        expect(warned).not.toMatch(/ALLOWED_REDIRECT_URLS is not set/i);
    });

    it('does NOT warn outside production even when ALLOWED_REDIRECT_URLS is unset', async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
        delete process.env.ALLOWED_REDIRECT_URLS;

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const register = await loadRegister();
        await register();

        const warned = warnSpy.mock.calls
            .flat()
            .map((arg) => String(arg))
            .join(' ');
        expect(warned).not.toMatch(/ALLOWED_REDIRECT_URLS is not set/i);
    });
});

describe('instrumentation register() — R-16 legacy session cookie fallback', () => {
    beforeEach(() => {
        process.env = { ...ORIGINAL_ENV };
        process.env.NEXT_RUNTIME = 'nodejs';
        process.env.COOKIE_SECRET = VALID_SECRET;
        process.env.ALLOWED_REDIRECT_URLS = 'app.ever.works';
        process.env.WEB_URL = 'https://app.ever.works';
        delete process.env.AUTH_SECRET;
        delete process.env.AUTH_COOKIE_LEGACY_FALLBACK;
        delete process.env.AUTH_COOKIE_LEGACY_FALLBACK_UNTIL;
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-22T12:00:00.000Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
        process.env = { ...ORIGINAL_ENV };
        vi.restoreAllMocks();
    });

    function logged(spy: { mock: { calls: unknown[][] } }): string {
        return spy.mock.calls
            .flat()
            .map((arg) => String(arg))
            .join('\n');
    }

    it('logs one line at start with the effective end', async () => {
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const register = await loadRegister();
        await register();

        const lines = infoSpy.mock.calls
            .map((call) => String(call[0]))
            .filter((line) => line.startsWith('[auth-cookie]'));
        expect(lines).toEqual([
            '[auth-cookie] session cookie: __Host-everworks_auth_token; legacy fallback ON until 2026-12-06T00:00:00.000Z (AUTH_COOKIE_LEGACY_FALLBACK_UNTIL)',
        ]);
        expect(logged(warnSpy)).not.toContain('[auth-cookie]');
    });

    it('warns once on an unknown AUTH_COOKIE_LEGACY_FALLBACK value', async () => {
        process.env.AUTH_COOKIE_LEGACY_FALLBACK = 'flase';
        vi.spyOn(console, 'info').mockImplementation(() => {});
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const register = await loadRegister();
        await register();

        const warnings = warnSpy.mock.calls
            .map((call) => String(call[0]))
            .filter((line) => line.startsWith('[auth-cookie]'));
        expect(warnings).toEqual([
            '[auth-cookie] AUTH_COOKIE_LEGACY_FALLBACK="flase" is not a known value (use true or false); treating it as on',
        ]);
    });
});
