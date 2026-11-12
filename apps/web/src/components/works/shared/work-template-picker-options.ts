import type { WebsiteTemplateOption } from '@/lib/api/work';
import type { WorkBlueprintEntry } from '@/lib/api/work-templates';

/**
 * Option building for the Create-Work template picker (`WorkTemplatePicker`),
 * kept free of React so the rules below are unit tested on their own.
 *
 * The value of every option is what the form submits as
 * `CreateWorkDto.websiteTemplateId`, and `POST /api/works` accepts only the id
 * of a Website Template catalog row the user can see
 * (`WorkLifecycleService.resolveValidatedWebsiteTemplateSelection`). A manifest
 * blueprint slug such as `directory` is NOT such an id: submitting it answered
 * `400 Unsupported website template: directory`, so picking the featured
 * Directory blueprint could never create a Work. A blueprint is therefore
 * offered only when it resolves to a catalog row, and it submits that row's id:
 *
 *   1. its slug IS a catalog id (the built-in fallback blueprints `classic` /
 *      `minimal`): the catalog row wins and the blueprint is not listed again,
 *      exactly as before;
 *   2. otherwise the catalog row built from the blueprint's `template.repo`
 *      (`ever-works/directory-web-template` is the built-in `classic` row):
 *      the blueprint is listed with that row's id as its value, and the row
 *      itself leaves "Your templates" on that chip so one template is not
 *      listed twice under two names;
 *   3. no such row (a blueprint whose repository the platform has no template
 *      for yet): not listed, since submitting it can only fail.
 *
 * The default (badge + the highlight when nothing is picked) is the template
 * the API builds the Work with when the form submits none: the catalog row
 * whose `defaultForWorkKinds` names the Work's kind. A website / landing-page /
 * blog Work with no saved default builds with `web`, not the `isDefault` row
 * (`classic`), so highlighting `isDefault` showed one template and built
 * another. Only when the API names no such row (an older API, or a row not
 * listed) do the `isDefault` flags stand.
 */

export interface PickerOption {
    /** websiteTemplateId — always the id of a Website Template catalog row. */
    value: string;
    name: string;
    description: string;
    group: 'yours' | 'blueprints';
    iconName?: string;
    chipType?: string;
    featured: boolean;
    isDefault: boolean;
    tags?: string[];
    category?: string;
}

export interface TemplatePickerOptions {
    /** "Your templates": the catalog rows, minus those a listed blueprint stands for. */
    customOptions: PickerOption[];
    /** "Blueprints" for the chip, featured first, each valued with its catalog row id. */
    blueprintOptions: PickerOption[];
}

/** `owner/name`, lowercased (GitHub owner and repository names are case-insensitive). */
function repositoryKey(owner?: string | null, name?: string | null): string | null {
    const normalizedOwner = owner?.trim().toLowerCase();
    const normalizedName = name?.trim().toLowerCase();
    return normalizedOwner && normalizedName ? `${normalizedOwner}/${normalizedName}` : null;
}

/**
 * The catalog row id per repository. A built-in row wins over a custom one
 * built from the same repository, so a blueprint lands on the platform's own
 * template rather than on whichever custom row happens to be listed first.
 */
function indexCatalogByRepository(customTemplates: WebsiteTemplateOption[]): Map<string, string> {
    const byRepository = new Map<string, string>();
    const builtInFirst = [...customTemplates].sort(
        (a, b) => Number(b.sourceType === 'built_in') - Number(a.sourceType === 'built_in'),
    );
    for (const template of builtInFirst) {
        const key = repositoryKey(template.repositoryOwner, template.repositoryName);
        if (key && !byRepository.has(key)) {
            byRepository.set(key, template.id);
        }
    }
    return byRepository;
}

export function buildTemplatePickerOptions({
    customTemplates,
    blueprints,
    selectedChip,
    currentChipType,
    workKind,
}: {
    customTemplates: WebsiteTemplateOption[];
    blueprints: WorkBlueprintEntry[];
    /** The chip the user is looking at; blueprints are filtered by it. */
    selectedChip: string;
    /** The chip of the Work kind being created; custom rows are tagged with it. */
    currentChipType: string;
    /** The Work kind being created; none is stored as the column default `default`. */
    workKind?: string;
}): TemplatePickerOptions {
    const catalogIds = new Set(customTemplates.map((template) => template.id));
    const catalogIdByRepository = indexCatalogByRepository(customTemplates);
    // The row the API builds this kind of Work with when none is picked.
    const kindKey = workKind || 'default';
    const kindDefaultId = customTemplates.find((template) =>
        template.defaultForWorkKinds?.includes(kindKey),
    )?.id;
    const isDefaultOption = (value: string, flag: boolean) =>
        kindDefaultId ? value === kindDefaultId : flag;

    const blueprintOptions: PickerOption[] = [];
    const representedCatalogIds = new Set<string>();
    for (const blueprint of blueprints) {
        if (blueprint.chipType !== selectedChip || blueprint.status === 'placeholder') {
            continue;
        }
        // Rule 1: the catalog row of the same id is already listed.
        if (catalogIds.has(blueprint.slug)) {
            continue;
        }
        // Rules 2 and 3.
        const repository = repositoryKey(blueprint.templateRepoOwner, blueprint.templateRepoName);
        const catalogId = repository ? catalogIdByRepository.get(repository) : undefined;
        if (!catalogId || representedCatalogIds.has(catalogId)) {
            continue;
        }
        representedCatalogIds.add(catalogId);
        blueprintOptions.push({
            value: catalogId,
            name: blueprint.name,
            description: blueprint.description,
            group: 'blueprints',
            iconName: blueprint.iconName,
            chipType: blueprint.chipType,
            featured: blueprint.featured,
            isDefault: isDefaultOption(catalogId, blueprint.isDefault),
            tags: blueprint.tags,
            category: blueprint.category,
        });
    }
    // Featured pinned to the top within the blueprint group (stable sort).
    blueprintOptions.sort((a, b) => Number(b.featured) - Number(a.featured));

    const customOptions = customTemplates
        .filter((template) => !representedCatalogIds.has(template.id))
        .map<PickerOption>((template) => ({
            value: template.id,
            name: template.name,
            description: template.description,
            group: 'yours',
            featured: false,
            isDefault: isDefaultOption(template.id, template.isDefault),
            chipType: currentChipType,
        }));

    return { customOptions, blueprintOptions };
}
