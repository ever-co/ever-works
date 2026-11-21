import { LocalAiHttpError } from './http';
import type { LocalAiMonitor } from './monitor';
import { LocalAiSecretError } from './secrets';
import { resolveLocalAiEndpoint } from './agent-binding';
import type { LocalAiProviderSettings, LocalAiWireApi } from './types';

/**
 * `ever-works-node local-ai test` — one tiny real request per wire API, so an
 * operator can see which APIs a provider ACTUALLY answers before binding an
 * agent CLI to it.
 *
 * This is the only code that asks a local model to generate anything, and it
 * runs only when a person asks for it: a few output tokens on the operator's
 * own hardware. The periodic probe never does (a completion would make a
 * model-swapping server like llama-swap load a model).
 */

export interface LocalAiSmokeResult {
	api: LocalAiWireApi;
	ok: boolean;
	latencyMs: number;
	/** One line: what came back, or why it failed. Never a key, never more than a short excerpt. */
	detail: string;
}

/** The request each wire API is tested with, and how its answer is recognised. */
const SMOKE: Readonly<
	Record<
		LocalAiWireApi,
		{
			path: string;
			body: (model: string) => unknown;
			headers?: Record<string, string>;
			text: (json: unknown) => string | null;
		}
	>
> = {
	'openai-chat': {
		path: '/chat/completions',
		body: (model) => ({
			model,
			messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
			max_tokens: 16,
			temperature: 0
		}),
		text: (json) => {
			const choices = (json as { choices?: unknown })?.choices;
			if (!Array.isArray(choices) || choices.length === 0) return null;
			const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
			return typeof content === 'string' ? content : '';
		}
	},
	'openai-responses': {
		path: '/responses',
		body: (model) => ({ model, input: 'Reply with the single word: ok', max_output_tokens: 16 }),
		text: (json) => {
			const record = json as { output_text?: unknown; output?: unknown };
			if (typeof record?.output_text === 'string') return record.output_text;
			if (!Array.isArray(record?.output)) return null;
			for (const item of record.output) {
				const content = (item as { content?: unknown })?.content;
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					const text = (part as { text?: unknown })?.text;
					if (typeof text === 'string') return text;
				}
			}
			return '';
		}
	},
	'anthropic-messages': {
		path: '/v1/messages',
		headers: { 'anthropic-version': '2023-06-01' },
		body: (model) => ({
			model,
			max_tokens: 16,
			messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
		}),
		text: (json) => {
			const content = (json as { content?: unknown })?.content;
			if (!Array.isArray(content)) return null;
			for (const part of content) {
				const text = (part as { text?: unknown })?.text;
				if (typeof text === 'string') return text;
			}
			return '';
		}
	}
};

/**
 * Send one smoke request per API in `apis` (default: every API the provider
 * is configured to speak) to `model`, one after the other (a single local GPU
 * serves one at a time anyway). Never throws: each API gets its own verdict.
 */
export async function runLocalAiSmokeTest(
	monitor: LocalAiMonitor,
	provider: LocalAiProviderSettings,
	options: { model: string; apis?: readonly LocalAiWireApi[]; timeoutMs: number; now?: () => number }
): Promise<LocalAiSmokeResult[]> {
	const now = options.now ?? (() => Date.now());
	const results: LocalAiSmokeResult[] = [];
	for (const api of options.apis ?? provider.apis) {
		const spec = SMOKE[api];
		const base = resolveLocalAiEndpoint(monitor.registry, provider, api);
		const startedAt = now();
		if (!base) {
			results.push({
				api,
				ok: false,
				latencyMs: 0,
				detail: 'the kind points this API away from the provider’s own address — not sent'
			});
			continue;
		}
		try {
			const { json } = await monitor.request(
				provider,
				{
					method: 'POST',
					url: `${base}${spec.path}`,
					label: `POST ${api === 'anthropic-messages' ? '' : '/v1'}${spec.path}`,
					body: spec.body(options.model),
					...(spec.headers ? { headers: spec.headers } : {})
				},
				options.timeoutMs
			);
			const text = spec.text(json);
			results.push(
				text === null
					? {
							api,
							ok: false,
							latencyMs: now() - startedAt,
							detail: 'answered 2xx, but not in this API’s shape'
						}
					: {
							api,
							ok: true,
							latencyMs: now() - startedAt,
							detail: text.trim() ? `answered: ${excerpt(text)}` : 'answered (no text)'
						}
			);
		} catch (error) {
			results.push({
				api,
				ok: false,
				latencyMs: now() - startedAt,
				detail:
					error instanceof LocalAiHttpError || error instanceof LocalAiSecretError
						? error.message
						: 'the request failed'
			});
		}
	}
	return results;
}

function excerpt(text: string): string {
	// eslint-disable-next-line no-control-regex -- strip control characters from a model's words before printing
	const clean = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
	return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean;
}
