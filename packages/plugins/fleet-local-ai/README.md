# @ever-works/fleet-local-ai-plugin

**Local AI on your computers** — an Ever Works AI provider whose models are the ones YOUR computers serve.
A fleet node (`ever-works-node`) with a local model server — llama-swap, Ollama, LM Studio, vLLM or any
OpenAI-compatible server on the machine or the LAN — answers the requests, so a Work generation (or any
other AI call) runs on your own GPU **for free**.

## Plugin metadata

| Field        | Value                                  |
| ------------ | -------------------------------------- |
| ID           | `fleet-local-ai`                       |
| Category     | `ai-provider`                          |
| Capabilities | `ai-provider`                          |
| Distribution | `core` (it needs the platform's fleet) |
| Built-in     | yes                                    |
| Auto-enable  | no                                     |

## How a request travels

```
pipeline / AI facade ──fetch──▶ fleet transport ──▶ local AI relay ──▶ ai-completion job ──▶ your node ──▶ its local model server
       (AI SDK or LangChain)      (this plugin)     (the platform)      (owner-only lease)   (local-AI lane)   (llama-swap, …)
```

1. **A transport, not a URL.** The plugin hands every OpenAI-compatible client a `fetch`
   (`src/fleet-transport.ts`) and a placeholder origin (`https://fleet-local-ai.invalid/v1` — `.invalid`
   never resolves, so a client that ignored the transport could never reach anything):
    - the plugin's own calls (`createChatCompletion`, streaming, `askJson` — what the AI facade calls) run
      the shared `AiOperations` (LangChain) with that `fetch`;
    - a pipeline that builds its own AI SDK model (the **agent pipeline**) gets the same `fetch` from
      `aiFacade.getProviderConfig()` (`createTransport`).

    Tools, JSON mode and structured output therefore work exactly as against the server itself.

2. **The platform's local AI relay** (`PluginContext.services.localAi`) turns each `POST …/chat/completions`
   into ONE `ai-completion` fleet job for one of your online computers that serves the model. `GET …/models`
   is answered from the models your computers advertise.
3. **Your node** relays it to a healthy local provider and returns the provider's answer — status and body.
4. **Streaming:** the node never streams (a job has one result); a client that asked to stream gets the
   event stream rebuilt from the whole answer (`src/sse.ts`): the reasoning, the text, every tool call, the
   finish reason and the usage — in one burst.

Failures read like any OpenAI-compatible server's: no computer serves the model → **503** (with what to
start), the fleet is stopped → **503**, a timeout → **504**, a request too large → **413**, a malformed one →
**400**, a node failure → **502**; a cancel rejects with an `AbortError`, as `fetch` does.

## Settings

| Setting                              | Scope  | Meaning                                                                                           |
| ------------------------------------ | ------ | ------------------------------------------------------------------------------------------------- |
| **Model** (`defaultModel`, required) | user   | A model one of your computers serves; the picker lists them (with how many computers serve each). |
| Simple / Standard / Complex model    | user   | Optional tier models, like any AI provider (the agent pipeline uses the complex one first).       |
| Request timeout                      | user   | The whole wait for one answer, computer pick-up included (default 900 s, 10–1800).                |
| Context window                       | user   | The context your model is served with (default 32768); long conversations are compacted to it.    |
| Temperature, Max Tokens              | hidden | Defaults 0.7 and 8192 — reasoning models spend their thinking from the token budget too.          |

There is no API key and no URL: requests only ever go to your own computers, through the platform.

## Turn it on (a llama-swap GPU computer and a Work)

1. **On the GPU computer**, configure the provider in the node — `localAi` in `node-config.json` (or the
   `EVER_WORKS_NODE_LOCAL_AI_*` env shorthand):

    ```json
    "localAi": {
    	"providers": [
    		{ "id": "gpu", "kind": "llama-swap", "baseUrl": "http://192.168.1.69:8000",
    		  "apiKeyFile": "/etc/ever-works-node/local-llm.key", "defaultModel": "flashnext" }
    	]
    }
    ```

    `ever-works-node local-ai probe` must list the model; `ever-works-node local-ai test` sends one tiny
    request per API.

2. **Start the node with `--work`.** Its log says it serves the platform's model requests; its tags gain
   `local-ai-completions` and `local-model:flashnext`. `localAi.completions.concurrency` (default 1) is how
   many requests it answers at once — outside `--concurrency`, so Agents keep their slots.
3. **In Ever Works:** Plugins → **Local AI on your computers** → Enable, pick **flashnext**, Test connection
   ("flashnext is served by 1 of your computers").
4. **Generate:** pick **Local AI on your computers** as the Work's AI provider (or for one generation,
   `providers.ai = "fleet-local-ai"`), with the agent pipeline or the standard pipeline.

The node side is documented in [`apps/node/README.md`](../../../apps/node/README.md#serving-the-platforms-model-requests-ai-completion),
the platform side in [`docs/features/fleet.md`](../../../docs/features/fleet.md#local-ai-for-the-platforms-own-ai-calls-work-generation).

## Cost

Free. Every model this plugin reports is priced **0** (explicitly — a catalogue price for a model of the
same name never applies), the job is stamped 0 cents, and no budget, credit or daily ceiling is touched.

## Limits (today)

- One request carries at most **200 KiB compressed / 4 MiB** of JSON (bodies travel gzip + base64 inside
  the job); keep the context window realistic for your model.
- A model is routed by its `local-model:` tag, which holds at most 20 characters of slugged id: serve a
  longer id under a shorter alias (llama-swap `aliases`, an Ollama tag).
- Streaming is synthesised for the Chat Completions API; a streamed Responses or Messages request is
  refused with a clear message (send it without `stream`). Adding one is one entry in `SSE_SYNTHESISERS`.
- No embeddings yet.
- The **OpenCode** pipeline dials its own HTTP endpoint and cannot use this provider (it says so).

## Extending it

- **A new local model server kind** (koboldcpp, TGI, …) needs nothing here: it is one provider definition
  on the node (`apps/node/src/core/local-ai/providers/`), and the relay forwards to it like any other.
- **A new wire API** is one entry in the node's wire table (`apps/node/src/core/local-ai/completion.ts`)
  and, for streaming, one synthesiser in `src/sse.ts`; the transport routes it by path
  (`fleetAiWireApiForPath`).
- **Another relay** (a desktop bridge, a LAN gateway) implements the same `LocalAiRelayServiceRef` and is
  injected into the plugin context — this plugin does not change.
