import { PipelineOrchestratorService } from '../pipeline-orchestrator.service';

/**
 * Platform demo mode — generation runs `standard-pipeline` only. The other
 * pipelines bring their own model client (`agent-pipeline`) or CLI keys
 * (claude-code, codex, …), which would step around the facade's free-model rule
 * and the demo AI quota. The lock sits where every generation entry point
 * (Generate, Update, import, schedule, resume) resolves its pipeline, in the API
 * process and in the Trigger workers alike.
 */
describe('PipelineOrchestratorService — demo pipeline lock', () => {
    const ORIGINAL_ENV = { ...process.env };

    function pipeline(id: string, stepOrchestratable: boolean): any {
        const plugin: any = { id, name: id, capabilities: ['pipeline'] };
        if (stepOrchestratable) {
            plugin.executeStep = jest.fn();
            plugin.registerStepExecutor = jest.fn();
        }
        return plugin;
    }

    function registered(plugin: any, manifest: Record<string, unknown> = {}) {
        return { plugin, state: 'loaded', manifest: { ...manifest } };
    }

    const standard = pipeline('standard-pipeline', true);
    const agent = pipeline('agent-pipeline', true);
    const claudeCode = pipeline('claude-code', false);

    let stepExecutor: any;
    let fullExecutor: any;
    let registry: any;
    let service: PipelineOrchestratorService;

    const work = { id: 'w1', user: { id: 'u1' } } as any;
    const existing = { items: [] } as any;

    beforeEach(() => {
        stepExecutor = {
            execute: jest.fn().mockResolvedValue({ success: true }),
            resumeFromCheckpoint: jest.fn().mockResolvedValue(null),
        };
        fullExecutor = { execute: jest.fn().mockResolvedValue({ success: true }) };
        const all = [
            // agent-pipeline first and marked default: the lock must not follow either.
            registered(agent, { defaultForCapabilities: ['pipeline'] }),
            registered(claudeCode),
            registered(standard),
        ];
        registry = {
            get: jest.fn((id: string) => all.find((r) => r.plugin.id === id)),
            getByCapability: jest.fn().mockReturnValue(all),
            isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
        };
        service = new PipelineOrchestratorService(stepExecutor, fullExecutor, registry);
        jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    describe('with the demo on', () => {
        beforeEach(() => {
            process.env.DEMO = 'true';
        });

        it('runs standard-pipeline when the Work’s settings name agent-pipeline', async () => {
            await service.execute(
                work,
                { providers: { pipeline: 'agent-pipeline' } } as any,
                existing,
            );

            expect(stepExecutor.execute).toHaveBeenCalledTimes(1);
            expect(stepExecutor.execute.mock.calls[0][0]).toBe(standard);
            expect(fullExecutor.execute).not.toHaveBeenCalled();
        });

        it('runs standard-pipeline when a CLI pipeline is requested', async () => {
            await service.execute(
                work,
                { providers: { pipeline: 'claude-code' } } as any,
                existing,
            );

            expect(stepExecutor.execute.mock.calls[0][0]).toBe(standard);
            expect(fullExecutor.execute).not.toHaveBeenCalled();
        });

        it('runs standard-pipeline when nothing is requested, over the default pipeline', async () => {
            await service.execute(work, { providers: {} } as any, existing);

            expect(stepExecutor.execute.mock.calls[0][0]).toBe(standard);
        });

        it('resumes on standard-pipeline too', async () => {
            await service.resumeOrExecute(
                work,
                { providers: { pipeline: 'agent-pipeline' } } as any,
                existing,
            );

            expect(stepExecutor.resumeFromCheckpoint.mock.calls[0][0]).toBe(standard);
            expect(stepExecutor.execute.mock.calls[0][0]).toBe(standard);
        });

        it('does not run a self-managed pipeline in forced full mode', async () => {
            await service.executeWithMode('full', work, { providers: {} } as any, existing);

            expect(fullExecutor.execute).not.toHaveBeenCalled();
            expect(stepExecutor.execute.mock.calls[0][0]).toBe(standard);
        });

        it('fails rather than fall back to another pipeline when standard-pipeline is unusable', async () => {
            registry.isPluginEnabledForScope.mockImplementation(
                async (id: string) => id !== 'standard-pipeline',
            );

            await expect(
                service.execute(
                    work,
                    { providers: { pipeline: 'agent-pipeline' } } as any,
                    existing,
                ),
            ).rejects.toThrow(/standard-pipeline/);
            expect(stepExecutor.execute).not.toHaveBeenCalled();
            expect(fullExecutor.execute).not.toHaveBeenCalled();
        });
    });

    describe('with the demo off', () => {
        beforeEach(() => {
            delete process.env.DEMO;
        });

        it('runs the requested pipeline', async () => {
            await service.execute(
                work,
                { providers: { pipeline: 'agent-pipeline' } } as any,
                existing,
            );

            expect(stepExecutor.execute.mock.calls[0][0]).toBe(agent);
        });

        it('runs the default pipeline when nothing is requested', async () => {
            await service.execute(work, { providers: {} } as any, existing);

            expect(stepExecutor.execute.mock.calls[0][0]).toBe(agent);
        });
    });
});
