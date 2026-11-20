// Mock the agent runtime tree at module scope so importing the controller does
// not pull in the agent's NestJS DI graph.
jest.mock('@ever-works/agent/dto', () => ({
    // The controller's `quickCreateWork` does `new CreateWorkDto()` and
    // assigns fields onto it via `Object.assign`. A bare-class stub is
    // enough — class-validator decorators aren't exercised in unit tests.
    CreateWorkDto: class CreateWorkDto {},
}));
jest.mock('@ever-works/agent/items-generator', () => ({
    CreateItemsGeneratorDto: class CreateItemsGeneratorDto {
        name?: string;
        prompt?: string;
        model?: string;
    },
}));
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/comparison-generator', () => ({}));
jest.mock('@ever-works/agent/template-catalog', () => ({}));
jest.mock('@ever-works/agent/generators', () => ({
    getDefaultWebsiteTemplateId: jest.fn(() => 'default-template'),
}));
jest.mock('@ever-works/agent/community-pr', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/cache', () => ({ CACHE_MANAGER: 'CACHE_MANAGER' }));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: {
        WORK_CREATED: 'WORK_CREATED',
        GENERATION: 'GENERATION',
    },
    ActivityStatus: { COMPLETED: 'COMPLETED', IN_PROGRESS: 'IN_PROGRESS' },
}));
jest.mock('@ever-works/agent/subscriptions', () => ({}));
jest.mock('@ever-works/agent/activity-log', () => ({}));
jest.mock('../auth', () => ({
    AuthService: class {},
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException } from '@nestjs/common';
import { WorksController } from './works.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

const auth: AuthenticatedUser = { userId: 'auth-1' } as any;

/**
 * The Generate form's schema for a fresh Work in the shape production answers
 * when a platform key is missing: Tavily is the default search provider but not
 * configured (its key is empty), the rest are set up.
 */
const FORM_SCHEMA_WITH_UNCONFIGURED_SEARCH = {
    resolvedPipelineId: 'agent-pipeline',
    providers: {
        pipeline: [
            { id: 'agent-pipeline', name: 'Agent Pipeline', configured: true, isDefault: true },
            { id: 'standard-pipeline', name: 'Standard Pipeline', configured: true },
        ],
        search: [{ id: 'tavily', name: 'Tavily', configured: false, isDefault: true }],
        screenshot: [],
        ai: [{ id: 'openrouter', name: 'OpenRouter', configured: true, isDefault: true }],
        contentExtractor: [
            {
                id: 'local-content-extractor',
                name: 'Local Content Extractor',
                configured: true,
                isDefault: true,
            },
        ],
    },
    pluginFields: [],
    handledConfigFields: [],
    defaultValues: { max_search_queries: 5 },
};

function makeController(overrides: {
    createWorkResult?: unknown;
    generateResult?: unknown;
    generateThrows?: Error;
    formSchema?: unknown;
    formSchemaThrows?: Error;
    retryTarget?: unknown;
    requiredProvidersThrows?: Error;
}) {
    const createWork = jest.fn().mockResolvedValue(
        overrides.createWorkResult ?? {
            status: 'success',
            work: { id: 'w-1', slug: 'my-slug', name: 'My Slug' },
        },
    );
    const generateItems = overrides.generateThrows
        ? jest.fn().mockRejectedValue(overrides.generateThrows)
        : jest.fn().mockResolvedValue(
              overrides.generateResult ?? {
                  status: 'pending',
                  historyId: 'gen-1',
                  message: 'Generation started',
              },
          );

    const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
    const authService = { getUser: jest.fn().mockResolvedValue({ id: 'user-1' }) };
    const getFormSchema = overrides.formSchemaThrows
        ? jest.fn().mockRejectedValue(overrides.formSchemaThrows)
        : jest.fn().mockResolvedValue(
              overrides.formSchema ?? {
                  providers: {
                      pipeline: [],
                      search: [],
                      screenshot: [],
                      ai: [],
                      contentExtractor: [],
                  },
                  pluginFields: [],
                  handledConfigFields: [],
              },
          );
    const findLatestByUserAndCorrelationId = jest
        .fn()
        .mockResolvedValue(overrides.retryTarget ?? null);
    const validateRequiredProvidersForPipeline = overrides.requiredProvidersThrows
        ? jest.fn().mockRejectedValue(overrides.requiredProvidersThrows)
        : jest.fn().mockResolvedValue(undefined);
    const funnel = { emit: jest.fn() };

    const controller = new WorksController(
        { wrap: jest.fn() } as any,
        { typeormAdapter: { deleteUnscopedEntriesLike: jest.fn() } } as any,
        {} as any,
        { createWork } as any,
        { generateItems, updateItemsGenerator: jest.fn(), cancelGeneration: jest.fn() } as any,
        authService as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        { getFormSchema, validateRequiredProvidersForPipeline } as any,
        {} as any,
        {} as any,
        {} as any,
        { findLatestByUserAndCorrelationId } as any,
        {} as any,
        {} as any,
        activityLog as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        { rotate: jest.fn(), getOrGenerate: jest.fn() } as any,
        {
            isEnabled: jest.fn().mockReturnValue(false),
            verify: jest.fn().mockResolvedValue({ success: true, skipped: true }),
        } as any,
        funnel as any,
    );

    return {
        controller,
        createWork,
        generateItems,
        activityLog,
        authService,
        getFormSchema,
        findLatestByUserAndCorrelationId,
        validateRequiredProvidersForPipeline,
        funnel,
    };
}

const baseDto = {
    slug: 'ai-coding-assistants',
    name: 'AI Coding Assistants',
    description: 'A curated directory of AI coding assistants',
    prompt: 'AI coding assistants directory with reviews and pricing',
    organization: false,
};

describe('WorksController.quickCreateWork (EW-617 G4)', () => {
    it('creates the work then kicks off generation and returns the combined response', async () => {
        const { controller, createWork, generateItems, activityLog } = makeController({});

        const result = await (controller as any).quickCreateWork(auth, baseDto);

        expect(createWork).toHaveBeenCalledTimes(1);
        const createDtoArg = createWork.mock.calls[0][0];
        expect(createDtoArg).toMatchObject({
            slug: 'ai-coding-assistants',
            name: 'AI Coding Assistants',
            description: 'A curated directory of AI coding assistants',
            organization: false,
            gitProvider: 'github',
        });
        // Prompt is NOT passed to createWork — it belongs in the generator DTO.
        expect(createDtoArg.prompt).toBeUndefined();

        expect(generateItems).toHaveBeenCalledTimes(1);
        const [workId, generatorDto, , awaitCompletion] = generateItems.mock.calls[0];
        expect(workId).toBe('w-1');
        expect(generatorDto.prompt).toBe(baseDto.prompt);
        expect(generatorDto.name).toBe(baseDto.name);
        expect(awaitCompletion).toBe(false);

        expect(result).toEqual({
            status: 'pending',
            work: { id: 'w-1', slug: 'my-slug', name: 'My Slug' },
            generation: { historyId: 'gen-1', message: 'Generation started' },
        });

        expect(activityLog.log).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-1',
                workId: 'w-1',
                action: 'work.quick_create',
            }),
        );
    });

    it('passes through provider overrides when supplied', async () => {
        const { controller, createWork } = makeController({});

        await (controller as any).quickCreateWork(auth, {
            ...baseDto,
            deployProvider: 'k8s',
            storageProvider: 'ever-works-git',
            gitProvider: 'gitlab',
            websiteTemplateId: 'modern',
            model: 'claude-3-haiku',
        });

        expect(createWork).toHaveBeenCalledTimes(1);
        const createDtoArg = createWork.mock.calls[0][0];
        expect(createDtoArg.deployProvider).toBe('k8s');
        expect(createDtoArg.storageProvider).toBe('ever-works-git');
        expect(createDtoArg.gitProvider).toBe('gitlab');
        expect(createDtoArg.websiteTemplateId).toBe('modern');
    });

    it('forwards the work-kind choice into createWork', async () => {
        const { controller, createWork } = makeController({});

        await (controller as any).quickCreateWork(auth, { ...baseDto, kind: 'landing-page' });

        expect(createWork.mock.calls[0][0].kind).toBe('landing-page');
    });

    it('forwards model to the generator DTO but never to createWork', async () => {
        const { controller, createWork, generateItems } = makeController({});

        await (controller as any).quickCreateWork(auth, { ...baseDto, model: 'gpt-4o-mini' });

        const generatorDto = generateItems.mock.calls[0][1];
        expect(generatorDto.model).toBe('gpt-4o-mini');
        expect(createWork.mock.calls[0][0].model).toBeUndefined();
    });

    it('throws BadRequestException when createWork returns a non-success status', async () => {
        const { controller } = makeController({
            createWorkResult: { status: 'error', work: null },
        });

        await expect((controller as any).quickCreateWork(auth, baseDto)).rejects.toThrow(
            BadRequestException,
        );
    });

    it('bubbles up generation errors after creating the work (caller polls or retries)', async () => {
        const { controller, createWork } = makeController({
            generateThrows: new Error('queue full'),
        });

        await expect((controller as any).quickCreateWork(auth, baseDto)).rejects.toThrow(
            'queue full',
        );
        // The work was created — caller can retry just the generation step
        // via POST /works/:id/generate.
        expect(createWork).toHaveBeenCalledTimes(1);
    });

    it('defaults organization to false when omitted', async () => {
        const { controller, createWork } = makeController({});

        const dto: any = { ...baseDto };
        delete dto.organization;
        await (controller as any).quickCreateWork(auth, dto);

        expect(createWork.mock.calls[0][0].organization).toBe(false);
    });
});

