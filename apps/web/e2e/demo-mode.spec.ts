import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Cookie, type Page } from '@playwright/test';
import { makeTestUser } from './helpers/api';
import { loginViaUI } from './helpers/auth';

/**
 * Platform demo mode, end to end against a running instance (Task 14).
 *
 * Gated on `E2E_DEMO`, so the PR suite (which has no demo server) skips all of it:
 *  - `E2E_DEMO=1`, project `demo`: the web and an API booted with `DEMO=true`
 *    (`scripts/dev/demo-local.env.example`).
 *  - `E2E_DEMO=0`, project `demo-off`: the same build with `DEMO` unset.
 *
 * Environment:
 *  - `PLAYWRIGHT_BASE_URL` — the web; `API_URL` — the API (bare host, as everywhere in e2e/).
 *  - `DEMO_E2E_DATABASE_PATH` — the demo API's SQLite file. The session-expiry and
 *    expired-sandbox cases read and write it (they skip without it): the expiry case
 *    ends a sandbox the way time would, without waiting 24 hours.
 *  - `DEMO_E2E_SCREENSHOT_DIR` — when set, the login card and the dashboard strip are
 *    saved there as PNGs (the PR's screenshots).
 *
 * The `demo` cases share one sandbox and run in order: the first one starts it from
 * `/login`, the last one expires it. One more sandbox is minted from the page for the
 * blocked-route and cross-sandbox cases, so a run makes two (the default limit is five
 * an hour per IP).
 */

const MODE = process.env.E2E_DEMO;
const API_ORIGIN = (process.env.API_URL || 'http://localhost:3100')
    .replace(/\/+$/, '')
    .replace(/\/api$/, '');
const DB_PATH = process.env.DEMO_E2E_DATABASE_PATH;
const SCREENSHOT_DIR = process.env.DEMO_E2E_SCREENSHOT_DIR;

const STRIP_TEXT =
    'You are using a demo account. Finding our software useful? Click here to Sign Up and start using for free!';
const EXPIRED_TEXT = 'Your demo workspace expired — start a new one';
const PROJECT_WORK = 'Launch the Acme website';
const DIRECTORY_WORK = 'Awesome AI Coding Tools';
const RECORDED_GOAL = 'Publish the launch blog post';
/** A moment long past, in both shapes the SQLite columns hold (epoch ms, and TypeORM's UTC text). */
const LONG_AGO_MS = Date.UTC(2000, 0, 1);
const LONG_AGO_TEXT = '2000-01-01 00:00:00.000';
/** Where "Start the demo" lands: the sandbox Organization's dashboard (slug `acme-labs-<username>`). */
const DEMO_HOME = /^(\/org\/acme-labs-demo-[0-9a-f]{8})\/dashboard$/;

/** The UUID that follows `marker` in a URL or path, e.g. a Work's id after `/works/`. */
function uuidAfter(marker: string, url: string | null): string | null {
    if (!url) return null;
    const at = url.indexOf(marker);
    const match = at < 0 ? null : /^[0-9a-f-]{36}/.exec(url.slice(at + marker.length));
    return match ? match[0] : null;
}

function openDb(): DatabaseSync {
    const db = new DatabaseSync(DB_PATH as string);
    // The API holds the same file open; wait for its write lock instead of failing.
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
}

/** A SQLite timestamp as epoch ms: TypeORM stores some as integers, `datetime` columns as UTC text. */
function toEpochMs(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string') {
        if (/^\d+$/.test(value)) return Number(value);
        return Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
    }
    throw new Error(`Not a timestamp: ${String(value)}`);
}

function demoUserIds(): Set<string> {
    const db = openDb();
    try {
        const rows = db
            .prepare("SELECT id FROM users WHERE registrationProvider = 'demo'")
            .all() as { id: string }[];
        return new Set(rows.map((row) => row.id));
    } finally {
        db.close();
    }
}

async function saveScreenshot(page: Page, name: string): Promise<void> {
    if (!SCREENSHOT_DIR) return;
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(SCREENSHOT_DIR, name) });
}

/** The sandbox started from `/login` in the first case; every later case reuses it. */
const sandbox: {
    cookies: Cookie[];
    /** `/org/<slug>`: the sandbox's Organization, where its seeded rows live. */
    home: string;
    userId: string | null;
    projectWorkId: string | null;
    recordedGoalId: string | null;
} = { cookies: [], home: '', userId: null, projectWorkId: null, recordedGoalId: null };

