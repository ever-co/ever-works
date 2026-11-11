// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express') as typeof import('express');
import type { IncomingMessage } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as request from 'supertest';
import {
    ACCOUNT_IMPORT_PATHS,
    accountImportCallerCheck,
    DEFAULT_ACCOUNT_IMPORT_BODY_LIMIT_BYTES,
    MAX_ACCOUNT_IMPORT_BODY_LIMIT_BYTES,
    mountAccountImportBodyParser,
    resolveAccountImportBodyLimit,
} from './account-import-body-limit';

const MB = 1024 * 1024;

describe('resolveAccountImportBodyLimit', () => {
    it('defaults to 25 MB (the ingress proxy-body-size)', () => {
        expect(DEFAULT_ACCOUNT_IMPORT_BODY_LIMIT_BYTES).toBe(25 * MB);
        expect(resolveAccountImportBodyLimit(undefined)).toBe(25 * MB);
        expect(resolveAccountImportBodyLimit('  ')).toBe(25 * MB);
    });

    it('accepts a size within the ceiling', () => {
        expect(resolveAccountImportBodyLimit('40mb', () => undefined)).toBe(40 * MB);
        expect(resolveAccountImportBodyLimit(' 10MB ', () => undefined)).toBe(10 * MB);
    });

    it.each(['51mb', '1gb', 'lots', '0', '-1mb'])('falls back to the default for %j', (value) => {
        const warn = jest.fn();
        expect(resolveAccountImportBodyLimit(value, warn)).toBe(25 * MB);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(MAX_ACCOUNT_IMPORT_BODY_LIMIT_BYTES).toBe(50 * MB);
    });
});

describe('the import routes get the larger limit, for a signed-in caller only', () => {
    /** `main.ts`'s order: the import parser first, then the tight global parser. */
    function app(signedIn: (req: IncomingMessage) => Promise<boolean>) {
        const server = express();
        mountAccountImportBodyParser(server, signedIn, resolveAccountImportBodyLimit(undefined));
        server.use(express.json({ limit: '1mb' }));
        server.all(/.*/, (req, res) => {
            res.json({
                items: Array.isArray(req.body?.items) ? req.body.items.length : -1,
                rawBody: (req as { rawBody?: unknown }).rawBody !== undefined,
            });
        });
        return server;
    }
    const signedIn = async () => true;
    const anonymous = async () => false;

    /** A JSON body of roughly `mb` megabytes. */
    const body = (mb: number) => ({
        items: Array.from({ length: Math.round(mb * 1024) }, () => 'x'.repeat(1000)),
    });

    it.each(ACCOUNT_IMPORT_PATHS)(
        '%s accepts a 3 MB export from a signed-in caller, keeping no raw copy',
        async (path) => {
            const res = await request(app(signedIn)).post(path).send(body(3));
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ items: 3 * 1024, rawBody: false });
        },
    );

    it.each(ACCOUNT_IMPORT_PATHS)(
        '%s gives an anonymous caller only the global 1 MB parser',
        async (path) => {
            const res = await request(app(anonymous)).post(path).send(body(3));
            expect(res.status).toBe(413);
        },
    );

    it('a credential check that throws counts as anonymous', async () => {
        const res = await request(app(() => Promise.reject(new Error('db down'))))
            .post(ACCOUNT_IMPORT_PATHS[0]!)
            .send(body(3));
        expect(res.status).toBe(413);
    });

    it('a small body from an anonymous caller still parses (the guard answers it)', async () => {
        const res = await request(app(anonymous)).post(ACCOUNT_IMPORT_PATHS[1]!).send(body(0.1));
        expect(res.status).toBe(200);
        expect(res.body.items).toBe(102);
    });

    it('another route refuses the same body even for a signed-in caller', async () => {
        const res = await request(app(signedIn)).post('/api/telemetry/funnel').send(body(3));
        expect(res.status).toBe(413);
    });

    it('the import routes still refuse a body over their limit', async () => {
        const res = await request(app(signedIn)).post(ACCOUNT_IMPORT_PATHS[0]!).send(body(26));
        expect(res.status).toBe(413);
    });

    it('checks no credential for a request that is not a POST', async () => {
        const check = jest.fn(signedIn);
        await request(app(check)).get(ACCOUNT_IMPORT_PATHS[0]!);
        expect(check).not.toHaveBeenCalled();
    });
});