describe('WorksController.quickCreateWork — providers, the same selection as the Generate form', () => {
    // Without `providers`, `GeneratorFormSchemaService.validateSelectedProviders`
    // demands that the default provider of EVERY category be configured, so an
    // empty optional key (production's `PLUGIN_TAVILY_API_KEY`) refused every
    // quick-create with "Default provider \"Tavily\" is not configured" — after
    // the Work and its repository were created. The Generate form and the chat
    // tool send `buildSelectedProviders(formSchema)` (pipeline included), which
    // validates the pipeline only. Quick-create must send the same.
    it('sends the default pipeline and each category default, as the Generate form does', async () => {
        const { controller, generateItems, getFormSchema } = makeController({
            formSchema: FORM_SCHEMA_WITH_UNCONFIGURED_SEARCH,
        });

        await (controller as any).quickCreateWork(auth, baseDto);

        expect(getFormSchema).toHaveBeenCalledWith(undefined, { workId: 'w-1', userId: 'user-1' });
        const generatorDto = generateItems.mock.calls[0][1];
        expect(generatorDto.providers).toEqual({
            pipeline: 'agent-pipeline',
            search: 'tavily',
            ai: 'openrouter',
            contentExtractor: 'local-content-extractor',
        });
        expect(generatorDto.pluginConfig).toEqual({ max_search_queries: 5 });
        expect(generatorDto.prompt).toBe(baseDto.prompt);
    });

    it("selects the user's enforced default pipeline, as the Generate form does", async () => {
        const { controller, generateItems } = makeController({
            formSchema: {
                ...FORM_SCHEMA_WITH_UNCONFIGURED_SEARCH,
                enforcedPipelineId: 'standard-pipeline',
            },
        });

        await (controller as any).quickCreateWork(auth, baseDto);

        expect(generateItems.mock.calls[0][1].providers.pipeline).toBe('standard-pipeline');
    });

    it('still starts the generation when the form schema cannot be read', async () => {
        const { controller, generateItems } = makeController({
            formSchemaThrows: new Error('plugin registry not ready'),
        });

        const result = await (controller as any).quickCreateWork(auth, baseDto);

        expect(generateItems).toHaveBeenCalledTimes(1);
        expect(generateItems.mock.calls[0][1].providers).toBeUndefined();
        expect(result.status).toBe('pending');
    });
});