/** The second sandbox's session token, minted by the blocked-route case. */
let secondSandboxToken: string | null = null;

async function asVisitor(context: BrowserContext): Promise<void> {
    expect(sandbox.cookies.length, 'the first case did not start a sandbox').toBeGreaterThan(0);
    await context.addCookies(sandbox.cookies);
}

test.describe('platform demo mode: DEMO on', { tag: '@demo-on' }, () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(MODE !== '1', 'needs a DEMO=true instance: E2E_DEMO=1 (project "demo")');

    test('GET /api/config reports the demo', async ({ request }) => {
        const res = await request.get(`${API_ORIGIN}/api/config`);
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.features.demoMode).toBe(true);
        expect(body.demo).toEqual({
            signUpUrl: expect.stringMatching(/^https:\/\//),
            sandboxTtlHours: expect.any(Number),
        });
    });

    test('/login offers "Start the demo"; one click lands in its Organization under the strip', async ({
        page,
        request,
    }) => {
        const config = await (await request.get(`${API_ORIGIN}/api/config`)).json();

        await page.goto('/login');
        const card = page.getByTestId('demo-login-card');
        await expect(card).toBeVisible();
        const start = card.getByRole('button', { name: 'Start the demo' });
        await expect(start).toBeEnabled();
        // The password form is still there for operators, folded away.
        await expect(page.getByTestId('demo-operator-login')).not.toHaveAttribute('open', /.*/);
        await saveScreenshot(page, 'demo-login-card.png');

        const before = DB_PATH ? demoUserIds() : new Set<string>();
        await start.click();
        // The seeder pins the sandbox's Organization as its landing scope: that is where its
        // Goals, Missions and Tasks are (the personal workspace has none of them).
        await page.waitForURL((url) => DEMO_HOME.test(url.pathname), { timeout: 60_000 });
        sandbox.home = (DEMO_HOME.exec(new URL(page.url()).pathname) as RegExpExecArray)[1];

        const strip = page.getByTestId('demo-strip');
        await expect(strip).toBeVisible();
        await expect(strip.locator('p').first()).toHaveText(STRIP_TEXT);
        const signUp = page.getByTestId('demo-strip-sign-up');
        await expect(signUp).toHaveText('Click here to Sign Up');
        await expect(signUp).toHaveAttribute('href', config.demo.signUpUrl);
        await expect(strip).toContainText(/Demo workspace expires in \d+ h/);
        await saveScreenshot(page, 'demo-dashboard-strip.png');

        sandbox.cookies = await page.context().cookies();
        if (DB_PATH) {
            const created = [...demoUserIds()].filter((id) => !before.has(id));
            expect(created, 'exactly one demo user is created per click').toHaveLength(1);
            sandbox.userId = created[0];
        }
    });

    test('the sandbox is seeded with the Project Work and the draft directory Work', async ({
        page,
    }) => {
        await asVisitor(page.context());
        await page.goto(`${sandbox.home}/works`);
        await expect(page.getByTestId('demo-strip')).toBeVisible();
        for (const name of [PROJECT_WORK, DIRECTORY_WORK]) {
            await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
        }

        const projectLink = page
            .locator('a[href*="/works/"]')
            .filter({ hasText: PROJECT_WORK })
            .first();
        sandbox.projectWorkId = uuidAfter('/works/', await projectLink.getAttribute('href'));
        expect(sandbox.projectWorkId).toBeTruthy();
    });

    test('the recorded Goal shows its two completed iterations', async ({ page }) => {
        await asVisitor(page.context());
        await page.goto(`${sandbox.home}/goals`);
        await page.getByRole('link', { name: RECORDED_GOAL }).first().click();
        await page.waitForURL(/\/goals\/[0-9a-f-]{36}/);
        sandbox.recordedGoalId = uuidAfter('/goals/', page.url());

        await expect(page.getByRole('heading', { level: 1, name: RECORDED_GOAL })).toBeVisible();
        await expect(page.getByText('Iteration 2', { exact: true })).toBeVisible();

        // One row per iteration Task with its run; the Goal's other Tasks (never run) are
        // listed too, with "—" for the iteration.
        await page.getByRole('tab', { name: 'Sessions' }).click();
        const iterations = page
            .locator('table tbody tr')
            .filter({ has: page.locator('td:first-child', { hasText: /^\s*\d+\s*$/ }) });
        await expect(iterations).toHaveCount(2);
        for (const [index, iteration] of ['1', '2'].entries()) {
            const row = iterations.nth(index);
            await expect(row.locator('td').first()).toHaveText(iteration);
            await expect(row).toContainText(`${RECORDED_GOAL} — iteration ${iteration}`);
            await expect(row).toContainText('Completed');
        }
    });

    test('the session ends exactly when the sandbox does (anonymousExpiresAt)', async () => {
        test.skip(!DB_PATH, 'needs DEMO_E2E_DATABASE_PATH');
        expect(sandbox.userId).toBeTruthy();
        const db = openDb();
        try {
            const user = db
                .prepare(
                    'SELECT isAnonymous, registrationProvider, anonymousExpiresAt, username FROM users WHERE id = ?',
                )
                .get(sandbox.userId as string) as Record<string, unknown>;
            const sessions = db
                .prepare('SELECT expiresAt FROM session WHERE userId = ?')
                .all(sandbox.userId as string) as { expiresAt: unknown }[];

            expect(user.registrationProvider).toBe('demo');
            expect(Number(user.isAnonymous)).toBe(1);
            expect(String(user.username)).toMatch(/^demo-[0-9a-f]{8}$/);
            expect(sessions).toHaveLength(1);
            const sandboxEnds = toEpochMs(user.anonymousExpiresAt);
            expect(toEpochMs(sessions[0].expiresAt)).toBe(sandboxEnds);
            // ~24 h (DEMO_SANDBOX_TTL_HOURS) from now, and never already past.
            expect(sandboxEnds).toBeGreaterThan(Date.now());
        } finally {
            db.close();
        }
    });

    test('PATCH /api/plugins/openrouter/settings from the page answers 403 DEMO_DISABLED', async ({
        page,
    }) => {
        await asVisitor(page.context());
        await page.goto(`${sandbox.home}/dashboard`);
        // The calls go out on the page's own request context (its cookies, its client). Not
        // `fetch` inside the page: the web's CSP lets the browser reach only the configured API
        // origin, and a deployed demo's browser never calls the API host directly. A sandbox's
        // session token lives only in the web's encrypted httpOnly cookie, so a second sandbox
        // is minted through the public endpoint and the API is called as it.
        const started = await page.request.post(`${API_ORIGIN}/api/auth/demo`, { data: {} });
        expect(started.status()).toBe(201);
        const { access_token: token } = (await started.json()) as { access_token: string };

        const patched = await page.request.patch(`${API_ORIGIN}/api/plugins/openrouter/settings`, {
            headers: { Authorization: `Bearer ${token}` },
            data: { settings: { defaultModel: 'openai/gpt-6.1-sol' } },
        });
        expect(patched.status()).toBe(403);
        expect((await patched.json()).code).toBe('DEMO_DISABLED');
        secondSandboxToken = token;
    });

    test('one sandbox cannot reach or share into another', async ({ request }) => {
        expect(
            secondSandboxToken,
            'the blocked-route case did not mint a second sandbox',
        ).toBeTruthy();
        expect(sandbox.recordedGoalId).toBeTruthy();
        const bearer = { Authorization: `Bearer ${secondSandboxToken}` };
        const profile = await (
            await request.get(`${API_ORIGIN}/api/auth/profile/fresh`, { headers: bearer })
        ).json();
        // Every request below runs in the second sandbox's own Organization, as its pages do.
        const auth = { ...bearer, 'x-scope-slug': `acme-labs-${profile.username}` };

        // Its own recorded Goal is readable — the control for the refusals below.
        const ownGoalId = profile.demo?.recordedGoalId as string;
        expect(ownGoalId).toBeTruthy();
        expect(ownGoalId).not.toBe(sandbox.recordedGoalId);
        expect(
            (
                await request.get(`${API_ORIGIN}/api/me/goals/${ownGoalId}`, { headers: auth })
            ).status(),
        ).toBe(200);

        // The first sandbox's rows are invisible to it.
        expect(
            (
                await request.get(`${API_ORIGIN}/api/me/goals/${sandbox.recordedGoalId}`, {
                    headers: auth,
                })
            ).status(),
        ).toBe(404);
        // Nor can it step into the first sandbox's Organization.
        const foreignScope = await request.get(
            `${API_ORIGIN}/api/me/goals/${sandbox.recordedGoalId}`,
            { headers: { ...bearer, 'x-scope-slug': sandbox.home.split('/')[2] } },
        );
        expect([403, 404]).toContain(foreignScope.status());
        const work = await request.get(`${API_ORIGIN}/api/works/${sandbox.projectWorkId}`, {
            headers: auth,
        });
        expect([403, 404]).toContain(work.status());

        // Adding a member, or inviting one by email, is refused before any lookup.
        const member = await request.post(
            `${API_ORIGIN}/api/works/${sandbox.projectWorkId}/members`,
            {
                headers: auth,
                data: {
                    userId: sandbox.userId ?? '00000000-0000-4000-8000-000000000000',
                    role: 'editor',
                },
            },
        );
        expect(member.status()).toBe(403);
        expect((await member.json()).code).toBe('DEMO_DISABLED');
        const invite = await request.post(
            `${API_ORIGIN}/api/works/${sandbox.projectWorkId}/invitations`,
            {
                headers: auth,
                data: { email: 'someone@example.com', role: 'editor' },
            },
        );
        expect(invite.status()).toBe(403);
        expect((await invite.json()).code).toBe('DEMO_DISABLED');
    });

    test('an expired sandbox sends the visitor to /login?demo=expired', async ({ page }) => {
        test.skip(!DB_PATH, 'needs DEMO_E2E_DATABASE_PATH');
        expect(sandbox.userId).toBeTruthy();
        await asVisitor(page.context());
        await page.goto(`${sandbox.home}/dashboard`);
        await expect(page.getByTestId('demo-strip')).toBeVisible();

        // What the clock would do after DEMO_SANDBOX_TTL_HOURS: the sandbox and its session end.
        const db = openDb();
        try {
            const current = db
                .prepare('SELECT anonymousExpiresAt FROM users WHERE id = ?')
                .get(sandbox.userId as string) as { anonymousExpiresAt: unknown };
            const longAgo =
                typeof current.anonymousExpiresAt === 'string' ? LONG_AGO_TEXT : LONG_AGO_MS;
            db.prepare('UPDATE users SET anonymousExpiresAt = ? WHERE id = ?').run(
                longAgo,
                sandbox.userId as string,
            );
            db.prepare('UPDATE session SET expiresAt = ? WHERE userId = ?').run(
                LONG_AGO_TEXT,
                sandbox.userId as string,
            );
        } finally {
            db.close();
        }

        await page.reload();
        await page.waitForURL(
            (url) => url.pathname === '/login' && url.searchParams.get('demo') === 'expired',
        );
        await expect(page.getByTestId('demo-expired-notice')).toHaveText(EXPIRED_TEXT);
        await expect(page.getByRole('button', { name: 'Start the demo' })).toBeEnabled();
        await expect(page.getByTestId('demo-strip')).toHaveCount(0);
    });
});

