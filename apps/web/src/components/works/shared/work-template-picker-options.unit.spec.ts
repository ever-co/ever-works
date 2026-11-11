import { describe, expect, it } from 'vitest';
import type { WebsiteTemplateOption } from '@/lib/api/work';
import { listBuiltinWorkBlueprints, type WorkBlueprintEntry } from '@/lib/api/work-templates';
import { buildTemplatePickerOptions } from './work-template-picker-options';

/** The built-in catalog rows `GET /api/works/website-templates` lists. */
const CATALOG: WebsiteTemplateOption[] = [
    {
        id: 'classic',
        name: 'Classic',
        description: 'The original Ever Works website template.',
        isDefault: true,
        sourceType: 'built_in',
        originType: 'standard',
        repositoryOwner: 'ever-works',
        repositoryName: 'directory-web-template',
    },
    {
        id: 'minimal',
        name: 'Minimal',
        description: 'A more minimalistic Ever Works work website template.',
        isDefault: false,
        sourceType: 'built_in',
        originType: 'standard',
        repositoryOwner: 'ever-works',
        repositoryName: 'directory-web-minimal-template',
    },
    {
        id: 'web',
        name: 'Website',
        description: 'A general-purpose website template.',
        isDefault: false,
        sourceType: 'built_in',
        originType: 'standard',
        repositoryOwner: 'ever-works',
        repositoryName: 'web-template',
    },
];

function blueprint(overrides: Partial<WorkBlueprintEntry> & { slug: string }): WorkBlueprintEntry {
    return {
        name: overrides.slug,
        title: overrides.slug,
        description: '',
        chipType: 'directory',
        kind: 'directory',
        isDefault: false,
        featured: false,
        status: 'production',
        templateRepoOwner: null,
        templateRepoName: null,
        templateRef: null,
        isOrganization: false,
        ...overrides,
    };
}

/** The `ever-works/works` manifest blueprints as production serves them on 2026-11-10. */
const MANIFEST: WorkBlueprintEntry[] = [
    blueprint({
        slug: 'directory',
        name: 'Directory',
        isDefault: true,
        featured: true,
        templateRepoOwner: 'ever-works',
        templateRepoName: 'directory-web-template',
    }),
    blueprint({
        slug: 'directory-minimal',
        name: 'Directory (Minimal)',
        templateRepoOwner: 'ever-works',
        templateRepoName: 'directory-web-minimal-template',
    }),
    blueprint({
        slug: 'marketing-site',
        name: 'Marketing Site',
        chipType: 'website',
        kind: 'website',
        isDefault: true,
        templateRepoOwner: 'ever-works',
        templateRepoName: 'ever-works-website-template',
    }),
    blueprint({ slug: 'store', chipType: 'store', kind: 'store', status: 'placeholder' }),
];

