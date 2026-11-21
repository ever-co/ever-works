import { describe, expect, it, vi } from 'vitest';
import type { FleetAgentTaskModelResult, FleetJobView, FleetTaskWorkspaceDescriptor } from '@ever-works/contracts';
import { join } from 'node:path';
import {
	AgentTaskPayloadError,
	recognizeModelUsageLimit,
	runAgentTaskJob,
	type AgentTaskIo,
	type AgentTaskScratchFs
} from './agent-task';
import type { AgentTaskQuestionFs } from './agent-task-question';
import type { LocalAiAgentBinding } from '../local-ai/agent-binding';

/**
 * `agent-task` on a LOCAL AI provider (`localAi.agentRuntime`).
 *
 * The properties, in order of what it would cost to lose them:
 *
 *   1. A bound run never reaches the cloud seat: the cloud credential names
 *      are stripped from the child's env even when the job grants them, the
 *      endpoint and token come from the local binding, and the command line
 *      carries the LOCAL model whatever the platform planned.
 *   2. A bound CLI whose provider cannot serve it is DECLINED before anything
 *      is provisioned — never run on the cloud seat instead.
 *   3. The run reports `costUsd: 0` with `costBasis: 'local'` and passes no
 *      dollar budget a free run could trip; the key is scrubbed from what it
 *      reports.
 *   4. An unbound CLI's run is byte-for-byte what it was.
 */

const ABSOLUTE = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
const CLAUDE = process.platform === 'win32' ? 'C:\\npm\\claude.cmd' : '/usr/local/bin/claude';
const CODEX = process.platform === 'win32' ? 'C:\\npm\\codex.cmd' : '/usr/local/bin/codex';
const SCRATCH = process.platform === 'win32' ? 'C:\\scratch' : '/scratch';
const GATEWAY = 'http://192.168.1.69:8000';
const LOCAL_KEY = 'sk-llamaswap-LOCAL-KEY-0123456789';
const CLOUD_OAUTH = 'sk-ant-oat01-CLOUD-SEAT-TOKEN-abcdef';
const CLOUD_API_KEY = 'sk-ant-api03-CLOUD-API-KEY-abcdef';
const OPENAI_KEY = 'sk-proj-OPENAI-CLOUD-KEY-abcdef';

const descriptor: FleetTaskWorkspaceDescriptor = {
	path: ABSOLUTE,
	repositoryId: 'ever-works/ever-works',
	baseRef: 'develop',
	branch: 'task/t1-fix',
	baseSha: 'a'.repeat(40),
	headSha: 'a'.repeat(40),
	reused: false
};

function job(payload: unknown): FleetJobView {
	return {
		id: 'job-local-1',
		kind: 'agent-task',
		status: 'leased',
		nodeId: 'node-1',
		requiredCapabilities: [],
		payload: payload as Record<string, unknown>,
		leaseExpiresAt: null,
		attempts: 1,
		maxAttempts: 3,
		createdAt: null,
		startedAt: null,
		completedAt: null
	};
}

function scratchFs(modelOutput: string): AgentTaskScratchFs {
	const files = new Map<string, string>();
	return {
		createScratchDir: async (root, prefix) => join(root, `${prefix}-scratch`),
		writeFile: async (path, content) => {
			files.set(path, content);
		},
		readFile: async (path) => (path.endsWith('model-output.json') ? modelOutput : (files.get(path) ?? null)),
		remove: async () => undefined,
		mkdir: async () => undefined
	};
}

const questionFs: AgentTaskQuestionFs = {
	readHead: async () => null,
	remove: async () => undefined,
	removeDirIfEmpty: async () => undefined
};

/** Spawn double recording every command and the env it was given. */
function recordingSpawn() {
	const spawned: Array<{ command: string; env: Record<string, string> }> = [];
	const spawnFn = ((command: string, options: { env: Record<string, string> }) => {
		spawned.push({ command, env: options.env });
		const handlers = new Map<string, (arg?: unknown) => void>();
		queueMicrotask(() => handlers.get('close')?.(0));
		return {
			stdout: { on: () => undefined, destroy: () => undefined },
			stderr: { on: () => undefined, destroy: () => undefined },
			on: (event: string, handler: (arg?: unknown) => void) => {
				handlers.set(event, handler);
			},
			kill: () => undefined
		};
	}) as never;
	return { spawned, spawnFn };
}

const parentEnv: NodeJS.ProcessEnv = {
	PATH: process.env.PATH ?? '/usr/bin',
	HOME: process.platform === 'win32' ? 'C:\\Users\\ewnode' : '/home/ewnode',
	USERPROFILE: 'C:\\Users\\ewnode',
	CLAUDE_CODE_OAUTH_TOKEN: CLOUD_OAUTH,
	ANTHROPIC_API_KEY: CLOUD_API_KEY,
	OPENAI_API_KEY: OPENAI_KEY
};

