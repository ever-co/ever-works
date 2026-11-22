import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * R-16 — the Ever Connect provision cookie is host-only on HTTPS: `__Host-ew_provision`, Secure,
 * `Path=/`, no Domain, so a Work on a sibling subdomain cannot plant a provision state. Plain on
 * http (dev, e2e).
 */

const jar = vi.hoisted(() => {
    const values = new Map<string, string>();
    const sets: Array<{ name: string; value: string; options?: Record<string, unknown> }> = [];
    const deletes: Array<Record<string, unknown>> = [];
    return {
        values,
        sets,
        deletes,
        reset() {
            values.clear();
            sets.length = 0;
            deletes.length = 0;
        },
        store: {
            get: (name: string) =>
                values.has(name) ? { name, value: values.get(name)! } : undefined,
            set: (name: string, value: string, options?: Record<string, unknown>) => {
                sets.push({ name, value, options });
                values.set(name, value);
            },
            delete: (arg: string | ({ name: string } & Record<string, unknown>)) => {
                const options = typeof arg === 'string' ? { name: arg } : arg;
                deletes.push(options);
                values.delete(options.name as string);
            },
        },
    };
});

vi.mock('next/headers', () => ({ cookies: async () => jar.store }));

const SECRET = 'x'.repeat(48);
const ORIGINAL_ENV = { ...process.env };
const STATE = { provisionTxn: 'txn-1', jti: 'jti-1', handle: 'sealed-handle' };

async function load(webUrl: string) {
    vi.resetModules();
    process.env.COOKIE_SECRET = SECRET;
    process.env.AUTH_SECRET = SECRET;
    process.env.WEB_URL = webUrl;
    return import('./ever-connect-provision-cookie');
}

describe('Ever Connect provision cookie (R-16)', () => {
    beforeEach(() => jar.reset());
    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    it('is __Host-ew_provision on HTTPS: Secure, Path=/, no Domain, HttpOnly, 15 minutes', async () => {
        const provision = await load('https://app.ever.works');

        await provision.setProvisionCookie(STATE);

        expect(jar.sets).toHaveLength(1);
        expect(jar.sets[0].name).toBe('__Host-ew_provision');
        expect(jar.sets[0].options).toMatchObject({
            secure: true,
            path: '/',
            httpOnly: true,
            sameSite: 'lax',
            maxAge: 900,
        });
        expect(jar.sets[0].options).not.toHaveProperty('domain');
        expect(await provision.readProvisionCookie()).toEqual(STATE);
    });

    it('ignores a planted plain-name ew_provision on HTTPS', async () => {
        const provision = await load('https://app.ever.works');
        // A well-formed state sealed with the same key, under the name a sibling host could set.
        await provision.setProvisionCookie(STATE);
        jar.values.set('ew_provision', jar.values.get('__Host-ew_provision')!);
        jar.values.delete('__Host-ew_provision');

        expect(await provision.readProvisionCookie()).toBeNull();
    });

    it('clears __Host-ew_provision with Secure and Path=/, so the browser drops it', async () => {
        const provision = await load('https://app.ever.works');
        await provision.setProvisionCookie(STATE);

        await provision.clearProvisionCookie();

        expect(jar.deletes).toEqual([
            expect.objectContaining({ name: '__Host-ew_provision', secure: true, path: '/' }),
        ]);
        expect(await provision.readProvisionCookie()).toBeNull();
    });

    it('keeps the plain name on http', async () => {
        const provision = await load('http://localhost:3000');

        await provision.setProvisionCookie(STATE);

        expect(jar.sets[0].name).toBe('ew_provision');
        expect(jar.sets[0].options).toMatchObject({ secure: false, path: '/' });
        expect(await provision.readProvisionCookie()).toEqual(STATE);
    });
});
