# Feature Specification: Directory Hub (one MCP server for every Ever Works directory)

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> The options considered and the reasoning behind the recommended default are in [`plan.md`](./plan.md) §1 and
> [ADR-019](../../decisions/019-directory-hub-edge-worker.md).

**Feature ID**: `directory-hub`
**Branch**: `feat/directory-hub`
**Status**: `In Progress` (phase 1 live at `https://directories.ever.works` since 2026-11-21)
**Created**: 2026-11-21
**Last updated**: 2026-11-21
**Owner**: Ever Works Team

---

## Decisions at a glance

The owner approved phase 1 on 2026-11-21, which settles the public address and the catalog repo. The other rows are
still recommended defaults.

| Question                 | Recommended default                                                                                                                       | Alternatives kept open                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Where the hub runs       | One **Cloudflare Worker** (`apps/directory-hub`), next to the directory sites                                                             | Platform API / `apps/mcp`; a route in the ever.works website                                               |
| Public address           | **`https://directories.ever.works/mcp`** (`mcp.ever.works` is already the platform's authenticated MCP server)                            | `https://ever.works/mcp` through a Workers route on the apex (phase 2, same Worker)                        |
| How it finds directories | A **Directory Registry** JSON document kept in its own catalog repo (ADR-014), each entry checked live against its `/data/directory.json` | A "directory of directories" Work. (A platform feed of other tenants' Works: not wanted, owner 2026-11-26) |
| How it searches          | A merged index built from each directory's **static read API** (`/data/*.json`), cached at the edge and in memory                         | Fan-out to every directory's `/mcp` per query (rejected: slow, N× load)                                    |
| Tools                    | `list_directories`, `search_all`, `get_item`, `query_directory` (pass-through to one directory)                                           | Namespaced per-directory tools (rejected: hundreds of tools)                                               |
| Discovery                | Hub serves `llms.txt`, `/.well-known/mcp.json`, `/.well-known/api-catalog`, OpenAPI; **ever.works** points to the hub                     | Listing in the official MCP Registry and other catalogs (phase 3, owner's go)                              |

---

## 1. Overview

Every Ever Works directory (for example `crm.ever.works` or `timetrack.ever.works`) already exposes the
[Agent Access Contract v1](https://github.com/ever-works/directory-web-minimal-template/blob/develop/.specify/features/agent-access.md):
a static read API under `/data/` and a read-only MCP server at `/mcp`. An AI agent can only use them if it already knows
which directory to ask. The **Directory Hub** is one public, read-only, no-account MCP server and JSON API that spans
every listed directory. An agent connects once, to `https://directories.ever.works/mcp`, and can list the directories,
search all of their items at once ("find time tracking tools", "MCP servers for databases"), read one item in full, and
call any Contract v1 tool on one directory, all without knowing a single directory hostname. `ever.works` itself tells
agents where the hub is.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** an agent configured with only `https://directories.ever.works/mcp`, **when** it calls `search_all` with
  `{ "query": "time tracking tools" }`, **then** it gets the time tracking directory's items first, each one carrying
  its directory (`id`, `name`, `url`) and its own item page URL to cite.
- **Given** an agent asked to "list MCP servers for databases", **when** it calls `search_all` with
  `{ "query": "MCP servers for databases" }`, **then** the results are items from directories about MCP servers whose
  own fields match "databases", ranked above items that only mention one of the words.
- **Given** an agent that wants to browse, **when** it calls `list_directories` with `{ "query": "email" }`, **then** it
  gets the matching directories (for example transactional email, email marketing), each with its item count, its own
  MCP URL and its `llms.txt`.
- **Given** a search result, **when** the agent calls `get_item` with `{ "directory": "crm", "slug": "hubspot" }`,
  **then** it gets that item's full Contract v1 `ItemDetail`, Markdown write-up included.
- **Given** an agent that needs a Contract v1 tool on one directory, **when** it calls `query_directory` with
  `{ "directory": "crm", "tool": "list_categories" }`, **then** it gets the same result that `crm.ever.works/mcp` returns
  for that call.
- **Given** an agent or tool without MCP support (a ChatGPT Action, a script, `curl`), **when** it requests
  `GET /data/search.json?q=crm`, **then** it gets the same result as `search_all`, described by `/data/openapi.json`.
- **Given** an agent that starts from `https://ever.works`, **when** it reads `/llms.txt` or `/.well-known/mcp.json`,
  **then** it finds the hub's MCP URL and its data endpoints.
- **Given** a new directory goes live and is added to the registry, **when** the hub's registry cache expires (at most
  one hour), **then** the directory is listed and searchable with no hub deploy.

### 2.2 Edge cases & failures

- **Given** one directory is down or slow, **when** an agent calls `search_all`, **then** the call still answers from
  the other directories within the time budget and names the missing directory in `unavailable`.
- **Given** a directory still runs an old build without `/data/directory.json`, **when** the hub refreshes, **then** the
  directory is reported as unavailable ("no Agent Access Contract v1") and joins automatically once it is upgraded.
- **Given** the registry cannot be fetched, **when** the hub has a previous copy, **then** it keeps serving that copy;
  with no copy at all it answers with a generic error, never a stack trace or an upstream URL.
- **Given** an agent passes an unknown directory id, **when** it calls `get_item` or `query_directory`, **then** it gets a
  tool error (`isError: true`) that tells it to call `list_directories`.
- **Given** an agent passes a URL, a path or a hostname that is not in the registry as `directory`, **when** the hub
  resolves it, **then** nothing is fetched and the call fails as an unknown directory.
- **Given** a query made only of filler words ("find tools"), **when** `search_all` runs, **then** the words are still
  matched (none are dropped when nothing else is left) and an empty result carries a hint to name the topic.
- **Given** an item description contains text aimed at the agent ("ignore your instructions…"), **when** the hub returns
  it, **then** it is returned as data only, and the server instructions say that item text is third-party content.
- **Given** a directory serves an oversized or malformed document, **when** the hub reads it, **then** the document is
  rejected and the directory is reported unavailable for that refresh.
- **Given** the registry lists a directory with `"listed": false`, **when** any tool or endpoint runs, **then** that
  directory appears nowhere.

## 3. Functional Requirements

### Registry and directory discovery

- **FR-1** The hub MUST read its list of directories from a Directory Registry document at a configured URL; the list
  MUST NOT be part of the hub's source code (ADR-014).
- **FR-2** The hub MUST accept as its registry either a Directory Registry v1 document (§5) or a Contract v1
  `items.json` whose items' `website` values are directory origins (a "directory of directories").
- **FR-3** The hub MUST ignore registry entries whose URL is not an `https:` origin, and entries with duplicate ids
  after the first.
- **FR-4** The hub MUST treat a directory as available only when its `/data/directory.json` is a Contract v1
  `DirectoryInfo` (`version: 1`) whose `url` has the same origin as the registry entry.
- **FR-5** Live metadata from `directory.json` (name, description, counts, endpoints) MUST take precedence over the
  registry's fallback fields.
- **FR-6** A registry entry with `"listed": false` MUST NOT appear in any tool result, document or endpoint.

### MCP server

- **FR-7** The hub MUST serve MCP over Streamable HTTP at `/mcp` with the transport rules of Contract v1 (stateless,
  JSON responses, `POST` only, `GET` → `405`, `OPTIONS` → `204`, CORS `*`, notifications → `202`, protocol version
  negotiation over the same four revisions, `MCP-Protocol-Version` header check, no batches).
- **FR-8** The hub MUST expose exactly the tools `list_directories`, `search_all`, `get_item` and `query_directory`;
  their names and input schemas form the Hub Contract v1 (see [`plan.md`](./plan.md) §4).
- **FR-9** `search_all` MUST rank items with the directory-aware ranking of [`plan.md`](./plan.md) §5, so a query that
  names a directory's topic surfaces that directory's items.
- **FR-10** Every item `search_all` returns MUST carry its directory's `id`, `name` and `url`, plus the item's absolute
  page URL on that directory.
- **FR-11** `search_all` MUST cap results per directory (`per_directory`) and overall (`limit`), and MUST report how many
  directories it searched and which were unavailable.
- **FR-12** `get_item` MUST return the directory's `/data/items/{slug}.json` document and MUST reject slugs that contain
  anything but letters, digits, `.`, `_` and `-`.
- **FR-13** `query_directory` MUST accept only Contract v1 tool names and MUST return what that directory's own `/mcp`
  returns for the call.
- **FR-14** When a directory has no `/mcp` (`endpoints.mcp` is `null`), `query_directory` MUST answer
  `get_directory_info`, `list_categories` and `list_tags` from the directory's read API, and MUST return a tool error
  that points to `search_all` for the other tools.
- **FR-15** All hub tools MUST be annotated read-only and idempotent.

### REST API and discovery documents

- **FR-16** `GET /data/directories.json` MUST list every available directory with its live metadata and the ids of the
  unavailable ones.
- **FR-17** `GET /data/search.json` MUST run `search_all` from query parameters (`q`, `directories`, `category`, `tag`,
  `limit`, `per_directory`) and return the same body as the tool's structured result.
- **FR-18** The hub MUST serve `/data/openapi.json` (OpenAPI 3.1), `/.well-known/mcp.json` (an MCP server card with the
  same shape as a directory's), `/.well-known/api-catalog` (RFC 9727, one entry for the hub and one per available
  directory), `/llms.txt` (llmstxt.org, with a section that links every available directory) and `/robots.txt`.
- **FR-19** `ever.works` MUST point agents to the hub from its `/llms.txt` and `/.well-known/mcp.json`.
- **FR-20** Each directory SHOULD point agents to the hub from its `llms.txt` and `DirectoryInfo` (a Contract v1.1
  additive field), so an agent that lands on one directory learns about the others.

### Caching, resilience and safety

- **FR-21** The hub MUST cache each directory's documents at the edge and in memory (default 15 and 10 minutes) and the
  registry for one hour, and MUST keep serving the last good copy when a refresh fails.
- **FR-22** A directory that fails or times out MUST NOT fail a call that spans several directories.
- **FR-23** The hub MUST NOT fetch any URL that is not built from a registry origin; no tool or endpoint takes a URL.
- **FR-24** The hub MUST NOT require authentication, set cookies or store request bodies.

## 4. Non-Functional Requirements

- **Performance**: `search_all` P95 under 300 ms when warm; under 3 s on a cold isolate with 100 directories;
  per-directory fetch timeout 4 s.
- **Scale**: v1 holds the merged index in isolate memory and targets up to ~300 directories / ~60k items. Beyond that,
  phase 2 builds the index on a schedule (see [`plan.md`](./plan.md) §6).
- **Cost**: runs on the Workers Paid plan the directory sites already use; data reads hit the directories' edge cache.
- **Security & privacy**: public, read-only data; no secrets in the hub; strict size caps per document; untrusted
  third-party text is returned as data; logs carry tool name, counts and timing. The text of a query is logged only
  when it matched nothing (owner decision 2026-11-26). Workers Logs keeps only the hub's own lines: invocation logs are
  off (`observability.logs.invocation_logs: false`), because they store each caller's IP (`cf-connecting-ip`,
  `x-real-ip`), location and request URL. Cloudflare attaches the method, path and URL to every line the hub writes, so
  `/data/search.json` writes a line only for a zero-result search. Lines age out with the Workers Logs retention and are
  not exported.
- **Observability**: one structured log line per tool call (tool, directories searched, unavailable count, result count,
  duration) visible in Workers Logs.
- **Compatibility**: any directory that implements Contract v1 (minimal and full templates); MCP protocol revisions
  `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`.

## 5. Key Entities & Domain Concepts

| Entity / concept        | Description                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Directory Registry v1   | JSON document `{ version: 1, directories: DirectoryEntry[] }`; the list of directories the hub spans. Lives outside the platform monorepo.    |
| Directory entry         | `{ id, url, name?, description?, topics?, aliases?, listed? }`: identity plus opt-in. `id` is stable (`[a-z0-9-]`); `url` is an HTTPS origin. |
| Available / unavailable | A directory is available when its live `directory.json` passes FR-4; otherwise it is unavailable with a short reason.                         |
| Hub item                | A Contract v1 `ItemSummary` plus `directory: { id, name, url }` and the ranking `score`.                                                      |
| Hub Contract v1         | The four tool names and input schemas, the REST twins and the discovery documents; versioned like Contract v1.                                |
| Directory-aware ranking | Contract v1 item scoring, where a query word may also be matched by the item's directory (name, topics, aliases, description).                |

## 6. Out of Scope

- Writes of any kind: submissions stay on each directory's Submit page.
- Authentication, private or tenant-only directories.
- Semantic or embedding search (v1 is lexical; a Vectorize/Workers AI index is a possible phase 3).
- A human-facing website: `/` redirects to `/llms.txt`. A browsable "all directories" page would be frontend work under
  the design rule and is a separate decision.
- Crawling hosts that are not in the registry, and listing Cloudflare zones or DNS to find directories.
- No logging of the text of queries that matched something, and no analysis of callers (owner decision 2026-11-26:
  zero-result queries only).

## 7. Acceptance Criteria

- [ ] `initialize` and `tools/list` on `/mcp` return the four tools, and the transport rules of FR-7 hold (tests).
- [ ] With fixture directories "Time Tracking", "CRM", "MCP Servers" and "Managed Databases",
      `search_all("time tracking tools")` puts the time tracking directory's items first, and
      `search_all("MCP servers for databases")` puts the MCP servers that match "databases" first and leaves out the
      MCP servers that do not (tests).
- [ ] A directory that times out, answers 404 or returns an oversized body is reported in `unavailable` and the call
      still succeeds (tests).
- [ ] `get_item` rejects a slug with `/` or `..`, and `query_directory` rejects a tool outside Contract v1 (tests).
- [ ] `directory` values that are URLs or unknown ids never cause a fetch (test asserts the fetch log).
- [ ] `/data/search.json`, `/data/directories.json`, `/data/openapi.json`, `/.well-known/mcp.json`,
      `/.well-known/api-catalog`, `/llms.txt` and `/robots.txt` answer with the documented shapes (tests).
- [ ] After deploy (phase 1): MCP Inspector and Claude can connect to `https://directories.ever.works/mcp` and answer the
      two example questions from live directories.
- [x] After the ever.works change (phase 1): `https://ever.works/llms.txt` and `https://ever.works/.well-known/mcp.json`
      name the hub.
- [ ] All functional requirements have a passing unit test or a recorded live check.

## 8. Open Questions

- Resolved 2026-11-21 (owner approved phase 1): the address is `https://directories.ever.works`, and the registry
  lives in the catalog repo [`ever-works/directory-registry`](https://github.com/ever-works/directory-registry).
  `ever.works/mcp` through a Workers route on the apex stays a phase 2 option.
- Resolved 2026-11-26 (owner): the hub lists **only our own directories**, kept in the registry repo. Works of other
  tenants do not join it, so the platform opt-in flag and feed (plan R2, task T-21) are dropped.
- Resolved 2026-11-26 (owner): the MCP-servers directory already exists. `mcpserver.ever.works` (Work
  `awesome-mcp-servers`) lists **4,232 items**; the platform API's `itemsCount` of 6 for that Work was wrong and misled
  the 2026-11-21 notes. Like `timetrack` and 13 other older sites, it only needed a redeploy onto its current template
  (`f52bb1d6`, which contains the agent API). Done 2026-11-26 (task T-18): the hub reads it, 4,239 items.
- Resolved 2026-11-26 (owner): **not yet** listed in the official MCP Registry or other catalogs; agents find the hub
  through `ever.works/llms.txt` and `/.well-known/`.
- Resolved 2026-11-26 (owner): the hub logs the text of **zero-result queries only** (`zero_result_query` in the
  log entry of `search_all`, `list_directories` and `/data/search.json`), to show which directories are missing.

## 9. Constitution Gates

- [x] Plugin-first if introducing an external integration (Principle I): not applicable, the hub is a standalone edge
      service that reads public Ever Works sites; it adds no integration to the platform.
- [x] Capability-driven resolution (Principle II): not applicable, no cross-plugin behaviour.
- [x] Source-of-truth repos preserved (Principle III): the hub only reads each directory's published data; the
      directory list lives in its own catalog repo (ADR-014).
- [x] Long-running work via Trigger.dev (Principle IV): not applicable, request-scoped work only; a scheduled index
      build (phase 2) would be a Workers Cron Trigger, outside the platform.
- [x] Schema changes ship as forward-only migrations (Principle V): no schema change in v1; the phase 2 opt-in flag on
      Works ships as a forward-only migration.
- [x] Tests accompany the change (Principle VI): `apps/directory-hub/test/`.
- [x] Secrets handled per `x-secret` rules (Principle VII): the hub holds no secrets; deploy credentials stay in CI.
- [x] Plugin counts touch the canonical doc only (Principle VIII): not applicable.
- [x] Behaviour-first, no implementation in this spec (Principle IX): implementation is in `plan.md`.
- [x] Backwards-compatible API/SDK/schema changes (Principle X): new service; Contract v1 is unchanged, and the
      directory-side `network` pointer (FR-20) is additive.

## 10. References

- Agent Access Contract v1:
  [`.specify/features/agent-access.md`](https://github.com/ever-works/directory-web-minimal-template/blob/develop/.specify/features/agent-access.md)
  (minimal template) and its reference implementation
  [`packages/agent-api`](https://github.com/ever-works/directory-web-minimal-template/tree/develop/packages/agent-api);
  the full template's version is ever-works/directory-web-template#1181.
- Related features: [`mcp-server`](../mcp-server/spec.md) (the platform's authenticated MCP at `mcp.ever.works`).
- Related ADRs: [ADR-014 no hard-coded catalogs](../../decisions/014-no-hardcoded-catalogs.md),
  [ADR-019 directory hub as an edge Worker](../../decisions/019-directory-hub-edge-worker.md).
- Plan and tasks: [`plan.md`](./plan.md), [`tasks.md`](./tasks.md).
- Code: [`apps/directory-hub`](https://github.com/ever-works/ever-works/tree/develop/apps/directory-hub).
