import {
    DEMO_PIPELINE_ID,
    DEMO_WORK_PROVIDERS,
    DemoFeatureDisabledError,
    assertDemoRepositoryName,
    assertDemoWorkCapacity,
    demoModelChoices,
    demoPipelineId,
    demoWebsiteRepositoryName,
    isDemoOfferedPipeline,
    isDemoSandboxUser,
    needsDemoRepositoryAtGeneration,
} from '..';

/**
 * Platform demo mode — what a demo Work may be: Ever Works Git storage with a
 * `demo-` repository, no deploy, at most `DEMO_MAX_WORKS_PER_SANDBOX` repositories,
 * the standard pipeline only and free models only. Every rule is inert with the
 * demo off.
 */
describe('demo Work policy', () => {
    const ORIGINAL_ENV = { ...process.env };

    beforeEach(() => {
        process.env.DEMO = 'true';
        delete process.env.DEMO_REPO_PREFIX;
        delete process.env.DEMO_MAX_WORKS_PER_SANDBOX;
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    describe('isDemoSandboxUser', () => {
        it('is true for a demo sandbox while the demo is on', () => {
            expect(isDemoSandboxUser({ registrationProvider: 'demo' })).toBe(true);
        });

        it('is false for any other account', () => {
            expect(isDemoSandboxUser({ registrationProvider: 'anonymous' })).toBe(false);
            expect(isDemoSandboxUser({ registrationProvider: 'local' })).toBe(false);
            expect(isDemoSandboxUser(null)).toBe(false);
            expect(isDemoSandboxUser(undefined)).toBe(false);
        });

        it('is false with the demo off, even for a demo account', () => {
            delete process.env.DEMO;
            expect(isDemoSandboxUser({ registrationProvider: 'demo' })).toBe(false);
        });
    });

    it('gives a demo Work Ever Works Git storage and no deploy provider', () => {
        expect(DEMO_WORK_PROVIDERS).toEqual({
            storageProvider: 'ever-works-git',
            deployProvider: null,
        });
    });

    describe('assertDemoWorkCapacity', () => {
        it('allows a Work while the sandbox has fewer repository-backed Works than the cap', () => {
            expect(() => assertDemoWorkCapacity(2)).not.toThrow();
        });

        it('refuses the 4th repository-backed Work with DEMO_DISABLED', () => {
            let caught: unknown;
            try {
                assertDemoWorkCapacity(3);
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(DemoFeatureDisabledError);
            expect((caught as DemoFeatureDisabledError).feature).toBe(
                'more than 3 generated Works',
            );
            expect((caught as DemoFeatureDisabledError).code).toBe('DEMO_DISABLED');
            expect((caught as DemoFeatureDisabledError).httpStatus).toBe(403);
        });

        it('follows DEMO_MAX_WORKS_PER_SANDBOX', () => {
            process.env.DEMO_MAX_WORKS_PER_SANDBOX = '5';
            expect(() => assertDemoWorkCapacity(4)).not.toThrow();
            expect(() => assertDemoWorkCapacity(5)).toThrow('more than 5 generated Works');
        });
    });

    describe('assertDemoRepositoryName', () => {
        it('refuses a name without the demo prefix', () => {
            expect(() => assertDemoRepositoryName('anon-x-foo')).toThrow(DemoFeatureDisabledError);
            expect(() => assertDemoRepositoryName('anon-x-foo')).toThrow(
                'Not available in the demo: repository name',
            );
        });

        it('accepts a name with the demo prefix', () => {
            expect(() => assertDemoRepositoryName('demo-1a2b3c4d-foo')).not.toThrow();
        });

        it('follows DEMO_REPO_PREFIX', () => {
            process.env.DEMO_REPO_PREFIX = 'ewdemo-';
            expect(() => assertDemoRepositoryName('demo-1a2b3c4d-foo')).toThrow(
                DemoFeatureDisabledError,
            );
            expect(() => assertDemoRepositoryName('ewdemo-1a2b3c4d-foo')).not.toThrow();
        });

        it('accepts any name with the demo off', () => {
            delete process.env.DEMO;
            expect(() => assertDemoRepositoryName('anon-x-foo')).not.toThrow();
        });
    });

    describe('needsDemoRepositoryAtGeneration', () => {
        it('is true for an Ever Works Git Work with no repository yet (the seeded draft)', () => {
            expect(needsDemoRepositoryAtGeneration({ storageProvider: 'ever-works-git' })).toBe(
                true,
            );
        });

        it('is false once the Work has its repository', () => {
            expect(
                needsDemoRepositoryAtGeneration({
                    storageProvider: 'ever-works-git',
                    sourceRepository: { url: 'u', owner: 'o', repo: 'r', type: 'data_repo' },
                }),
            ).toBe(false);
        });

        it('is false for any other storage', () => {
            expect(needsDemoRepositoryAtGeneration({ storageProvider: 'user-github' })).toBe(false);
        });

        it('is false with the demo off', () => {
            delete process.env.DEMO;
            expect(needsDemoRepositoryAtGeneration({ storageProvider: 'ever-works-git' })).toBe(
                false,
            );
        });
    });

    describe('demoWebsiteRepositoryName', () => {
        it('puts the website next to the Work repository, so it keeps the demo prefix', () => {
            expect(demoWebsiteRepositoryName('demo-1a2b3c4d-tools')).toBe(
                'demo-1a2b3c4d-tools-website',
            );
        });

        it('stays within GitHub’s 100-character limit', () => {
            const long = `demo-1a2b3c4d-${'x'.repeat(86)}`;
            expect(long).toHaveLength(100);
            const name = demoWebsiteRepositoryName(long);
            expect(name.length).toBeLessThanOrEqual(100);
            expect(name.startsWith('demo-1a2b3c4d-')).toBe(true);
            expect(name.endsWith('-website')).toBe(true);
        });
    });

    describe('pipelines', () => {
        it('runs the standard pipeline whatever was requested', () => {
            expect(DEMO_PIPELINE_ID).toBe('standard-pipeline');
            expect(demoPipelineId('agent-pipeline')).toBe('standard-pipeline');
            expect(demoPipelineId(undefined)).toBe('standard-pipeline');
        });

        it('offers only the standard pipeline', () => {
            expect(isDemoOfferedPipeline('standard-pipeline')).toBe(true);
            expect(isDemoOfferedPipeline('agent-pipeline')).toBe(false);
            expect(isDemoOfferedPipeline('claude-code')).toBe(false);
        });

        it('changes nothing with the demo off', () => {
            delete process.env.DEMO;
            expect(demoPipelineId('agent-pipeline')).toBe('agent-pipeline');
            expect(demoPipelineId(undefined)).toBeUndefined();
            expect(isDemoOfferedPipeline('agent-pipeline')).toBe(true);
        });
    });

    describe('demoModelChoices', () => {
        const models = [
            { id: 'google/gemma-4-31b-it:free', name: 'Gemma (free)' },
            { id: 'openai/gpt-6.1-sol', name: 'GPT' },
            { name: 'no id' },
            { id: 'inclusionai/ling-3.2-flash:free' },
        ];

        it('keeps only :free models', () => {
            expect(demoModelChoices(models)).toEqual([
                { id: 'google/gemma-4-31b-it:free', name: 'Gemma (free)' },
                { id: 'inclusionai/ling-3.2-flash:free' },
            ]);
        });

        it('returns the list unchanged with the demo off', () => {
            delete process.env.DEMO;
            expect(demoModelChoices(models)).toBe(models);
        });
    });
});