describe('buildTemplatePickerOptions', () => {
    it('submits the catalog id of the template a blueprint is built from, never the blueprint slug', () => {
        const { blueprintOptions } = buildTemplatePickerOptions({
            customTemplates: CATALOG,
            blueprints: MANIFEST,
            selectedChip: 'directory',
            currentChipType: 'directory',
        });

        // `directory` / `directory-minimal` are not catalog ids: POST /api/works
        // answered "400 Unsupported website template: directory" for them.
        expect(blueprintOptions.map((o) => [o.name, o.value])).toEqual([
            ['Directory', 'classic'],
            ['Directory (Minimal)', 'minimal'],
        ]);
        const catalogIds = new Set(CATALOG.map((t) => t.id));
        for (const option of blueprintOptions) {
            expect(catalogIds.has(option.value)).toBe(true);
        }
        expect(blueprintOptions[0]).toMatchObject({
            isDefault: true,
            featured: true,
            group: 'blueprints',
        });
    });

    it('lists a catalog row once: the blueprint that stands for it takes its place in "Your templates"', () => {
        const { customOptions, blueprintOptions } = buildTemplatePickerOptions({
            customTemplates: CATALOG,
            blueprints: MANIFEST,
            selectedChip: 'directory',
            currentChipType: 'directory',
        });

        expect(customOptions.map((o) => o.value)).toEqual(['web']);
        const values = [...customOptions, ...blueprintOptions].map((o) => o.value);
        expect(new Set(values).size).toBe(values.length);
    });

    it('keeps every catalog row on a chip whose blueprints stand for none of them', () => {
        const { customOptions } = buildTemplatePickerOptions({
            customTemplates: CATALOG,
            blueprints: MANIFEST,
            selectedChip: 'website',
            currentChipType: 'directory',
        });

        expect(customOptions.map((o) => o.value)).toEqual(['classic', 'minimal', 'web']);
        expect(customOptions.every((o) => o.chipType === 'directory')).toBe(true);
    });

    it('leaves out a blueprint whose repository has no catalog row, since creating from it can only fail', () => {
        const { blueprintOptions } = buildTemplatePickerOptions({
            customTemplates: CATALOG,
            blueprints: MANIFEST,
            selectedChip: 'website',
            currentChipType: 'website',
        });

        expect(blueprintOptions).toEqual([]);
    });

    it('leaves out placeholder blueprints', () => {
        const { blueprintOptions } = buildTemplatePickerOptions({
            customTemplates: CATALOG,
            blueprints: MANIFEST,
            selectedChip: 'store',
            currentChipType: 'store',
        });

        expect(blueprintOptions).toEqual([]);
    });

    it('offers no blueprint when the API sends no repository for its templates (an older API)', () => {
        const withoutRepositories = CATALOG.map(
            ({ repositoryOwner, repositoryName, ...rest }) => rest,
        );
        const { customOptions, blueprintOptions } = buildTemplatePickerOptions({
            customTemplates: withoutRepositories,
            blueprints: MANIFEST,
            selectedChip: 'directory',
            currentChipType: 'directory',
        });

        expect(blueprintOptions).toEqual([]);
        expect(customOptions.map((o) => o.value)).toEqual(['classic', 'minimal', 'web']);
    });

    it('matches repositories case-insensitively and prefers the built-in row over a custom one', () => {
        const customCopy: WebsiteTemplateOption = {
            id: 'my-copy',
            name: 'My copy',
            description: '',
            isDefault: false,
            sourceType: 'custom',
            originType: 'custom_url',
            repositoryOwner: 'Ever-Works',
            repositoryName: 'Directory-Web-Template',
        };
        const { customOptions, blueprintOptions } = buildTemplatePickerOptions({
            customTemplates: [customCopy, ...CATALOG],
            blueprints: [
                blueprint({
                    slug: 'directory',
                    templateRepoOwner: 'EVER-WORKS',
                    templateRepoName: 'directory-web-template',
                }),
            ],
            selectedChip: 'directory',
            currentChipType: 'directory',
        });

        expect(blueprintOptions.map((o) => o.value)).toEqual(['classic']);
        expect(customOptions.map((o) => o.value)).toEqual(['my-copy', 'minimal', 'web']);
    });

    it('lists one entry when two blueprints are built from the same repository', () => {
        const { blueprintOptions } = buildTemplatePickerOptions({
            customTemplates: CATALOG,
            blueprints: [
                ...MANIFEST,
                blueprint({
                    slug: 'directory-copy',
                    templateRepoOwner: 'ever-works',
                    templateRepoName: 'directory-web-template',
                }),
            ],
            selectedChip: 'directory',
            currentChipType: 'directory',
        });

        expect(blueprintOptions.map((o) => o.value)).toEqual(['classic', 'minimal']);
    });

    it('keeps the catalog row, not the blueprint, when a blueprint slug is itself a catalog id (built-in fallback)', () => {
        const { customOptions, blueprintOptions } = buildTemplatePickerOptions({
            customTemplates: CATALOG,
            blueprints: listBuiltinWorkBlueprints(),
            selectedChip: 'website',
            currentChipType: 'website',
        });

        expect(blueprintOptions).toEqual([]);
        expect(customOptions.map((o) => o.value)).toEqual(['classic', 'minimal', 'web']);
    });

    it('pins featured blueprints first', () => {
        const { blueprintOptions } = buildTemplatePickerOptions({
            customTemplates: CATALOG,
            blueprints: [
                blueprint({
                    slug: 'directory-minimal',
                    templateRepoOwner: 'ever-works',
                    templateRepoName: 'directory-web-minimal-template',
                }),
                blueprint({
                    slug: 'directory',
                    featured: true,
                    templateRepoOwner: 'ever-works',
                    templateRepoName: 'directory-web-template',
                }),
            ],
            selectedChip: 'directory',
            currentChipType: 'directory',
        });

        expect(blueprintOptions.map((o) => o.value)).toEqual(['classic', 'minimal']);
    });
});
