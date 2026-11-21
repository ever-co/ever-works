/**
 * Local AI on fleet nodes — provider registry, configuration, probes, tags,
 * the agent-CLI binding and the completion relay. See `types.ts` for the model and the extension point.
 */
export * from './types';
export * from './http';
export * from './registry';
export * from './providers';
export * from './config';
export * from './secrets';
export * from './tags';
export * from './agent-binding';
export * from './monitor';
export * from './smoke-test';
export * from './setup';
// Local AI completions — the platform's model requests (`ai-completion`) relayed
// to a healthy provider: the target selection and wire table, the body codec,
// and the local-AI lane's plan and cadence.
export * from './completion';
export * from './completion-codec';
export * from './completion-lane';
