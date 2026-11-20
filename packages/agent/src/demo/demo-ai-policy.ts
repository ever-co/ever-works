import { DemoModelNotAllowedError } from './demo-errors';

/**
 * Platform demo mode — the free-model rule `AiFacadeService` applies to every
 * call on a demo instance: the provider is always OpenRouter and the model id
 * always ends in `:free`. A stale or missing free id fails closed; it never
 * falls through to a paid model.
 */

/** The only AI provider a demo instance calls. */
export const DEMO_AI_PROVIDER_ID = 'openrouter';

const FREE_SUFFIX = ':free';

/** A model id is free iff it ends with `:free` (and names something before it). Nothing else counts. */
export function isFreeModelId(id: string | undefined): boolean {
    return typeof id === 'string' && id.length > FREE_SUFFIX.length && id.endsWith(FREE_SUFFIX);
}

/**
 * The model a demo call may send: `requested` when it is free, else the
 * `tier`'s configured model, else `defaultModel` — each only when free.
 * Throws {@link DemoModelNotAllowedError} when none of them is.
 */
export function pickFreeModel(
    requested: string | undefined,
    settings: Record<string, unknown>,
    tier?: 'simple' | 'medium' | 'complex',
): string {
    const candidates = [
        requested,
        tier ? settings[`${tier}Model`] : undefined,
        settings.defaultModel,
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && isFreeModelId(candidate)) return candidate;
    }
    throw new DemoModelNotAllowedError(requested ?? '');
}

const TIERS = ['simple', 'medium', 'complex'] as const;

/**
 * Provider settings narrowed to their free models, for a check that sends one
 * request to each model its settings name instead of taking a model (a
 * connection test, model validation): every tier model that is not free is
 * dropped, and `defaultModel` becomes the {@link pickFreeModel} choice.
 * `models` lists the distinct models left, one upstream request each. Throws
 * {@link DemoModelNotAllowedError} when no model is free. `settings` is not changed.
 */
export function freeModelSettings(settings: Record<string, unknown>): {
    settings: Record<string, unknown>;
    models: string[];
} {
    const free: Record<string, unknown> = { ...settings };
    const tierModels: string[] = [];
    let firstFreeTier: (typeof TIERS)[number] | undefined;
    for (const tier of TIERS) {
        const value = settings[`${tier}Model`];
        if (typeof value === 'string' && isFreeModelId(value)) {
            tierModels.push(value);
            firstFreeTier ??= tier;
        } else {
            delete free[`${tier}Model`];
        }
    }
    const requested = typeof settings.defaultModel === 'string' ? settings.defaultModel : undefined;
    const defaultModel = pickFreeModel(requested, settings, firstFreeTier);
    free.defaultModel = defaultModel;
    return { settings: free, models: [...new Set([defaultModel, ...tierModels])] };
}

/**
 * An AI provider's settings as reported to callers that build their own model
 * client from them (outside the facade and its quota): no `apiKey`, so they
 * treat the provider as not configured, and free models only
 * ({@link freeModelSettings}; no model at all when none is free). Never throws.
 */
export function demoProviderConfigSettings(
    settings: Record<string, unknown>,
): Record<string, unknown> {
    const withoutKey: Record<string, unknown> = { ...settings };
    delete withoutKey.apiKey;
    try {
        return freeModelSettings(withoutKey).settings;
    } catch (error) {
        if (!(error instanceof DemoModelNotAllowedError)) throw error;
        for (const key of ['defaultModel', ...TIERS.map((tier) => `${tier}Model`)]) {
            delete withoutKey[key];
        }
        return withoutKey;
    }
}

/**
 * The provider answered that the model does not exist or has no endpoint —
 * how OpenRouter reports a free model it has withdrawn.
 */
const MODEL_UNAVAILABLE = /model.*(not found|does not exist)|No endpoints found|not a valid model/i;

/** True when `error` (or the error it wraps) is a provider's "model not found" answer. */
export function isModelUnavailableError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    if (MODEL_UNAVAILABLE.test(error.message)) return true;
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error && MODEL_UNAVAILABLE.test(cause.message);
}
