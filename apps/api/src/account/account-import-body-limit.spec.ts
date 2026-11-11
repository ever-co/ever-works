// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express') as typeof import('express');
import * as request from 'supertest';
import {
    ACCOUNT_IMPORT_PATHS,
    DEFAULT_ACCOUNT_IMPORT_BODY_LIMIT_BYTES,
    MAX_ACCOUNT_IMPORT_BODY_LIMIT_BYTES,
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

describe('the import routes get the larger limit; every other route keeps the global one', () => {
    /** The parser wiring `main.ts` uses: import paths first, then the tight global parser. */
    function app() {
        const server = express();
        server.use(
            ACCOUNT_IMPORT_PATHS,
            express.json({ limit: resolveAccountImportBodyLimit(undefined) }),
        );
        server.use(express.json({ limit: '1mb' }));
        server.post(/.*/, (req, res) => {
            res.json({ items: Array.isArray(req.body?.items) ? req.body.items.length : -1 });
        });
        return server;
    }

    /** A JSON body of roughly `mb` megabytes. */
    const body = (mb: number) => ({
        items: Array.from({ length: mb * 1024 }, () => 'x'.repeat(1000)),
    });

    it.each(ACCOUNT_IMPORT_PATHS)(
        '%s accepts a 3 MB export (it answered 413 above 1 MB)',
        async (path) => {
            const res = await request(app()).post(path).send(body(3));
            expect(res.status).toBe(200);
            expect(res.body.items).toBe(3 * 1024);
        },
    );

    it('another route still refuses the same body', async () => {
        const res = await request(app()).post('/api/telemetry/funnel').send(body(3));
        expect(res.status).toBe(413);
    });

    it('the import routes still refuse a body over their limit', async () => {
        const res = await request(app()).post(ACCOUNT_IMPORT_PATHS[0]!).send(body(26));
        expect(res.status).toBe(413);
    });
});
