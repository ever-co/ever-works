import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { validateAppSpecDocument } from '../app-spec.validate';

/**
 * The Ever products' App Blueprint drafts (APW-13 golden paths), one folder each under
 * `docs/specs/features/app-works/APW-13-golden-paths/blueprints/ever-*`: the seed content of the
 * Blueprint repositories `ever-works/<id>-template`.
 *
 * Each must pass what the Blueprint resolver checks before it lists a repository
 * (`app-blueprint-resolver.service.ts`): `.works/works.yml` validates in `blueprint` mode with no
 * error, its root `kind` is `app`, and `spec.blueprint.repo` names the repository. And what this
 * catalog asks of its own drafts: every image is pinned by digest (a tag can move), no secret
 * holds a literal value, and `.works/template.yml` names the same upstream as the spec.
 */
const BLUEPRINTS = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'docs',
    'specs',
    'features',
    'app-works',
    'APW-13-golden-paths',
    'blueprints',
);

const PRODUCT_BLUEPRINTS = readdirSync(BLUEPRINTS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('ever-'))
    .map((entry) => entry.name)
    .sort();

const read = (id: string, file: string): string =>
    readFileSync(join(BLUEPRINTS, id, '.works', file), 'utf8');

describe("the Ever products' App Blueprint drafts", () => {
    it('includes Ever Gauzy, Ever Rec, Ever Teams and Ever Traduora', () => {
        expect(PRODUCT_BLUEPRINTS).toEqual(
            expect.arrayContaining(['ever-gauzy', 'ever-rec', 'ever-teams', 'ever-traduora']),
        );
    });

    describe('ever-rec', () => {
        const spec = validateAppSpecDocument(read('ever-rec', 'works.yml'), {
            mode: 'blueprint',
        }).spec;
        const env = (name: string) => (spec?.env ?? []).find((entry) => entry.name === name);

        it("runs the API image and never the portal image that has Ever's own addresses compiled in", () => {
            expect(spec?.build?.image).toMatch(/^ghcr\.io\/ever-co\/ever-rec-api@sha256:/);
            for (const component of spec?.components ?? []) {
                expect(component.image ?? '').not.toContain('ever-rec-portal');
            }
        });

        it("asks for the person's own Firebase project, keeping the private key and API key secret", () => {
            for (const name of [
                'FIREBASE_PROJECT_ID',
                'FIREBASE_ADMIN_CLIENT_EMAIL',
                'FIREBASE_ADMIN_PRIVATE_KEY',
                'FIREBASE_API_KEY',
                'FIREBASE_AUTH_DOMAIN',
                'FIREBASE_DATABASE_URL',
                'FIREBASE_STORAGE_BUCKET',
                'FIREBASE_MESSAGING_SENDER_ID',
                'FIREBASE_APP_ID',
            ]) {
                expect({ name, required: env(name)?.prompt?.required }).toEqual({
                    name,
                    required: true,
                });
            }
            expect(env('FIREBASE_ADMIN_PRIVATE_KEY')?.secret).toBe(true);
            expect(env('FIREBASE_API_KEY')?.secret).toBe(true);
        });

        it('generates its secrets, keeps statistics off and never points sign-ups at another product', () => {
            expect(env('REC_JWT_SECRET')?.generate).toBeDefined();
            expect(env('TERMS_IP_SALT')?.generate).toBeDefined();
            expect(env('EVER_STATS_ENABLED')?.value).toBe('false');
            expect(env('EVER_CONNECT_ENABLED')?.value).toBe('false');
            expect(env('GAUZY_API_URL')).toBeUndefined();
            // A read-only root, with the scratch folders as volumes that are never backed up.
            const api = (spec?.components ?? []).find((component) => component.name === 'api');
            expect(api?.writableRootFilesystem).toBe(false);
            expect(api?.volumes?.every((volume) => volume.backup === false)).toBe(true);
        });
    });

    describe('ever-gauzy', () => {
        const spec = validateAppSpecDocument(read('ever-gauzy', 'works.yml'), {
            mode: 'blueprint',
        }).spec;
        const env = (name: string) => (spec?.env ?? []).find((entry) => entry.name === name);
        const component = (name: string) =>
            (spec?.components ?? []).find((entry) => entry.name === name);

        it('runs the API and the web app on their own images, the web app as the public address', () => {
            expect(spec?.build?.image).toMatch(/^ghcr\.io\/ever-co\/gauzy-api@sha256:/);
            expect(component('api')?.image).toBeUndefined(); // build.image
            expect(component('web')?.image).toMatch(/^ghcr\.io\/ever-co\/gauzy-webapp@sha256:/);
            expect(spec?.domains?.primaryComponent).toBe('web');
            expect(spec?.dependencies?.postgres).toBeDefined();
        });

        it("forwards the upstream Caddyfile's API paths to the api component, and nothing else", () => {
            expect(env('GAUZY_API_INTERNAL_URL')?.from).toBe('components.api.internalUrl');
            const conf = env('GAUZY_WEB_NGINX_CONF')?.value ?? '';
            const location = /location ~ (\S+) \{\s*proxy_pass \$\{GAUZY_API_INTERNAL_URL\};/.exec(conf);
            expect(location).not.toBeNull();
            const api = new RegExp(location?.[1] ?? '$^');
            for (const path of [
                '/api',
                '/api/health/live',
                '/graphql',
                '/public/avatars/a.png',
                '/swg',
                '/swg/index.html',
                '/swg-json',
                '/swg-yaml',
            ]) {
                expect({ path, api: api.test(path) }).toEqual({ path, api: true });
            }
            for (const path of ['/', '/index.html', '/main-ABCD1234.js', '/assets/i18n/en.json', '/apiary']) {
                expect({ path, api: api.test(path) }).toEqual({ path, api: false });
            }
            // The web component substitutes only that one variable into the configuration.
            expect(component('web')?.args?.join(' ')).toContain("envsubst '${GAUZY_API_INTERNAL_URL}'");
        });

        it('one public address for the API and the web app, which a domain change restarts', () => {
            for (const name of ['API_BASE_URL', 'CLIENT_BASE_URL', 'ALLOWED_ORIGINS']) {
                expect(env(name)?.from).toBe('domains.primary.url');
                expect(spec?.domains?.publicUrlEnv).toContain(name);
            }
            expect(spec?.domains?.onChange).toBe('restart');
        });

        it('generates the four secrets the API refuses to start without', () => {
            for (const name of [
                'JWT_SECRET',
                'JWT_REFRESH_TOKEN_SECRET',
                'JWT_VERIFICATION_TOKEN_SECRET',
                'EXPRESS_SESSION_SECRET',
            ]) {
                expect(env(name)?.secret).toBe(true);
                expect(env(name)?.generate?.kind).toBe('hex');
            }
        });

        it("asks the Super Admin's sign-in, and never seeds a published default password", () => {
            expect(env('DEMO_SUPER_ADMIN_EMAIL')?.prompt).toBeDefined();
            expect(env('DEMO_SUPER_ADMIN_PASSWORD')?.secret).toBe(true);
            expect(env('DEMO_SUPER_ADMIN_PASSWORD')?.prompt).toBeDefined();
            expect(env('DEMO_SUPER_ADMIN_PASSWORD')?.validate).toEqual({ minLength: 12, maxLength: 50 });
            for (const name of ['DEMO_ADMIN_PASSWORD', 'DEMO_EMPLOYEE_PASSWORD']) {
                expect(env(name)?.generate).toBeDefined();
            }
        });
    });

    describe('ever-teams', () => {
        const spec = validateAppSpecDocument(read('ever-teams', 'works.yml'), {
            mode: 'blueprint',
        }).spec;
        const env = (name: string) => (spec?.env ?? []).find((entry) => entry.name === name);

        it('asks for the Gauzy API and keeps the browser on its own /api routes (proxy mode)', () => {
            const api = env('GAUZY_API_SERVER_URL');
            expect(api?.prompt?.description).toBeTruthy();
            expect(api?.prompt?.required).toBe(true);
            // Set, it would send the browser straight to the Gauzy API instead of this App's routes.
            expect(env('NEXT_PUBLIC_GAUZY_API_SERVER_URL')).toBeUndefined();
        });

        it('takes the Gauzy API as an origin only, since the app appends /api itself', () => {
            const pattern = new RegExp(env('GAUZY_API_SERVER_URL')?.validate?.pattern ?? '$^');
            expect(pattern.test('https://gauzy.example.com')).toBe(true);
            expect(pattern.test('http://gauzy.internal:3000')).toBe(true);
            expect(pattern.test('https://gauzy.example.com/')).toBe(false);
            expect(pattern.test('https://gauzy.example.com/api')).toBe(false);
            expect(pattern.test('gauzy.example.com')).toBe(false);
        });
    });

    describe.each(PRODUCT_BLUEPRINTS)('%s', (id) => {
        const text = read(id, 'works.yml');
        const result = validateAppSpecDocument(text, { mode: 'blueprint' });
        const spec = result.spec;

        it('validates with zero errors in blueprint mode, as the resolver requires', () => {
            expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
            expect(result.errorCount).toBe(0);
            expect(spec).not.toBeNull();
        });

        it('is an app whose blueprint block names this folder and its repository', () => {
            const document = parse(text) as { kind?: string };
            expect(document.kind).toBe('app');
            expect(spec?.blueprint?.id).toBe(id);
            expect(spec?.blueprint?.repo).toBe(`ever-works/${id}-template`);
        });

        it('pins every image by digest', () => {
            expect(spec?.build?.strategy).toBe('image');
            expect(spec?.build?.image).toMatch(/@sha256:[0-9a-f]{64}$/);
            for (const component of spec?.components ?? []) {
                if (component.image === undefined) continue;
                expect(component.image).toMatch(/@sha256:[0-9a-f]{64}$/);
            }
        });

        it('never holds a secret as a literal value', () => {
            const secrets = (spec?.env ?? []).filter((entry) => entry.secret === true);
            expect(secrets.length).toBeGreaterThan(0);
            for (const entry of secrets) {
                expect(entry.value).toBeUndefined();
            }
        });

        it('names the same upstream in .works/template.yml', () => {
            const template = parse(read(id, 'template.yml')) as {
                kind?: string;
                shape?: string;
                source?: { repo?: string };
            };
            expect(template.kind).toBe('app');
            expect(template.shape).toBe('metadata-only');
            expect(template.source?.repo).toBe(spec?.source?.upstream?.repo);
        });
    });
});
