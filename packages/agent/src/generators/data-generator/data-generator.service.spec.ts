import { Test, TestingModule } from '@nestjs/testing';
import { GitFacadeService } from '../../facades/git.facade';
import { Work } from '../../entities/work.entity';
import { User } from '../../entities/user.entity';
import { GenerationMethod } from '../../items-generator/dto';
import { PipelineOrchestratorService } from '../../pipeline';
import { WorkOperationsService } from '../../work-operations';
import { CategoryIconService } from '../../services/category-icon';
import { WorksConfigWriterService } from '../../works-config/services/works-config-writer.service';
import { DataGeneratorService, isRepositoryNotFoundError } from './data-generator.service';
import { DataRepository, RuntimeYamlCompatibilityError } from './data-repository';

describe('DataGeneratorService runtime YAML certification', () => {
    let service: DataGeneratorService;
    let gitFacade: { cloneOrPull: jest.Mock; repositoryExists: jest.Mock };
    let pipelineOrchestrator: { execute: jest.Mock; resumeOrExecute: jest.Mock };

    const owner = { id: 'owner-1' } as User;
    const user = { id: 'user-1' } as User;
    const work = {
        id: 'work-1',
        name: 'Runtime YAML Test',
        slug: 'runtime-yaml-test',
        user: owner,
        gitProvider: 'github',
        getDataRepo: () => 'runtime-yaml-test-data',
        getRepoOwner: () => 'ever-works',
        resolveCommitter: () => ({ name: 'Test User', email: 'test@example.com' }),
    } as unknown as Work;

    beforeEach(async () => {
        gitFacade = {
            cloneOrPull: jest.fn().mockResolvedValue('C:/tmp/runtime-yaml-test-data'),
            repositoryExists: jest.fn().mockResolvedValue(true),
        };
        pipelineOrchestrator = {
            execute: jest.fn(),
            resumeOrExecute: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                DataGeneratorService,
                { provide: GitFacadeService, useValue: gitFacade },
                { provide: PipelineOrchestratorService, useValue: pipelineOrchestrator },
                { provide: WorkOperationsService, useValue: {} },
                { provide: WorksConfigWriterService, useValue: {} },
                { provide: CategoryIconService, useValue: {} },
            ],
        }).compile();

        service = module.get(DataGeneratorService);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('stops update generation before the pipeline when the existing corpus is runtime-incompatible', async () => {
        const compatibilityError = new RuntimeYamlCompatibilityError(
            'data/broken/broken.yml',
            'Map keys must be unique',
        );
        const assertRuntimeCompatible = jest.fn().mockRejectedValue(compatibilityError);
        jest.spyOn(DataRepository, 'create').mockResolvedValue({
            assertRuntimeCompatible,
            getCategories: jest.fn().mockResolvedValue([]),
            getTags: jest.fn().mockResolvedValue([]),
            getCollections: jest.fn().mockResolvedValue([]),
            getReferences: jest.fn().mockResolvedValue([]),
            getItems: jest.fn().mockResolvedValue([]),
            getConfig: jest.fn().mockResolvedValue(null),
        } as unknown as DataRepository);

        await expect(
            service.initialize(work, user, {
                name: work.name,
                prompt: 'Update the directory',
                generation_method: GenerationMethod.CREATE_UPDATE,
            } as any),
        ).resolves.toMatchObject({
            success: false,
            error: {
                code: 'DATA_REPO_FAILED',
                cause: compatibilityError,
            },
        });

        expect(assertRuntimeCompatible).toHaveBeenCalledTimes(1);
        expect(pipelineOrchestrator.execute).not.toHaveBeenCalled();
        expect(pipelineOrchestrator.resumeOrExecute).not.toHaveBeenCalled();
    });

    it('fails closed before the pipeline when strict preflight cannot clone the corpus', async () => {
        gitFacade.cloneOrPull.mockRejectedValue(
            Object.assign(new Error('permission denied while cloning'), { code: 'EACCES' }),
        );

        await expect(
            service.initialize(work, user, {
                name: work.name,
                prompt: 'Update the directory',
                generation_method: GenerationMethod.CREATE_UPDATE,
            } as any),
        ).resolves.toMatchObject({
            success: false,
            error: { code: 'DATA_REPO_FAILED' },
        });

        expect(pipelineOrchestrator.execute).not.toHaveBeenCalled();
        expect(pipelineOrchestrator.resumeOrExecute).not.toHaveBeenCalled();
    });

    describe('first create-update generation of a new Work (data repository not created yet)', () => {
        // What isomorphic-git throws when cloning a GitHub repository that does not exist.
        const clone404 = () =>
            Object.assign(new Error('HTTP Error: 404 Not Found'), {
                code: 'HttpError',
                data: { statusCode: 404, statusMessage: 'Not Found' },
            });
        const createUpdate = {
            name: work.name,
            prompt: 'A directory of AI coding tools',
            generation_method: GenerationMethod.CREATE_UPDATE,
        } as any;

        it('treats a data repository that does not exist as "no existing data" and runs the pipeline', async () => {
            gitFacade.cloneOrPull.mockRejectedValue(clone404());
            gitFacade.repositoryExists.mockResolvedValue(false);
            const create = jest.spyOn(DataRepository, 'create');
            pipelineOrchestrator.execute.mockResolvedValue(undefined);

            const result = await service.initialize(work, user, createUpdate);

            expect(result).not.toMatchObject({ error: { code: 'DATA_REPO_FAILED' } });
            expect(gitFacade.repositoryExists).toHaveBeenCalledWith(
                'ever-works',
                'runtime-yaml-test-data',
                { userId: 'owner-1', providerId: 'github', workId: 'work-1' },
            );
            expect(create).not.toHaveBeenCalled();
            expect(pipelineOrchestrator.execute).toHaveBeenCalledTimes(1);
        });

        it('also recognises a 404 wrapped in a cause', async () => {
            gitFacade.cloneOrPull.mockRejectedValue(
                Object.assign(new Error('Failed to clone repository'), { cause: clone404() }),
            );
            gitFacade.repositoryExists.mockResolvedValue(false);
            pipelineOrchestrator.execute.mockResolvedValue(undefined);

            await service.initialize(work, user, createUpdate);

            expect(pipelineOrchestrator.execute).toHaveBeenCalledTimes(1);
        });

        it('still fails closed when the repository EXISTS but its corpus is runtime-incompatible', async () => {
            const compatibilityError = new RuntimeYamlCompatibilityError(
                'data/broken/broken.yml',
                'Map keys must be unique',
            );
            jest.spyOn(DataRepository, 'create').mockResolvedValue({
                assertRuntimeCompatible: jest.fn().mockRejectedValue(compatibilityError),
                getCategories: jest.fn().mockResolvedValue([]),
                getTags: jest.fn().mockResolvedValue([]),
                getCollections: jest.fn().mockResolvedValue([]),
                getReferences: jest.fn().mockResolvedValue([]),
                getItems: jest.fn().mockResolvedValue([]),
                getConfig: jest.fn().mockResolvedValue(null),
            } as unknown as DataRepository);

            await expect(service.initialize(work, user, createUpdate)).resolves.toMatchObject({
                success: false,
                error: { code: 'DATA_REPO_FAILED', cause: compatibilityError },
            });
            expect(gitFacade.repositoryExists).not.toHaveBeenCalled();
            expect(pipelineOrchestrator.execute).not.toHaveBeenCalled();
        });

        it('fails closed when the clone 404s but the provider says the repository exists', async () => {
            gitFacade.cloneOrPull.mockRejectedValue(clone404());
            gitFacade.repositoryExists.mockResolvedValue(true);

            await expect(service.initialize(work, user, createUpdate)).resolves.toMatchObject({
                success: false,
                error: { code: 'DATA_REPO_FAILED' },
            });
            expect(pipelineOrchestrator.execute).not.toHaveBeenCalled();
        });

        it('fails closed when the existence check itself fails', async () => {
            gitFacade.cloneOrPull.mockRejectedValue(clone404());
            gitFacade.repositoryExists.mockRejectedValue(new Error('GitHub API rate limited'));

            await expect(service.initialize(work, user, createUpdate)).resolves.toMatchObject({
                success: false,
                error: { code: 'DATA_REPO_FAILED' },
            });
            expect(pipelineOrchestrator.execute).not.toHaveBeenCalled();
        });

        it('does not ask about existence for errors that are not a missing repository', async () => {
            gitFacade.cloneOrPull.mockRejectedValue(
                Object.assign(new Error('HTTP Error: 401 Unauthorized'), {
                    code: 'HttpError',
                    data: { statusCode: 401 },
                }),
            );

            await expect(service.initialize(work, user, createUpdate)).resolves.toMatchObject({
                success: false,
                error: { code: 'DATA_REPO_FAILED' },
            });
            expect(gitFacade.repositoryExists).not.toHaveBeenCalled();
        });
    });

    describe('isRepositoryNotFoundError', () => {
        it.each([
            [
                'isomorphic-git HttpError 404',
                Object.assign(new Error('x'), { code: 'HttpError', data: { statusCode: 404 } }),
            ],
            ['the 404 message', new Error('HTTP Error: 404 Not Found')],
            [
                'RepositoryNotReadyError',
                Object.assign(new Error('x'), { code: 'repository_not_ready' }),
            ],
            [
                'a wrapped 404',
                Object.assign(new Error('outer'), {
                    cause: new Error('HTTP Error: 404 Not Found'),
                }),
            ],
        ])('matches %s', (_label, error) => {
            expect(isRepositoryNotFoundError(error)).toBe(true);
        });

        it.each([
            [
                '401',
                Object.assign(new Error('HTTP Error: 401 Unauthorized'), {
                    code: 'HttpError',
                    data: { statusCode: 401 },
                }),
            ],
            ['403', new Error('HTTP Error: 403 Forbidden')],
            ['a network error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
            ['a non-error', 'nope'],
        ])('does not match %s', (_label, error) => {
            expect(isRepositoryNotFoundError(error)).toBe(false);
        });
    });

    it('keeps ordinary item reads tolerant by skipping generation certification', async () => {
        const assertRuntimeCompatible = jest.fn();
        const items = [{ slug: 'legacy-item', name: 'Legacy Item' }];
        jest.spyOn(DataRepository, 'create').mockResolvedValue({
            assertRuntimeCompatible,
            getCategories: jest.fn().mockResolvedValue([]),
            getTags: jest.fn().mockResolvedValue([]),
            getCollections: jest.fn().mockResolvedValue([]),
            getReferences: jest.fn().mockResolvedValue([]),
            getItems: jest.fn().mockResolvedValue(items),
            getConfig: jest.fn().mockResolvedValue(null),
        } as unknown as DataRepository);

        await expect(service.getItems(work, user)).resolves.toEqual(items);
        expect(assertRuntimeCompatible).not.toHaveBeenCalled();
    });

    it('never clones a derived data repository for a Work with no repository (EW-P2-4 Project Work)', async () => {
        const projectWork = { ...work, kind: 'project' } as unknown as Work;
        // A tolerant read answers empty; a direct repository read is refused.
        await expect(service.getItems(projectWork, user)).resolves.toEqual([]);
        await expect(service.getConfig(projectWork, user)).rejects.toMatchObject({ status: 400 });
        await expect(service.getCategoriesTags(projectWork, user)).rejects.toMatchObject({
            status: 400,
        });
        expect(gitFacade.cloneOrPull).not.toHaveBeenCalled();
    });

    it('allows recreate generation to replace a malformed legacy corpus', async () => {
        const compatibilityError = new RuntimeYamlCompatibilityError(
            'data/broken/broken.yml',
            'Map keys must be unique',
        );
        const assertRuntimeCompatible = jest.fn().mockRejectedValue(compatibilityError);
        jest.spyOn(DataRepository, 'create').mockResolvedValue({
            assertRuntimeCompatible,
            getCategories: jest.fn().mockResolvedValue([]),
            getTags: jest.fn().mockResolvedValue([]),
            getCollections: jest.fn().mockResolvedValue([]),
            getReferences: jest.fn().mockResolvedValue([]),
            getItems: jest.fn().mockResolvedValue([]),
            getConfig: jest.fn().mockResolvedValue(null),
        } as unknown as DataRepository);
        pipelineOrchestrator.execute.mockResolvedValue(undefined);

        await expect(
            service.initialize(work, user, {
                name: work.name,
                prompt: 'Replace the directory',
                generation_method: GenerationMethod.RECREATE,
            } as any),
        ).resolves.toMatchObject({
            success: false,
            error: { code: 'GENERATION_FAILED' },
        });

        expect(assertRuntimeCompatible).not.toHaveBeenCalled();
        expect(pipelineOrchestrator.execute).toHaveBeenCalledTimes(1);
    });

    it("reports a failed pipeline by its error's own message, without the error name in front", async () => {
        // The agent pipeline fails with the provider's refusal (an `AI_APICallError`). The Work must
        // read "Insufficient credits. Add more using …", not "AI_APICallError: Insufficient credits…",
        // which the generation orchestrator would then repeat once more from the cause.
        const refusal = Object.assign(
            new Error(
                'Insufficient credits. Add more using https://openrouter.ai/settings/credits',
            ),
            { name: 'AI_APICallError' },
        );
        jest.spyOn(DataRepository, 'create').mockResolvedValue({
            assertRuntimeCompatible: jest.fn(),
            getCategories: jest.fn().mockResolvedValue([]),
            getTags: jest.fn().mockResolvedValue([]),
            getCollections: jest.fn().mockResolvedValue([]),
            getReferences: jest.fn().mockResolvedValue([]),
            getItems: jest.fn().mockResolvedValue([]),
            getConfig: jest.fn().mockResolvedValue(null),
        } as unknown as DataRepository);
        pipelineOrchestrator.execute.mockResolvedValue({
            success: false,
            error: refusal,
            outputs: { items: [] },
            warnings: [],
        });

        await expect(
            service.initialize(work, user, {
                name: work.name,
                prompt: 'A directory of AI robot companies',
                generation_method: GenerationMethod.RECREATE,
            } as any),
        ).resolves.toMatchObject({
            success: false,
            error: {
                code: 'GENERATION_FAILED',
                message:
                    'Insufficient credits. Add more using https://openrouter.ai/settings/credits',
                cause: refusal,
            },
        });
    });

    it('names an Error that has no message by its error name', async () => {
        jest.spyOn(DataRepository, 'create').mockResolvedValue({
            assertRuntimeCompatible: jest.fn(),
            getCategories: jest.fn().mockResolvedValue([]),
            getTags: jest.fn().mockResolvedValue([]),
            getCollections: jest.fn().mockResolvedValue([]),
            getReferences: jest.fn().mockResolvedValue([]),
            getItems: jest.fn().mockResolvedValue([]),
            getConfig: jest.fn().mockResolvedValue(null),
        } as unknown as DataRepository);
        pipelineOrchestrator.execute.mockResolvedValue({
            success: false,
            error: Object.assign(new Error(''), { name: 'AI_RetryError' }),
            outputs: { items: [] },
            warnings: [],
        });

        await expect(
            service.initialize(work, user, {
                name: work.name,
                prompt: 'A directory of AI robot companies',
                generation_method: GenerationMethod.RECREATE,
            } as any),
        ).resolves.toMatchObject({
            success: false,
            error: { code: 'GENERATION_FAILED', message: 'AI_RetryError' },
        });
    });

    it('keeps a string pipeline error as it is', async () => {
        jest.spyOn(DataRepository, 'create').mockResolvedValue({
            assertRuntimeCompatible: jest.fn(),
            getCategories: jest.fn().mockResolvedValue([]),
            getTags: jest.fn().mockResolvedValue([]),
            getCollections: jest.fn().mockResolvedValue([]),
            getReferences: jest.fn().mockResolvedValue([]),
            getItems: jest.fn().mockResolvedValue([]),
            getConfig: jest.fn().mockResolvedValue(null),
        } as unknown as DataRepository);
        pipelineOrchestrator.execute.mockResolvedValue({
            success: false,
            error: 'Pipeline cancelled',
            outputs: { items: [] },
            warnings: [],
        });

        await expect(
            service.initialize(work, user, {
                name: work.name,
                prompt: 'A directory of AI robot companies',
                generation_method: GenerationMethod.RECREATE,
            } as any),
        ).resolves.toMatchObject({
            success: false,
            error: { code: 'GENERATION_FAILED', message: 'Pipeline cancelled' },
        });
    });

    it('stops imported-data updates before reading or writing an incompatible corpus', async () => {
        const compatibilityError = new RuntimeYamlCompatibilityError(
            'data/broken/broken.yml',
            'Implicit keys need to be on a single line',
        );
        const assertRuntimeCompatible = jest.fn().mockRejectedValue(compatibilityError);
        const getItems = jest.fn();
        jest.spyOn(DataRepository, 'create').mockResolvedValue({
            assertRuntimeCompatible,
            getItems,
            ensureWorksExist: jest.fn(),
            ensureDefaultConfig: jest.fn(),
        } as unknown as DataRepository);

        await expect(
            service.updateWithImportedData(work, user, {
                items: [],
                categories: [],
                tags: [],
            }),
        ).resolves.toMatchObject({
            success: false,
            error: {
                code: 'DATA_REPO_FAILED',
                cause: compatibilityError,
            },
        });

        expect(assertRuntimeCompatible).toHaveBeenCalledTimes(1);
        expect(getItems).not.toHaveBeenCalled();
    });

    it('classifies imported-data certification I/O failures as data-repository failures', async () => {
        const certificationError = Object.assign(
            new Error('permission denied while reading YAML'),
            {
                code: 'EACCES',
            },
        );
        const assertRuntimeCompatible = jest.fn().mockRejectedValue(certificationError);
        const getItems = jest.fn();
        jest.spyOn(DataRepository, 'create').mockResolvedValue({
            assertRuntimeCompatible,
            getItems,
            ensureWorksExist: jest.fn(),
            ensureDefaultConfig: jest.fn(),
        } as unknown as DataRepository);

        await expect(
            service.updateWithImportedData(work, user, {
                items: [],
                categories: [],
                tags: [],
            }),
        ).resolves.toMatchObject({
            success: false,
            error: { code: 'DATA_REPO_FAILED' },
        });

        expect(assertRuntimeCompatible).toHaveBeenCalledTimes(1);
        expect(getItems).not.toHaveBeenCalled();
    });

    describe('refreshDataCache — kinds with no directory corpus (live e2e 2026-10-18)', () => {
        it.each(['app', 'repo', 'project'])(
            'answers null for a %s Work without cloning and without a WARN',
            async (kind) => {
                const create = jest.spyOn(DataRepository, 'create');
                const warn = jest.spyOn((service as any).logger, 'warn');

                await expect(
                    service.refreshDataCache({ ...work, kind } as unknown as Work, user),
                ).resolves.toBeNull();

                expect(create).not.toHaveBeenCalled();
                expect(gitFacade.cloneOrPull).not.toHaveBeenCalled();
                expect(warn).not.toHaveBeenCalled();
            },
        );

        it('still refreshes a directory Work (control)', async () => {
            const updateWork = jest.fn();
            (service as any).workOperations.updateWork = updateWork;
            jest.spyOn(DataRepository, 'create').mockResolvedValue({
                getConfig: jest.fn().mockResolvedValue({ company_name: 'Acme' }),
                getCategories: jest.fn().mockResolvedValue([{}, {}]),
                getTags: jest.fn().mockResolvedValue([]),
                countItems: jest.fn().mockResolvedValue(3),
                countComparisons: jest.fn().mockResolvedValue(0),
            } as unknown as DataRepository);

            await expect(
                service.refreshDataCache({ ...work, kind: 'directory' } as unknown as Work, user),
            ).resolves.toMatchObject({ categoriesCount: 2, itemsCount: 3 });
            expect(updateWork).toHaveBeenCalledTimes(1);
        });
    });
});
