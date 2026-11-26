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
 * catalog asks of its own drafts: the image is pinned by digest (a tag can move), no secret holds
 * a literal value, and `.works/template.yml` names the same upstream as the spec.
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
    it('includes Ever Traduora and Ever Teams', () => {
        expect(PRODUCT_BLUEPRINTS).toEqual(expect.arrayContaining(['ever-teams', 'ever-traduora']));
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

        it('pins its image by digest', () => {
            expect(spec?.build?.strategy).toBe('image');
            expect(spec?.build?.image).toMatch(/@sha256:[0-9a-f]{64}$/);
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
