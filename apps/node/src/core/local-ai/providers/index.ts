import type { LocalAiProviderDefinition } from '../types';
import { llamaSwapProvider } from './llama-swap';
import { lmStudioProvider } from './lm-studio';
import { ollamaProvider } from './ollama';
import { openAiCompatibleProvider } from './openai-compatible';
import { vllmProvider } from './vllm';

/**
 * The provider kinds this build knows. Adding one is a file next to these and
 * ONE line here — the registry, the config validation, the tags, the CLI and
 * the agent binding all read this list, and nothing else names a kind.
 */
export const BUILT_IN_LOCAL_AI_PROVIDERS: readonly LocalAiProviderDefinition[] = [
	openAiCompatibleProvider,
	llamaSwapProvider,
	ollamaProvider,
	lmStudioProvider,
	vllmProvider
];

export { llamaSwapProvider, lmStudioProvider, ollamaProvider, openAiCompatibleProvider, vllmProvider };
export { parseOllamaTags } from './ollama';
export { parseLmStudioModels } from './lm-studio';
export { parseVllmModels } from './vllm';
export {
	isUsableLocalModelId,
	LOCAL_AI_MAX_MODELS,
	parseOpenAiModelList,
	probeOpenAiModels,
	positiveInteger
} from './openai-compatible';