describe('WorksController.quickCreateWork — a retry reuses the Work instead of creating another', () => {
    // Every "Generate now" click minted a new slug, so each retry after a
    // refused start created another Work AND another managed repository; after
    // three a visitor hit the 3-Works Ever Works Deploy quota and was stuck.
    const retryDto = { ...baseDto, slug: 'ai-coding-assistants-x7k2p9', correlationId: 'corr-1' };

    it('reuses the Work the same funnel created when its generation never started', async () => {
        const firstTry = {
            id: 'w-0',
            slug: 'ai-coding-assistants-a1b2c3',
            name: 'AI Coding Assistants',
        };
        const {
            controller,
            createWork,
            generateItems,
            getFormSchema,
            findLatestByUserAndCorrelationId,
            funnel,
        } = makeController({
            retryTarget: { ...firstTry, userId: 'user-1', generateStatus: null },
        });

        const result = await (controller as any).quickCreateWork(auth, retryDto);

        expect(findLatestByUserAndCorrelationId).toHaveBeenCalledWith('user-1', 'corr-1');
        expect(createWork).not.toHaveBeenCalled();
        expect(generateItems.mock.calls[0][0]).toBe('w-0');
        expect(getFormSchema).toHaveBeenCalledWith(undefined, { workId: 'w-0', userId: 'user-1' });
        expect(result.work).toEqual(firstTry);
        // No second "work created" funnel step for a Work that already existed.
        expect(funnel.emit).not.toHaveBeenCalled();
    });

    it.each(['error', 'cancelled'])(
        'reuses the Work when its earlier generation ended %s (a retry runs it again on the same Work)',
        async (status) => {
            const { controller, createWork, generateItems } = makeController({
                retryTarget: {
                    id: 'w-0',
                    slug: 'ai-coding-assistants-a1b2c3',
                    name: 'AI Coding Assistants',
                    userId: 'user-1',
                    generateStatus: { status },
                },
            });

            await (controller as any).quickCreateWork(auth, retryDto);

            expect(createWork).not.toHaveBeenCalled();
            expect(generateItems.mock.calls[0][0]).toBe('w-0');
        },
    );

    it.each(['generating', 'generated'])(
        'creates a new Work when the earlier one is %s',
        async (status) => {
            const { controller, createWork, generateItems } = makeController({
                retryTarget: {
                    id: 'w-0',
                    slug: 'ai-coding-assistants-a1b2c3',
                    name: 'AI Coding Assistants',
                    userId: 'user-1',
                    generateStatus: { status },
                },
            });

            await (controller as any).quickCreateWork(auth, retryDto);

            expect(createWork).toHaveBeenCalledTimes(1);
            expect(generateItems.mock.calls[0][0]).toBe('w-1');
        },
    );

    it('a fresh create still persists the correlationId and emits the work-created funnel step', async () => {
        const { controller, createWork, funnel } = makeController({});

        await (controller as any).quickCreateWork(auth, retryDto);

        expect(createWork.mock.calls[0][0].correlationId).toBe('corr-1');
        expect(funnel.emit).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'zero_friction.work_created',
                funnelStep: 4,
                correlationId: 'corr-1',
                workId: 'w-1',
                viaQuickCreate: true,
            }),
        );
    });

    it('does not look for an earlier Work without a correlationId', async () => {
        const { controller, createWork, findLatestByUserAndCorrelationId } = makeController({});

        await (controller as any).quickCreateWork(auth, baseDto);

        expect(findLatestByUserAndCorrelationId).not.toHaveBeenCalled();
        expect(createWork).toHaveBeenCalledTimes(1);
    });
});

