import { describe, expect, it } from 'vitest';
import type { FleetAgentModelExecution } from '@ever-works/contracts';
import {
	assertLocalBindingInCommand,
	buildModelCliCommand,
	ModelCliCommandError,
	type ModelCliLocalProvider
} from './model-cli';

/**
 * Local AI — the Codex provider override and the binding gate.
 *
 * The URL is the one value on these command lines that needs `:` and `/`, so
 * it has its own positive pattern and is double-quoted; everything else stays
 * a bare identifier. Claude Code is pointed at a local server through its
 * ENVIRONMENT only, so the override is refused for it.
 */

const scratch = { instructionsPath: '/tmp/job/instructions.md', resultPath: '/tmp/job/model-output.json' };

function execution(over: Partial<FleetAgentModelExecution> = {}): FleetAgentModelExecution {
	return { provider: 'codex', instructions: 'do it', ...over };
}

const LOCAL: ModelCliLocalProvider = {
	id: 'gpu',
	baseUrl: 'http://192.168.1.69:8000/v1',
	wireApi: 'responses',
	envKey: 'LOCAL_AI_API_KEY'
};

function codexCommand(localProvider: ModelCliLocalProvider, over: Partial<FleetAgentModelExecution> = {}): string {
	return buildModelCliCommand({
		execution: execution({ model: 'flashnext', ...over }),
		executable: '/usr/local/bin/codex',
		workspacePath: '/work/ws',
		scratch,
		localProvider,
		platform: 'linux'
	});
}

describe('buildModelCliCommand — Codex on a local AI provider', () => {
	it('points the run at the local provider with -c overrides, the URL double-quoted', () => {
		expect(codexCommand(LOCAL)).toBe(
			'"/usr/local/bin/codex" exec --ignore-user-config --json --sandbox workspace-write -C "/work/ws" ' +
				'-c model_provider=gpu -c model_providers.gpu.name=gpu ' +
				'-c "model_providers.gpu.base_url=http://192.168.1.69:8000/v1" ' +
				'-c model_providers.gpu.wire_api=responses -c model_providers.gpu.env_key=LOCAL_AI_API_KEY ' +
				'-m flashnext - < "/tmp/job/instructions.md" > "/tmp/job/model-output.json"'
		);
	});

	it('omits env_key for a keyless server', () => {
		const { envKey: _none, ...keyless } = LOCAL;
		const command = codexCommand(keyless);
		expect(command).toContain('-c model_providers.gpu.wire_api=responses -m flashnext');
		expect(command).not.toContain('env_key');
	});

	it('accepts a bracketed IPv6 host and a path prefix', () => {
		expect(codexCommand({ ...LOCAL, baseUrl: 'https://[fd00::12]:8443/llm/v1' })).toContain(
			'-c "model_providers.gpu.base_url=https://[fd00::12]:8443/llm/v1"'
		);
	});

	it.each([
		['a shell expansion', 'http://host/$(id)'],
		['a cmd.exe variable', 'http://host/%PATH%'],
		['a quote', 'http://host/"x'],
		['a credential', 'http://user:pass@host:8000/v1'],
		['a query string', 'http://host:8000/v1?key=1'],
		['a space', 'http://host:8000/v 1'],
		['another scheme', 'file:///etc/passwd'],
		['an ampersand', 'http://host/a&b']
	])('refuses a base URL with %s', (_what, baseUrl) => {
		expect(() => codexCommand({ ...LOCAL, baseUrl })).toThrow(ModelCliCommandError);
	});

	it.each(['gpu.evil', 'GPU', 'gpu box', 'g$u', ''])(
		'refuses the provider id %j (it is a TOML key segment)',
		(id) => {
			expect(() => codexCommand({ ...LOCAL, id })).toThrow(ModelCliCommandError);
		}
	);

	it('refuses an env_key that is not an environment variable name', () => {
		expect(() => codexCommand({ ...LOCAL, envKey: 'local-key' })).toThrow(ModelCliCommandError);
	});

	it('refuses the override for Claude Code, which is pointed at a local server through its environment', () => {
		expect(() =>
			buildModelCliCommand({
				execution: execution({ provider: 'claude-code', model: 'flashnext' }),
				executable: '/usr/local/bin/claude',
				workspacePath: '/work/ws',
				scratch,
				localProvider: LOCAL,
				platform: 'linux'
			})
		).toThrow(/Codex flag/);
	});

	it('builds byte-for-byte the old command without the override', () => {
		expect(
			buildModelCliCommand({
				execution: execution({ model: 'gpt-5.3-codex' }),
				executable: '/usr/local/bin/codex',
				workspacePath: '/work/ws',
				scratch,
				platform: 'linux'
			})
		).toBe(
			'"/usr/local/bin/codex" exec --ignore-user-config --json --sandbox workspace-write -C "/work/ws" ' +
				'-m gpt-5.3-codex - < "/tmp/job/instructions.md" > "/tmp/job/model-output.json"'
		);
	});
});

describe('assertLocalBindingInCommand', () => {
	const claude = (model: string): string =>
		buildModelCliCommand({
			execution: execution({ provider: 'claude-code', model }),
			executable: '/usr/local/bin/claude',
			workspacePath: '/work/ws',
			scratch,
			platform: 'linux'
		});

	it('passes a Claude Code command that carries the local model', () => {
		expect(() =>
			assertLocalBindingInCommand({
				command: claude('flashnext'),
				execution: execution({ provider: 'claude-code' }),
				model: 'flashnext'
			})
		).not.toThrow();
	});

	it('refuses a Claude Code command still carrying the cloud model', () => {
		expect(() =>
			assertLocalBindingInCommand({
				command: claude('claude-opus-5'),
				execution: execution({ provider: 'claude-code' }),
				model: 'flashnext'
			})
		).toThrow(/does not carry --model flashnext/);
	});

	it('refuses a Codex command without the provider override (it would go to OpenAI)', () => {
		const command = buildModelCliCommand({
			execution: execution({ model: 'flashnext' }),
			executable: '/usr/local/bin/codex',
			workspacePath: '/work/ws',
			scratch,
			platform: 'linux'
		});
		expect(() =>
			assertLocalBindingInCommand({ command, execution: execution(), model: 'flashnext', localProvider: LOCAL })
		).toThrow(/would go to OpenAI/);
		expect(() =>
			assertLocalBindingInCommand({
				command: codexCommand(LOCAL),
				execution: execution(),
				model: 'flashnext',
				localProvider: LOCAL
			})
		).not.toThrow();
	});
});
