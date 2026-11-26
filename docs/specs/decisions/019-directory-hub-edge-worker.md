# ADR-019: One public directory hub, run as a Cloudflare Worker, fed by a catalog repo

## Status

**Accepted** (2026-11-21, owner approved phase 1). Spec: [`../features/directory-hub/spec.md`](../features/directory-hub/spec.md).
The hub is live at `https://directories.ever.works`, and its registry is in
[`ever-works/directory-registry`](https://github.com/ever-works/directory-registry).

## Date

2026-11-21

## Context

Every Ever Works directory exposes the Agent Access Contract v1 (a static read API under `/data/` and a read-only MCP
server at `/mcp`). An agent can only use one if it already knows its hostname. The owner wants agents to be able to ask
"find time tracking tools" or "list MCP servers for databases" against all of our directories at once, ideally over MCP,
by connecting to one place.

Facts that constrain the choice: the directories are static sites on Cloudflare Workers (`<short>.ever.works`), at mixed
template versions; `mcp.ever.works` is already the platform's authenticated, tenant-scoped MCP server; the platform has
no notion of a public or listed Work; and ADR-014 forbids keeping catalogs in the platform code.

## Decision

1. **One hub, as a Cloudflare Worker** (`apps/directory-hub`), on its own host, recommended
   `https://directories.ever.works`. It is public, read-only and needs no account.
2. **The list of directories is a catalog** (ADR-014): a Directory Registry v1 JSON document in its own repo
   (`ever-works/directory-registry`). It holds identity and opt-in only; names, descriptions and counts are read live
   from each directory's `/data/directory.json`, which also proves the directory speaks Contract v1. It lists only our
   own directories (owner, 2026-11-26), so no platform feed of other tenants' Works is planned.
3. **Cross-directory search runs on a merged index** built from each directory's static read API, cached at the edge
   and in memory, with a directory-aware ranking that reuses the Contract v1 weights. The hub never fans a query out to
   every directory's `/mcp`.
4. **Four tools**: `list_directories`, `search_all`, `get_item`, and `query_directory`, which passes one Contract v1 tool
   call through to one directory's own `/mcp`.
5. **Discovery**: the hub serves `llms.txt`, an MCP server card, an RFC 9727 API catalog and OpenAPI; `ever.works`
   points to it.

## Consequences

- Agents get one URL and stay inside the same contract vocabulary (`ItemSummary`, `ItemDetail`, Contract v1 tool names).
- The hub reads only public, already-published data and holds no secrets; a failure of the hub never affects a
  directory, and removing its custom domain rolls it back.
- This is the first Cloudflare Worker in the monorepo: it deploys with `wrangler`, not the k8s pipeline, and needs a
  Workers-scoped token in CI.
- The Contract v1 text helpers are copied into the hub until `@ever-works/agent-api` is published; tests pin the
  weights.
- Adding a directory is a pull request to the catalog repo until the platform feed exists.

## Alternatives considered

- **Tools in the platform's `apps/mcp`** — rejected: it is authenticated and tenant-scoped; anonymous tools there would
  blur its trust model, and fan-out from a k8s pod is slower than reading the directories' edge cache.
- **A route in the ever.works website** — rejected as the home of the code (couples an agent API to the marketing site);
  kept as an optional Workers route `ever.works/mcp*` to the same Worker.
- **Discovering directories by crawling or through the Cloudflare API** — rejected: subdomains cannot be enumerated,
  and an account token does not belong in a public service. Each site's `/.well-known/mcp.json` and `directory.json`
  are still used to validate registry entries.
- **Per-directory namespaced tools** (`crm_search_items`, …) — rejected: hundreds of tools swamp an agent's context; one
  pass-through tool scales.