describe("WorksController.quickCreateWork — the pipeline's required providers are checked before anything is created", () => {
    // #3252 dropped the upfront refusal for an install with no usable AI/search keys: the run
    // started and failed later without saying what was missing. The gate is back, on the
    // providers the selected pipeline REQUIRES (`validateRequiredProvidersForPipeline`, the rule
    // works-config imports already apply), at USER scope and BEFORE the Work or its managed
    // repository exists. Platform-level keys count (see the agent spec
    // `generator-form-schema.required-providers-platform-keys.spec.ts`).
    const refusal = () =>
        new BadRequestException({
            message: 'One or more required providers for the selected pipeline are not available.',
            providerErrors: {
                ai: 'Provider "openrouter" is not configured. Visit Settings → Plugins to set it up.',
                search: 'Provider "tavily" is not configured. Visit Settings → Plugins to set it up.',
            },
            resolvedPipelineId: 'agent-pipeline',
        });

    it('checks the form selection at user scope before creating the Work', async () => {
        const { controller, getFormSchema, validateRequiredProvidersForPipeline, createWork } =
            makeController({
                formSchema: FORM_SCHEMA_WITH_UNCONFIGURED_SEARCH,
            });

        await (controller as any).quickCreateWork(auth, { ...baseDto, correlationId: 'corr-1' });

        expect(getFormSchema).toHaveBeenCalledWith(undefined, { userId: 'user-1' });
        expect(validateRequiredProvidersForPipeline).toHaveBeenCalledWith(
            'agent-pipeline',
            {
                pipeline: 'agent-pipeline',
                search: 'tavily',
                ai: 'openrouter',
                contentExtractor: 'local-content-extractor',
            },
            { userId: 'user-1' },
        );
        expect(validateRequiredProvidersForPipeline.mock.invocationCallOrder[0]).toBeLessThan(
            createWork.mock.invocationCallOrder[0],
        );
    });

    it("a refusal creates nothing and answers with the Generate form's provider envelope", async () => {
        const {
            controller,
            createWork,
            generateItems,
            activityLog,
            funnel,
            findLatestByUserAndCorrelationId,
        } = makeController({
            formSchema: FORM_SCHEMA_WITH_UNCONFIGURED_SEARCH,
            requiredProvidersThrows: refusal(),
        });

        const call = (controller as any).quickCreateWork(auth, {
            ...baseDto,
            correlationId: 'corr-1',
        });

        await expect(call).rejects.toBeInstanceOf(BadRequestException);
        await expect(call).rejects.toMatchObject({
            response: {
                message: 'One or more selected providers are not available.',
                providerErrors: {
                    ai: expect.stringContaining('openrouter'),
                    search: expect.stringContaining('tavily'),
                },
            },
        });
        expect(createWork).not.toHaveBeenCalled();
        expect(findLatestByUserAndCorrelationId).not.toHaveBeenCalled();
        expect(generateItems).not.toHaveBeenCalled();
        expect(activityLog.log).not.toHaveBeenCalled();
        expect(funnel.emit).not.toHaveBeenCalled();
    });

    it('starts as before when the required providers are configured', async () => {
        const { controller, createWork, generateItems } = makeController({
            formSchema: FORM_SCHEMA_WITH_UNCONFIGURED_SEARCH,
        });

        const result = await (controller as any).quickCreateWork(auth, baseDto);

        expect(createWork).toHaveBeenCalledTimes(1);
        expect(generateItems).toHaveBeenCalledTimes(1);
        expect(result.status).toBe('pending');
    });
});