describe('accountImportCallerCheck: the credentials AuthSessionGuard accepts here', () => {
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
    function check(session: unknown, key: unknown) {
        const authenticate = jest.fn(async () => session);
        const validate = jest.fn(async () => key);
        return {
            authenticate,
            validate,
            run: accountImportCallerCheck({
                authenticateSession: () => authenticate,
                validatePersonalKey: () => validate,
            }),
        };
    }

    it('a session that verifies is signed in; one that does not is not', async () => {
        const ok = check({ userId: 'u1' }, null);
        await expect(ok.run(req({ authorization: 'Bearer session-token' }))).resolves.toBe(true);
        expect(ok.authenticate).toHaveBeenCalledTimes(1);
        const ko = check(null, null);
        await expect(ko.run(req({ cookie: 'x=1' }))).resolves.toBe(false);
    });

    it('a personal API key is validated as a key, in either header', async () => {
        const ok = check(null, { userId: 'u1' });
        await expect(ok.run(req({ 'x-api-key': 'ew_live_abc' }))).resolves.toBe(true);
        await expect(ok.run(req({ authorization: 'Bearer ew_live_abc' }))).resolves.toBe(true);
        expect(ok.validate).toHaveBeenCalledWith('ew_live_abc');
        expect(ok.authenticate).not.toHaveBeenCalled();
        const revoked = check({ userId: 'u1' }, null);
        await expect(revoked.run(req({ 'x-api-key': 'ew_live_old' }))).resolves.toBe(false);
    });

    it.each(['ew_int_abc', 'ew_run_abc'])(
        'an integration or fleet-run key (%s) never gets the large parser',
        async (key) => {
            const c = check({ userId: 'u1' }, { userId: 'u1' });
            await expect(c.run(req({ authorization: `Bearer ${key}` }))).resolves.toBe(false);
            expect(c.validate).not.toHaveBeenCalled();
            expect(c.authenticate).not.toHaveBeenCalled();
        },
    );

    it('answers false when a dependency is missing or throws', async () => {
        const missing = accountImportCallerCheck({
            authenticateSession: () => undefined,
            validatePersonalKey: () => undefined,
        });
        await expect(missing(req({ authorization: 'Bearer s' }))).resolves.toBe(false);
        await expect(missing(req({ 'x-api-key': 'ew_live_k' }))).resolves.toBe(false);
        const throwing = accountImportCallerCheck({
            authenticateSession: () => async () => {
                throw new Error('provider down');
            },
            validatePersonalKey: () => undefined,
        });
        await expect(throwing(req({ authorization: 'Bearer s' }))).resolves.toBe(false);
    });
});

describe('main.ts wiring', () => {
    const source = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');

    it('mounts the auth-gated import parser BEFORE the global JSON parser', () => {
        const mount = source.indexOf('mountAccountImportBodyParser(');
        const globalJson = source.indexOf('app.use(json({ limit: bodyLimit');
        expect(mount).toBeGreaterThan(-1);
        expect(globalJson).toBeGreaterThan(-1);
        expect(mount).toBeLessThan(globalJson);
        expect(source).toContain('accountImportCallerCheck(');
    });

    it('mounts no other parser on the import paths (no ungated 25 MB parser, no raw copy)', () => {
        expect(source).not.toMatch(/app\.use\(\s*ACCOUNT_IMPORT_PATHS/);
        expect(source).not.toContain('resolveAccountImportBodyLimit(');
    });
});
