import { BUILT_IN_LOCAL_AI_PROVIDERS } from './providers';
import { isLocalAiWireApi, LocalAiConfigError, type LocalAiProviderDefinition } from './types';

/** A kind id: lower-case, starts with a letter or digit, hyphens inside. */
export const LOCAL_AI_KIND_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;

/**
 * The provider kinds a node can be configured with, keyed by kind id.
 *
 * Built from {@link BUILT_IN_LOCAL_AI_PROVIDERS} by default; an embedder (the
 * desktop shell, a test, a future plugin loader) passes its own list. Each
 * definition is checked once, here, so a broken one fails at startup with its
 * name rather than at the first probe.
 */
export class LocalAiProviderRegistry {
	private readonly byKind = new Map<string, LocalAiProviderDefinition>();

	constructor(definitions: readonly LocalAiProviderDefinition[] = BUILT_IN_LOCAL_AI_PROVIDERS) {
		for (const definition of definitions) this.register(definition);
	}

	/** Add one kind. Throws for an invalid definition or a kind that is already registered. */
	register(definition: LocalAiProviderDefinition): void {
		if (!definition || typeof definition !== 'object') {
			throw new LocalAiConfigError('A local AI provider definition must be an object');
		}
		if (typeof definition.kind !== 'string' || !LOCAL_AI_KIND_PATTERN.test(definition.kind)) {
			throw new LocalAiConfigError(`Local AI provider kind "${String(definition.kind)}" is not a valid kind id`);
		}
		if (this.byKind.has(definition.kind)) {
			throw new LocalAiConfigError(`Local AI provider kind "${definition.kind}" is registered twice`);
		}
		if (typeof definition.probe !== 'function') {
			throw new LocalAiConfigError(`Local AI provider kind "${definition.kind}" has no probe`);
		}
		if (!Array.isArray(definition.defaultApis) || !definition.defaultApis.every(isLocalAiWireApi)) {
			throw new LocalAiConfigError(`Local AI provider kind "${definition.kind}" declares an unknown wire API`);
		}
		this.byKind.set(definition.kind, definition);
	}

	/** True when `kind` is registered. */
	has(kind: string): boolean {
		return this.byKind.has(kind);
	}

	/** The definition of `kind`; throws a {@link LocalAiConfigError} naming the known kinds otherwise. */
	get(kind: string): LocalAiProviderDefinition {
		const definition = this.byKind.get(kind);
		if (!definition) {
			throw new LocalAiConfigError(
				`Unknown local AI provider kind "${kind}" — this node knows: ${this.kinds().join(', ')}`
			);
		}
		return definition;
	}

	/** Every registered kind id, in registration order. */
	kinds(): string[] {
		return [...this.byKind.keys()];
	}

	/** Every registered definition, in registration order. */
	definitions(): LocalAiProviderDefinition[] {
		return [...this.byKind.values()];
	}
}

let defaultRegistry: LocalAiProviderRegistry | null = null;

/** The built-in registry, created on first use (no work at import time). */
export function defaultLocalAiProviderRegistry(): LocalAiProviderRegistry {
	defaultRegistry ??= new LocalAiProviderRegistry();
	return defaultRegistry;
}
