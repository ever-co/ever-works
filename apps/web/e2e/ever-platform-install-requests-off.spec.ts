import { expect, test } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Install requests from apps.ever.co while the Ever Platform connection is OFF
 * (the default: `EVER_CONNECT_ENABLED` unset). Nothing of the feature exists:
 *
 *  - every install-request route answers 404, also to a request that carries a
 *    body (the module is not loaded, so there is no guard to answer 401/403);
 *  - Settings → Ever Platform shows no Install requests section (the page is
 *    a 404 when statistics are off too, or shows statistics only);
 *  - no page load asks an Ever host for anything.
 *
 * The section itself (rows, the allow-list box, approve and decline) is covered
 * by `InstallRequestsPanel.unit.spec.tsx`, and the API end to end against the
 * Ever Platform SDK's mock platform by `install-requests.mock.itest.spec.ts`.
 */
const INSTALL_ID = '01JZ8Q3M4N5P6R7S8T9V0W1X2Y';
const EVER_HOST = /(^|\.)ever\.co$/;

test.describe('Install requests with the Ever Platform connection off', () => {
    test('every install-request route answers 404', async ({ request }) => {
        const list = await request.get(`${API_BASE}/api/ever-connect/install-requests`);
        expect(list.status()).toBe(404);
        for (const action of ['approve', 'decline']) {
            const response = await request.post(
                `${API_BASE}/api/ever-connect/install-requests/${INSTALL_ID}/${action}`,
                { data: { addToAllowlist: true } },
            );
            expect(response.status()).toBe(404);
        }
    });

    test('Settings → Ever Platform has no Install requests section and asks no Ever host', async ({
        page,
    }) => {
        const hosts = new Set<string>();
        page.on('request', (req) => {
            try {
                hosts.add(new URL(req.url()).hostname);
            } catch {
                // ignore non-URL requests
            }
        });
        await page.goto('/settings/ever-platform');
        await expect(page.locator('body')).toBeVisible();
        await expect(page.getByTestId('install-requests-panel')).toHaveCount(0);
        await expect(page.getByTestId('install-request-row')).toHaveCount(0);
        expect([...hosts].filter((host) => EVER_HOST.test(host))).toEqual([]);
    });
});
