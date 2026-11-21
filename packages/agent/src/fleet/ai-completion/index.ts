// Local AI completions — the `ai-completion` job's platform half: the service
// that enqueues one model request on the owner's fleet and hands its answer
// back, the relay plugins call (`PluginServices.localAi`), its body codec, and
// the binder that hands the relay to every plugin context.
export * from './fleet-ai-completion.codec';
export * from './fleet-ai-completion.service';
export * from './fleet-local-ai-relay';
export * from './fleet-local-ai-plugin-services';