function baseIo(over: Partial<AgentTaskIo> = {}): AgentTaskIo {
	return {
		directoryExists: () => true,
		parentEnv,
		provisionWorkspace: vi.fn(async () => descriptor),
		finalizeWorkspace: vi.fn(async () => ({
			pushed: true,
			headSha: 'b'.repeat(40),
			empty: false,
			changedFiles: 1
		})),
		modelCli: { 'claude-code': CLAUDE, codex: CODEX },
		scratchRoot: SCRATCH,
		sessionConfigFs: { readFile: async () => null },
		questionFs,
		...over
	};
}

const payload = {
	taskId: 't1',
	runId: 'run-1',
	agentId: 'agent-1',
	workspace: {
		repositoryId: 'ever-works/ever-works',
		repoUrl: 'https://github.com/ever-works/ever-works.git',
		baseRef: 'develop',
		branch: 'task/t1-fix'
	},
	execution: {
		provider: 'claude-code',
		instructions: '# Task\nFix the thing.',
		model: 'claude-opus-5',
		effort: 'high',
		maxBudgetUsd: 5,
		envPassthrough: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']
	}
};

/** What Claude Code 2.1.294 printed for the flashnext run: Claude list rates for an unknown model. */
const localClaudeEnvelope = JSON.stringify({
	type: 'result',
	subtype: 'success',
	is_error: false,
	result: `Done. (My ANTHROPIC_AUTH_TOKEN is ${LOCAL_KEY}.)`,
	total_cost_usd: 0.12,
	num_turns: 4,
	session_id: 'sess-local',
	usage: { input_tokens: 1200, output_tokens: 300 },
	modelUsage: { flashnext: { inputTokens: 1200, outputTokens: 300, costUSD: 0.12 } }
});

const boundClaude: LocalAiAgentBinding = {
	kind: 'bound',
	cli: 'claude-code',
	providerId: 'gpu',
	providerKind: 'llama-swap',
	model: 'flashnext',
	smallModel: 'flashnext',
	api: 'anthropic-messages',
	endpoint: GATEWAY,
	apiKey: LOCAL_KEY
};

function modelStep(spawned: Array<{ command: string; env: Record<string, string> }>, executable: string) {
	const step = spawned.find((entry) => entry.command.includes(`"${executable}"`));
	expect(step, 'the model step was spawned').toBeDefined();
	return step!;
}

describe('runAgentTaskJob — Claude Code on a local AI provider', () => {
	it('runs on the local endpoint and model, never with the cloud seat’s credentials', async () => {
		const { spawned, spawnFn } = recordingSpawn();
		const onModelRun = vi.fn();
		const io = baseIo({
			spawnFn,
			scratchFs: scratchFs(localClaudeEnvelope),
			localAiRuntime: async (provider) => (provider === 'claude-code' ? boundClaude : null),
			onModelRun
		});

		const outcome = await runAgentTaskJob(job(payload), io);

		const { command, env } = modelStep(spawned, CLAUDE);
		expect(command).toContain(' --model flashnext ');
		expect(command).not.toContain('claude-opus-5');
		// A dollar cap a free run could trip on the CLI's list-price estimate.
		expect(command).not.toContain('--max-budget-usd');
		expect(env).toMatchObject({
			ANTHROPIC_BASE_URL: GATEWAY,
			ANTHROPIC_AUTH_TOKEN: LOCAL_KEY,
			ANTHROPIC_MODEL: 'flashnext',
			ANTHROPIC_DEFAULT_OPUS_MODEL: 'flashnext',
			ANTHROPIC_DEFAULT_SONNET_MODEL: 'flashnext',
			ANTHROPIC_DEFAULT_HAIKU_MODEL: 'flashnext',
			ANTHROPIC_SMALL_FAST_MODEL: 'flashnext',
			CLAUDE_CODE_SUBAGENT_MODEL: 'flashnext',
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
			// The MCP isolation switch still wins.
			ENABLE_CLAUDEAI_MCP_SERVERS: 'false'
		});
		// The job granted both cloud credentials by name; neither reaches the child.
		expect(Object.keys(env).map((name) => name.toUpperCase())).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
		expect(Object.keys(env).map((name) => name.toUpperCase())).not.toContain('ANTHROPIC_API_KEY');
		expect(Object.values(env)).not.toContain(CLOUD_OAUTH);
		expect(Object.values(env)).not.toContain(CLOUD_API_KEY);

		expect(outcome.model).toMatchObject({
			provider: 'claude-code',
			status: 'succeeded',
			costUsd: 0,
			costBasis: 'local',
			modelId: 'flashnext',
			inputTokens: 1200,
			outputTokens: 300
		});
		// The key the model echoed is scrubbed from what the node reports.
		expect(JSON.stringify(outcome)).not.toContain(LOCAL_KEY);
		// Agent readiness is about the cloud SEAT; a local run says nothing about it.
		expect(onModelRun).not.toHaveBeenCalled();
	});

	it('runs an UNBOUND CLI exactly as before: cloud model, budget, CLI-reported cost', async () => {
		const { spawned, spawnFn } = recordingSpawn();
		const io = baseIo({
			spawnFn,
			scratchFs: scratchFs(localClaudeEnvelope),
			localAiRuntime: async () => null
		});

		const outcome = await runAgentTaskJob(job(payload), io);

		const { command, env } = modelStep(spawned, CLAUDE);
		expect(command).toContain(' --model claude-opus-5 ');
		expect(command).toContain(' --max-budget-usd 5 ');
		expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(CLOUD_OAUTH);
		expect(outcome.model?.costUsd).toBe(0.12);
		expect(outcome.model).not.toHaveProperty('costBasis');
	});

	it('uses a placeholder token for a keyless server, so the cloud login is never sent to it', async () => {
		const { spawned, spawnFn } = recordingSpawn();
		await runAgentTaskJob(
			job(payload),
			baseIo({
				spawnFn,
				scratchFs: scratchFs(localClaudeEnvelope),
				localAiRuntime: async () => ({ ...boundClaude, apiKey: null, providerKind: 'ollama' })
			})
		);
		expect(modelStep(spawned, CLAUDE).env.ANTHROPIC_AUTH_TOKEN).toBe('ever-works-local-ai');
	});
});

