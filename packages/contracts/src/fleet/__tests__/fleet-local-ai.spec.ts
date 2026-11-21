import { describe, expect, it } from 'vitest';
import {
	FLEET_AGENT_TASK_MODEL_COST_BASES,
	FLEET_LOCAL_AI_CAPABILITY,
	FLEET_LOCAL_AI_COMPLETIONS_CAPABILITY,
	fleetLocalAgentCapability,
	fleetModelCostUsdToCents,
	isFleetLocalAiCapability,
	isFleetLocalModelResult
} from '../fleet-jobs.types';

/** Local AI on fleet nodes — the shared tag family and the `costBasis` marker. */
describe('local AI capability tags', () => {
	it('recognises every tag of the family and nothing else', () => {
		for (const tag of [
			FLEET_LOCAL_AI_CAPABILITY,
			FLEET_LOCAL_AI_COMPLETIONS_CAPABILITY,
			'local-ai:llama-swap',
			'local-model:flashnext',
			fleetLocalAgentCapability('claude-code')
		]) {
			expect(isFleetLocalAiCapability(tag)).toBe(true);
		}
		for (const tag of ['gpu', 'local', 'local-ai-x', 'local-ai-completions-x', 'claude-code', 42, null]) {
			expect(isFleetLocalAiCapability(tag)).toBe(false);
		}
	});

	it('names the agent-runtime tag after the CLI', () => {
		expect(fleetLocalAgentCapability('codex')).toBe('local-agent:codex');
	});
});

describe('costBasis', () => {
	it('marks a local run, whose 0 is free rather than unknown', () => {
		expect(FLEET_AGENT_TASK_MODEL_COST_BASES).toEqual(['cli', 'local']);
		expect(isFleetLocalModelResult({ costBasis: 'local' })).toBe(true);
		expect(isFleetLocalModelResult({})).toBe(false);
		expect(isFleetLocalModelResult(null)).toBe(false);
		// The platform's one dollar→cent conversion reads the local 0 as 0 cents, not "unknown".
		expect(fleetModelCostUsdToCents(0)).toBe(0);
	});
});
