import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { registerUserViaAPI } from './helpers/api';
import { loginViaUI } from './helpers/auth';

/**
 * The ever.works home-page hand-off: a visitor types a prompt there, picks a
 * type chip, and lands on `/onboarding#prompt=…&corrId=…&type=…`.
 *
 * Three things the owner hit on app.ever.works (2026-11-20), pinned here:
 *
 *  1. The wizard jumped straight to "Step 11 of 11" with every earlier step
 *     shown as done. It now opens a prompt-first quick start (Idea → Generate
 *     → Open your Work) that names the defaults, with "Customize setup" for
 *     the full wizard.
 *  2. "Generate now" only said "Generating…". It now opens a live console:
 *     the Work being created, then the generation's steps, log and progress —
 *     or, when the start is refused, the reason and what to do next.
 *  3. Leaving the wizard showed an empty page while the next page loaded. It
 *     now shows where it is going.
 *
 * A fresh user per test, logged in through the UI: the tests change onboarding
 * state (the saved prompt, "Customize setup", a completed onboarding in a keyed
 * environment), so they never share a user — with each other, under
 * `fullyParallel`, or with the seeded storageState user.
 *
 * Env-adaptive on purpose: keyless CI refuses quick-create upfront with the
 * provider gate (400 `providerErrors`, nothing created — see
 * flow-works-quick-create-stats.spec.ts), a keyed environment starts the run.
 * Both outcomes must leave the visitor with something to read and do.
 */

const PROMPT =
    'Directory of AI robot companies, their products, prices and build-your-own GitHub repos';
function handoffUrl(): string {
    const corrId = `e2e-qs-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return `/onboarding#prompt=${encodeURIComponent(PROMPT)}&corrId=${corrId}&type=directory-website`;
}

test.use({ storageState: { cookies: [], origins: [] } });

async function openHandoff(page: Page, request: APIRequestContext) {
    const user = await registerUserViaAPI(request, {});
    await loginViaUI(page, { email: user.email, password: user.password });
    await page.goto(handoffUrl(), { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('onboarding-quick-start')).toBeVisible({ timeout: 45_000 });
}

test.describe('Onboarding — prompt-first quick start from the ever.works home page', () => {
    test('a home-page prompt opens the quick start, not the last of eleven pre-ticked steps', async ({
        page,
        request,
    }) => {
        await openHandoff(page, request);

        await expect(page.getByText(/Step \d+ of \d+/)).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Your Git Storage' })).toHaveCount(0);
        await expect(page.getByTestId('onboarding-prompt-input')).toHaveValue(PROMPT);
        await expect(page.getByTestId('onboarding-work-kind')).toContainText('Directory website');
        await expect(page.getByTestId('onboarding-quick-start-defaults')).toContainText('AI');
        // The hand-off is consumed: no `#type=directory-website` left behind.
        await expect(page).toHaveURL(/\/onboarding$/);
    });

    test('"Customize setup" opens the full wizard at step 1, keeping the prompt', async ({
        page,
        request,
    }) => {
        await openHandoff(page, request);

        await expect(async () => {
            await page.getByTestId('onboarding-quick-start-customize').click();
            await expect(page.getByText(/Step 1 of \d+/)).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 30_000 });
        await expect(page.getByRole('heading', { name: 'Welcome to Ever Works' })).toBeVisible();
        await expect(page.getByTestId('onboarding-quick-start')).toHaveCount(0);

        // The last step still offers "Generate now" with the same prompt.
        await page.getByRole('button', { name: 'Create your first Work' }).click();
        await expect(page.getByTestId('onboarding-prompt-input')).toHaveValue(PROMPT);
        await expect(page.getByTestId('onboarding-generate-now')).toBeVisible();
    });

    test('"Generate now" opens a live console that ends in something to do', async ({
        page,
        request,
    }) => {
        // Keyless CI refuses within a second; a keyed environment provisions
        // the Work's repositories first, which takes longer.
        test.setTimeout(240_000);
        await openHandoff(page, request);

        const log = page.getByRole('log', { name: 'Generation log' });
        await expect(async () => {
            await page.getByTestId('onboarding-generate-now').click();
            await expect(log).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 30_000 });
        await expect(log).toContainText('Creating your Work');
        await expect(page.getByTestId('onboarding-console-elapsed')).toHaveText(/^\d+:\d{2}$/);

        const refused = page.getByTestId('onboarding-generate-error');
        const started = page.getByTestId('onboarding-console-open-work');
        await expect(
            refused.or(started).first(),
            'the run must end in a refusal with next steps or a started Work — never a bare spinner',
        ).toBeVisible({ timeout: 90_000 });

        if (await refused.isVisible()) {
            // Keyless CI: the provider gate refuses before anything is created.
            await expect(page.getByTestId('onboarding-console-status')).toHaveText(
                'Could not start',
            );
            await expect(page.getByTestId('onboarding-console-hint')).not.toBeEmpty();
            await expect(page.getByTestId('onboarding-console-retry')).toBeVisible();
            // The prompt stays editable for the next try.
            await expect(page.getByTestId('onboarding-prompt-input')).toBeEditable();
            return;
        }

        // Keyed environment: the run started. The console follows it, and
        // "Open your Work" lands on the Work, with a loading state on the way.
        await expect(log).toContainText('Generation started');
        await started.click();
        await expect(page.getByTestId('onboarding-transition')).toContainText('Opening');
        await expect(page).toHaveURL(/\/works\/[^/]+(\/generator)?$/, { timeout: 90_000 });
    });

    test('closing the quick start shows a loading state instead of an empty page', async ({
        page,
        request,
    }) => {
        await openHandoff(page, request);

        // Hold the dashboard's RSC payload for a moment so the in-between state
        // is observable however fast the server is.
        await page.route(/[?&]_rsc=/, async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            await route.continue();
        });

        await page
            .getByTestId('onboarding-quick-start')
            .getByRole('button', { name: 'Close' })
            .click();

        await expect(page.getByTestId('onboarding-transition')).toContainText(
            'Opening your dashboard',
        );
        await expect(page).not.toHaveURL(/\/onboarding/, { timeout: 90_000 });
    });
});