describe('runAgentTaskJob — a bound CLI whose provider cannot serve it', () => {
	it('declines the run before provisioning anything, with a reason — never on the cloud seat', async () => {
		const { spawned, spawnFn } = recordingSpawn();
		const onProvisionDeclined = vi.fn();
		const io = baseIo({
			spawnFn,
			scratchFs: scratchFs(localClaudeEnvelope),
			onProvisionDeclined,
			localAiRuntime: async () => ({
				kind: 'unavailable',
				cli: 'claude-code',
				providerId: 'gpu',
				reason: 'local AI provider "gpu" is down: /v1/models: connection refused'
			})
		});

		await expect(runAgentTaskJob(job(payload), io)).rejects.toThrow(AgentTaskPayloadError);

		expect(onProvisionDeclined).toHaveBeenCalledTimes(1);
		expect(onProvisionDeclined.mock.calls[0]![0]).toContain('local AI provider "gpu" is down');
		expect(onProvisionDeclined.mock.calls[0]![0]).toContain('not run on a cloud seat instead');
		expect(io.provisionWorkspace).not.toHaveBeenCalled();
		expect(spawned).toHaveLength(0);
	});

	it('declines the same way when the binding cannot even be resolved', async () => {
		const onProvisionDeclined = vi.fn();
		const io = baseIo({
			onProvisionDeclined,
			localAiRuntime: async () => {
				throw new Error('monitor exploded');
			}
		});
		await expect(runAgentTaskJob(job(payload), io)).rejects.toThrow(/could not be resolved: monitor exploded/);
		expect(onProvisionDeclined).toHaveBeenCalledTimes(1);
		expect(io.provisionWorkspace).not.toHaveBeenCalled();
	});
});

describe('runAgentTaskJob — Codex on a local AI provider', () => {
	const codexStream = [
		{ type: 'thread.started', thread_id: 'thread-local' },
		{ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Implemented it.' } },
		{ type: 'turn.completed', usage: { input_tokens: 800, cached_input_tokens: 0, output_tokens: 120 } }
	]
		.map((event) => JSON.stringify(event))
		.join('\n');

	it('points Codex at the local Responses API with -c overrides and the key in its own env var', async () => {
		const { spawned, spawnFn } = recordingSpawn();
		const io = baseIo({
			spawnFn,
			scratchFs: scratchFs(codexStream),
			localAiRuntime: async (provider) =>
				provider === 'codex'
					? {
							...boundClaude,
							cli: 'codex',
							api: 'openai-responses',
							endpoint: `${GATEWAY}/v1`
						}
					: null
		});

		const outcome = await runAgentTaskJob(
			job({
				...payload,
				execution: {
					provider: 'codex',
					instructions: '# Task',
					model: 'gpt-5.3-codex',
					envPassthrough: ['OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN']
				}
			}),
			io
		);

		const { command, env } = modelStep(spawned, CODEX);
		expect(command).toContain(
			'-c model_provider=gpu -c model_providers.gpu.name=gpu ' +
				`-c "model_providers.gpu.base_url=${GATEWAY}/v1" ` +
				'-c model_providers.gpu.wire_api=responses -c model_providers.gpu.env_key=LOCAL_AI_API_KEY'
		);
		expect(command).toContain(' -m flashnext ');
		expect(command).not.toContain('gpt-5.3-codex');
		expect(env.LOCAL_AI_API_KEY).toBe(LOCAL_KEY);
		expect(Object.keys(env).map((name) => name.toUpperCase())).not.toContain('OPENAI_API_KEY');
		expect(outcome.model).toMatchObject({ provider: 'codex', status: 'succeeded', costUsd: 0, costBasis: 'local' });
	});
});

describe('recognizeModelUsageLimit — local runs', () => {
	it('never reads a local run as the cloud seat’s usage limit', () => {
		const model: FleetAgentTaskModelResult = {
			provider: 'claude-code',
			status: 'failed',
			exitCode: 1,
			durationMs: 10,
			summary: "You've hit your weekly limit · resets Oct 19, 3am (Europe/Paris)",
			costBasis: 'local'
		};
		expect(recognizeModelUsageLimit(model)).toBeNull();
		expect(recognizeModelUsageLimit({ ...model, costBasis: undefined })).not.toBeNull();
	});
});
