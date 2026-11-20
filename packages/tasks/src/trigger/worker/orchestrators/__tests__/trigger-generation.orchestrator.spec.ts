import { describe, expect, it, vi } from 'vitest';
import { GenerateStatusType } from '@ever-works/agent/entities';
import type { DataGeneratorService } from '@ever-works/agent/generators';
import type {
    MarkdownGeneratorService,
    WebsiteGeneratorService,
} from '@ever-works/agent/generators';
import type { WorkOperationsService } from '@ever-works/agent/work-operations';
import { TriggerGenerationOrchestrator } from '../trigger-generation.orchestrator';

/**
 * A generation the AI provider refuses (OpenRouter's 402 on an account with no credits) must leave
 * the provider's own words on the Work: `generateStatus.error` and the history's `errorMessage` read
 * "Insufficient credits. Add more using …", once, and not "AI_NoOutputGeneratedError: No output
 * generated…" or the provider text repeated behind its error name.
 *
 * The data-generator result below is the shape `DataGeneratorService.initialize` returns for a
 * failed pipeline (see its spec): `message` is the error's own message, `cause` the error itself.
 */

const CREDITS_MESSAGE =
    'Insufficient credits. Add more using https://openrouter.ai/settings/credits';

function providerRefusal(): Error {
    return Object.assign(new Error(CREDITS_MESSAGE), { name: 'AI_APICallError', statusCode: 402 });
}

function build(generated: unknown) {
    const workOperations = {
        getGenerateStatus: vi.fn().mockResolvedValue({ status: GenerateStatusType.GENERATING }),
        recordGenerationStartTime: vi.fn().mockResolvedValue(undefined),
        recordGenerationFinishTime: vi.fn().mockResolvedValue(undefined),
        updateGenerateStatus: vi.fn().mockResolvedValue(undefined),
        updateGenerationHistory: vi.fn().mockResolvedValue(undefined),
        appendGenerationLogs: vi.fn().mockResolvedValue(undefined),
        updateGenerateRecentLogs: vi.fn().mockResolvedValue(undefined),
        emitGenerationCompleted: vi.fn().mockResolvedValue(undefined),
    };
    const dataGenerator = { initialize: vi.fn().mockResolvedValue(generated) };
    const markdownGenerator = { initialize: vi.fn() };
    const websiteGenerator = { initialize: vi.fn() };

    const orchestrator = new TriggerGenerationOrchestrator(
        dataGenerator as unknown as DataGeneratorService,
        markdownGenerator as unknown as MarkdownGeneratorService,
        websiteGenerator as unknown as WebsiteGeneratorService,
        workOperations as unknown as WorkOperationsService,
    );
    return { orchestrator, workOperations, markdownGenerator, websiteGenerator };
}

const work = { id: 'work-1', name: 'AI robots', generateStatus: null } as never;
const user = { id: 'user-1' } as never;

describe('TriggerGenerationOrchestrator: a generation the AI provider refuses', () => {
    it("stores the provider's message, once, as the Work's generateStatus.error and the history errorMessage", async () => {
        const refusal = providerRefusal();
        const { orchestrator, workOperations, markdownGenerator, websiteGenerator } = build({
            success: false,
            error: { code: 'GENERATION_FAILED', message: refusal.message, cause: refusal },
            warnings: [],
        });

        await expect(
            orchestrator.run({ work, user, dto: {} as never, historyId: 'history-1' }),
        ).rejects.toThrow(CREDITS_MESSAGE);

        expect(workOperations.updateGenerateStatus).toHaveBeenCalledWith(
            'work-1',
            expect.objectContaining({ status: GenerateStatusType.ERROR, error: CREDITS_MESSAGE }),
        );
        expect(workOperations.updateGenerationHistory).toHaveBeenCalledWith(
            'work-1',
            'history-1',
            expect.objectContaining({
                status: GenerateStatusType.ERROR,
                errorMessage: CREDITS_MESSAGE,
            }),
        );
        expect(markdownGenerator.initialize).not.toHaveBeenCalled();
        expect(websiteGenerator.initialize).not.toHaveBeenCalled();
    });
});
