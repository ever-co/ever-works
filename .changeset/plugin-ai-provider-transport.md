---
'@ever-works/plugin': minor
---

AI providers whose endpoint is not a plain URL: `IAiProviderPlugin.createTransport(scope, settings)` (optional) returns an `AiProviderTransport` (`baseUrl`, `apiKey`, `fetch`), surfaced by the AI facade as `AiProviderConfig.fetch` so a client that builds its own model passes it as its `fetch`; `AiOperationsConfig.fetch` routes every LangChain/OpenAI request through it. `AiProviderCallScope` (`userId`, `workId`) rides `ChatCompletionOptions.scope`, `AskJsonCompletionOptions.scope` and an optional second argument of `listModels`, `isAvailable` and `validateConnection`, for a provider whose answer depends on the caller. New platform service `PluginServices.localAi` (`LocalAiRelayServiceRef`): the model servers on the caller's own fleet nodes. All additive and optional: existing providers and callers are unchanged.
