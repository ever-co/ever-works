import { config } from '../config';
import { isFreeModelId } from './demo-ai-policy';
import { DemoFeatureDisabledError } from './demo-errors';

/**
 * Platform demo mode — what a demo Work may be (design §5.2.4 "Works",
 * "Pipelines", "Model choice surfaces"). Every rule is inert unless `DEMO` is on.
 *
 *   - Storage is Ever Works Git: a private repository in the shared customer org,
 *     named `DEMO_REPO_PREFIX` + the sandbox's username, so the sweeper can delete
 *     exactly it later. Its website repository sits next to it under the same prefix.
 *   - No deploy provider: the demo never deploys.
 *   - At most `DEMO_MAX_WORKS_PER_SANDBOX` Works with a repository per sandbox.
 *   - Generation runs `standard-pipeline` only: the other pipelines bring their own
 *     model client or CLI keys, around the facade's free-model rule and quota.
 *   - Model pickers offer `:free` models only.
 */

/** `registrationProvider` of a demo sandbox account (`POST /api/auth/demo`). */
export const DEMO_REGISTRATION_PROVIDER = 'demo';

/** The only pipeline a demo instance runs. */
export const DEMO_PIPELINE_ID = 'standard-pipeline';

/**
 * The storage and deploy provider a demo sandbox's new Work gets, whatever it asked
 * for. No deploy provider rather than `ever-works` / `vercel`: with
 * `DEPLOY_EVER_WORKS_ENABLED` off `ever-works` is stored as `vercel`, and a Work with
 * no provider has nothing to deploy to (the seeded draft is stored the same way).
 */
export const DEMO_WORK_PROVIDERS = {
    storageProvider: 'ever-works-git',
    deployProvider: null,
} as const;

/** GitHub refuses repository names longer than this. */
const REPO_NAME_MAX_LENGTH = 100;
const WEBSITE_SUFFIX = '-website';

/** True when the demo is on and `user` is a demo sandbox. */
export function isDemoSandboxUser(
    user: { registrationProvider?: string | null } | null | undefined,
): boolean {
    return config.demo.isEnabled() && user?.registrationProvider === DEMO_REGISTRATION_PROVIDER;
}

/**
 * Refuses another repository-backed Work once the sandbox already has
 * `DEMO_MAX_WORKS_PER_SANDBOX` of them (`DEMO_DISABLED`, 403).
 */
export function assertDemoWorkCapacity(repositoryBackedWorks: number): void {
    const cap = config.demo.maxWorksPerSandbox();
    if (repositoryBackedWorks >= cap) {
        throw new DemoFeatureDisabledError(`more than ${cap} generated Works`);
    }
}

/**
 * On a demo instance, refuses a repository name that does not start with
 * `DEMO_REPO_PREFIX` (`DEMO_DISABLED`, 403): the sweeper deletes only prefixed
 * repositories, so an unprefixed one would outlive its sandbox in the shared org.
 */
export function assertDemoRepositoryName(name: string): void {
    if (config.demo.isEnabled() && !name.startsWith(config.demo.repoPrefix())) {
        throw new DemoFeatureDisabledError('repository name');
    }
}

/**
 * True when Generate must first provision the Work's repository through Ever Works
 * Git: a demo instance, Ever Works Git storage and no repository yet — the draft
 * directory Work the sandbox seeder creates without one.
 */
export function needsDemoRepositoryAtGeneration(work: {
    storageProvider?: string | null;
    sourceRepository?: unknown;
}): boolean {
    return (
        config.demo.isEnabled() &&
        work.storageProvider === DEMO_WORK_PROVIDERS.storageProvider &&
        !work.sourceRepository
    );
}

/**
 * The website repository of a demo Work: `<repo>-website`, beside the Work's own
 * repository and so under the same prefix. The derived default (`<slug>-website`)
 * would be ONE repository for every sandbox, since they all seed the same slug.
 */
export function demoWebsiteRepositoryName(repo: string): string {
    const limit = REPO_NAME_MAX_LENGTH - WEBSITE_SUFFIX.length;
    const base = repo.length <= limit ? repo : repo.slice(0, limit).replace(/-+$/, '');
    return `${base}${WEBSITE_SUFFIX}`;
}

/**
 * The pipeline a generation runs: `standard-pipeline` on a demo instance, else
 * `requested`. Called with nothing, it answers the pipeline the demo locks
 * generation to, or `undefined` when nothing is locked (the demo off).
 */
export function demoPipelineId(requested?: string): string | undefined {
    return config.demo.isEnabled() ? DEMO_PIPELINE_ID : requested;
}

/** Whether a pipeline is offered: on a demo instance only `standard-pipeline`. */
export function isDemoOfferedPipeline(pluginId: string): boolean {
    return !config.demo.isEnabled() || pluginId === DEMO_PIPELINE_ID;
}

/** On a demo instance only the `:free` models of a model list; else the list itself. */
export function demoModelChoices<T>(models: readonly T[]): readonly T[] {
    if (!config.demo.isEnabled()) return models;
    return models.filter((model) => isFreeModelId((model as { id?: string } | null)?.id));
}