test.describe('platform demo mode: DEMO unset', { tag: '@demo-off' }, () => {
    test.skip(MODE !== '0', 'needs an instance with DEMO unset: E2E_DEMO=0 (project "demo-off")');

    test('no demo card, no strip, no demo route', async ({ page, request }) => {
        const config = await (await request.get(`${API_ORIGIN}/api/config`)).json();
        expect(config.features?.demoMode).not.toBe(true);
        expect(config.demo ?? null).toBeNull();
        expect((await request.post(`${API_ORIGIN}/api/auth/demo`, { data: {} })).status()).toBe(
            404,
        );

        await page.goto('/login');
        await expect(page.locator('input[name="email"]')).toBeVisible();
        await expect(page.getByTestId('demo-login-card')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Start the demo' })).toHaveCount(0);

        // A normal account on a normal instance: the dashboard has no strip.
        const user = makeTestUser('demo-off');
        const registered = await request.post(`${API_ORIGIN}/api/auth/register`, {
            data: { username: user.name, email: user.email, password: user.password },
        });
        expect(registered.ok(), await registered.text()).toBeTruthy();
        await loginViaUI(page, user);
        await page.goto('/');
        await expect(page.getByRole('main').first()).toBeVisible();
        await expect(page.getByTestId('demo-strip')).toHaveCount(0);
        await expect(page.getByText('You are using a demo account.')).toHaveCount(0);
    });
});
