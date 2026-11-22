# @ever-works/memanto-plugin

[Memanto](https://github.com/moorcheh-ai/memanto) implementation of the **agent-memory** capability, and the
platform's **default agent-memory provider, auto-enabled wherever a Memanto server is configured**. Set
`MEMANTO_BASE_URL` (and `MEMANTO_API_KEY`) on the API and every user's agents use it, with nothing to enable by
hand. Agents get typed, semantic long-term memory:

- every task run opens a memory session and gets relevant memories recalled into its prompt (fenced as untrusted),
- during a run the Agent can call `memory_search` and `memory_save` itself,
- generation pipelines with the Memory Pipeline Modifier fetch context at the start and save a digest at the end,
- the API's `/api/agent-memory/*` endpoints (save, search, context, forget) work against it.

All of that goes through `AgentMemoryFacadeService`, so it works the same with any agent-memory plugin; this package
is the Memanto backend for it.

## Why Memanto is the default, and how it is activated

Compared on 2026-11-21 (full brief in the workspace research folder
`projects/ever-works/research/memanto-agent-memory/`). Benchmark numbers are each vendor's own and are **not**
comparable across rows (different readers, judges and retrieval budgets).

| Backend        | Licence                                              | Self-host / offline                                              | Recall                               | LLM call per write | LongMemEval / LoCoMo                      |
| -------------- | ---------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------ | ------------------ | ----------------------------------------- |
| **Memanto**    | MIT server; engine is Moorcheh (proprietary)         | Server yes; engine = Moorcheh Cloud (paid) or on-prem CE (below) | Semantic (Moorcheh), typed, temporal | No                 | 89.8% (LME-S) / 87.1% QA accuracy         |
| agentmemory    | Apache-2.0 (runtime iii: Apache-2.0 AND Elastic-2.0) | Yes, keyless and fully offline                                   | BM25 by default; embeddings opt-in   | No (by default)    | Retrieval only: recall-all@5 84.7%, no QA |
| Mem0           | Apache-2.0 OSS; Platform commercial                  | Yes (needs an LLM key)                                           | Vector + extraction                  | Yes                | 94.4 / 92.5 on the managed platform       |
| Zep / Graphiti | Graphiti Apache-2.0; Zep Cloud commercial            | Graphiti yes (graph DB + LLM)                                    | Temporal knowledge graph             | Yes, several       | 90.2 / 94.7 on Zep Cloud                  |
| Letta          | Apache-2.0                                           | Yes (full agent runtime, not only memory)                        | Agent-managed memory blocks          | Yes                | — / 74.0                                  |
| Supermemory    | Apps MIT; local server closed, free to 10k docs      | Partly                                                           | Vector + extraction                  | Yes                | Recall@20 97% (retrieval)                 |
| Cognee         | Apache-2.0                                           | Yes                                                              | Graph + vector                       | At "cognify" time  | none published                            |

Memanto wins on what an agent actually needs from memory: semantic recall instead of keyword match, 13 memory
types (`fact`, `decision`, `preference`, `instruction`, …) assigned by rules with **no LLM call per write**, a
reversible expiry lifecycle, temporal recall, and published QA-accuracy scores. Of the backends that make no LLM
call per write (which keeps every save cheap and fast), it is the only one that publishes QA accuracy at all. Its
scores are self-reported and depend on the reader model.

It is **auto-enabled and the default**, but it is not zero-config, so it only serves a scope that has a Memanto
server configured:

- It needs a running Memanto server **and** a Moorcheh backend: either Moorcheh Cloud (`MOORCHEH_API_KEY`, trial
  then paid; memory text leaves your infrastructure) or Moorcheh on-prem, whose **Community Edition licence allows a
  single node and non-commercial use only**. A commercial self-hosted deployment needs Moorcheh Cloud or a Moorcheh
  Enterprise licence.
- The plugin reports itself configured (`isConfigured`) once a `baseUrl` or `apiKey` is set, either in its settings
  for a user or Work, or as `MEMANTO_BASE_URL` / `MEMANTO_API_KEY` on the API. The agent-memory facade skips it
  everywhere else, so a platform without Memanto behaves exactly as before.
- Set `MEMANTO_BASE_URL` on the API and **every user and agent uses Memanto**, ahead of agentmemory. Without it,
  agentmemory stays the zero-config, fully offline option for scopes that enable it.
- A Work that explicitly selects a provider always gets that provider.

## Run modes

| Mode                   | Setup                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local dev              | `pip install memanto` (or `uvx memanto serve`), set `MOORCHEH_API_KEY`, run `memanto serve`, then start the API with `MEMANTO_BASE_URL=http://localhost:8000`. Memanto trusts loopback callers, so `apiKey` can stay empty. |
| Self-hosted in cluster | Build `.deploy/docker/memanto/Dockerfile`, apply `.deploy/k8s/memanto.optional.yaml`, set `baseUrl` to `http://memanto.<ns>.svc.cluster.local:8000` and `apiKey` to the server's management key.                            |
| Elsewhere              | Point `baseUrl` at any reachable Memanto ≥ 0.3.0 and set `apiKey`.                                                                                                                                                          |

Enable the plugin on the Plugins page (per user, or per Work), fill in the settings, and use **Test connection**: it
checks `/health` (including whether Memanto reaches Moorcheh) and then proves the management key with
`GET /api/v2/agents`.

## Settings

| Key             | Type   | Scope | Env var fallback       | Description                                                                                                                                                                      |
| --------------- | ------ | ----- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`       | string | user  | `MEMANTO_BASE_URL`     | Memanto REST endpoint. Default `http://localhost:8000`.                                                                                                                          |
| `apiKey`        | secret | user  | `MEMANTO_API_KEY`      | Management credential: the server's `MOORCHEH_API_KEY` (Moorcheh Cloud backend) or `MEMANTO_SECRET_KEY` (on-prem backend). Not enforced for loopback callers, by Memanto design. |
| `agentPrefix`   | string | user  | `MEMANTO_AGENT_PREFIX` | Each Work gets its own Memanto agent `<prefix>-<workId>`. Default `ever-works`.                                                                                                  |
| `agentId`       | string | work  | `MEMANTO_AGENT_ID`     | Optional: keep every Work in ONE Memanto agent, separated by an internal tag. For Moorcheh's free tier (20 namespaces), or to share memory with Memanto's MCP / Claude Code.     |
| `minSimilarity` | number | user  | —                      | Optional recall similarity floor (0–1).                                                                                                                                          |
| `timeoutMs`     | number | user  | —                      | Per-request timeout. Default 30 s.                                                                                                                                               |

## How the contract maps onto Memanto

| Platform                       | Memanto                                                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| project (Work)                 | One Memanto agent per Work (`<prefix>-<workId>`, one Moorcheh namespace), created on the **first write**. Reads never create one, so an empty Work costs no namespace.                                     |
| `saveMemory`                   | `POST /api/v2/agents/{id}/remember`. Content is clamped to 10,000 chars. `metadata.memoryType` / `title` / `confidence` map onto Memanto's own fields.                                                     |
| metadata                       | Memanto has no metadata field, so scalar metadata is stored as reserved `ew:` tags and decoded back (see **Metadata in tags** below). This keeps the API's `ownerUserId` stamp, which guards delete-by-id. |
| tags                           | Normalised to Memanto's recall-filter charset (`[A-Za-z0-9_.-]`), so every saved tag can be filtered on. The `ew:` / `ew.` namespaces are reserved.                                                        |
| `searchMemory`                 | `POST …/recall` (active memories only). A blank or `*` query returns the newest memories instead (`recall/recent`).                                                                                        |
| `buildContext`                 | Semantic recall (or most recent without a query) packed best-first into the token budget. It never calls `/answer`, so recall spends no LLM credits.                                                       |
| `openSession` / `closeSession` | Ever Works-side session id, tagged onto every memory the session writes. Memanto's own sessions are auth sessions (one live JWT per agent) and are handled by the client.                                  |
| `deleteEntry`                  | `DELETE …/memories/{id}`, permanent and idempotent. Record ids are `<memantoAgentId>:<memoryId>`, so a delete without a project still reaches the right agent.                                             |
| `exportAll`                    | `POST …/recall/all`.                                                                                                                                                                                       |
| `listSessions`                 | Not offered: Memanto has no work-session list. The Memory page shows the agent-memory panel as empty.                                                                                                      |

**Metadata in tags.** A value that fits one 64-char tag is stored as `ew:<key>=<value>`. A longer one (a GitHub
URL, a push event id) is split into up to 6 part tags `ew:<key>.<i>.<n>=<part>`. A value with characters outside the
tag-safe set (`#`, spaces, commas, non-ASCII) is base64url-encoded first (`ew:<key>.x<i>.<n>=`). A value is restored only
when every part is present, consistent and, for base64url, canonical UTF-8; anything else is dropped, never guessed.
The tag budget (20) goes to the owner stamp and the other priority keys first, then the user tags, then the provenance
keys `sourceUrl` / `sourceEventId` / `ingestedEventId` (Memory source facets and chat citations read them), then the
rest. A value whose parts do not all fit is dropped whole and logged. Keys may use only `[A-Za-z0-9_]`. Every value
is checked as a whole against Memanto's whitespace-free injection pattern (`exfiltrate`), and every part again, since
Memanto rejects a whole write over one bad tag.

**Sessions and replicas.** Memanto allows one live session token per agent, and every activate invalidates the
previous one. The client keeps the current token in the plugin cache (shared by every API replica when the cache is
Redis/Valkey), re-activates once on a 401 session error, prefers a newer token another replica already stored over
rotating it out, and adopts a renewed token from the `X-Session-Token` response header.

## Tests

**Verified against a real backend (2026-11-21):** Memanto 0.3.0 on Moorcheh on-prem `moorcheh/server:v0.1.5` with `nomic-embed-text` embeddings (Ollama, CPU), single node, internal testing:

- The live contract suite passed 5/5. The `packages/agent` facade suite passed 5/5 (agent `memory_save` / `memory_search` and run-start recall resolved to Memanto). A booted API served a brand-new user with nothing enabled (`activeProvider: memanto`), and a cross-user delete was refused with 403.
- Recall quality: paraphrased questions over 8 distinct facts found the right memory first 7/8 times and in the top 3 8/8 times. Average save took 38 ms and recall 81 ms.
- **On-prem Moorcheh ignores tag filters.** A filter on a tag no memory carries still returns matches. The plugin therefore enforces project and tag scoping itself on every recall (`keepTagged`), over-fetching to fill the limit. Without that, a shared `agentId` would leak one Work's memories into another's recall.
- **Setup trap:** `moorcheh/server` runs as uid 65532, so its `/app/data` volume must be writable by that user. Otherwise every namespace create fails with "failed persisting new namespace".

```bash
pnpm --filter @ever-works/memanto-plugin test
```

Unit tests cover the mapping, the client's session handling and the plugin class. `memanto.contract.spec.ts` runs the
real plugin against a **real Memanto server** when you point it at one:

```bash
MEMANTO_CONTRACT_URL=http://127.0.0.1:8000 MEMANTO_CONTRACT_KEY=<management key> \
  pnpm --filter @ever-works/memanto-plugin test
```

It writes only to freshly named agents. `packages/agent` has a matching facade-level suite
(`agent-memory.memanto-default.integration.spec.ts`) that checks Memanto wins the default resolution and drives an
Agent's `memory_save` / `memory_search` tools and the recall injection through it.
