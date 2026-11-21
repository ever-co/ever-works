# Tasks: Directory Hub

**Feature ID**: `directory-hub`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Last updated**: 2026-11-21

## Phase 0 — spec and code (this PR, nothing deployed)

- [x] T-01 Spec, plan, tasks and [ADR-019](../../decisions/019-directory-hub-edge-worker.md).
- [x] T-02 `apps/directory-hub`: registry parsing (Registry v1 and Contract v1 `items.json`), FR-1 to FR-6.
- [x] T-03 Loader: bounded concurrency, timeouts, size caps, isolate and edge caching, last known good, FR-21 to FR-23.
- [x] T-04 Directory-aware ranking and the four tools, FR-8 to FR-15.
- [x] T-05 MCP transport with the Contract v1 rules, FR-7.
- [x] T-06 REST twins and discovery documents, FR-16 to FR-18.
- [x] T-07 Unit tests with fixture directories (time tracking, CRM, MCP servers, one down, one old build).

## Phase 1 — go live (owner's go + board claim)

- [ ] T-10 Owner answers the open questions in [`spec.md`](./spec.md) §8. Address and registry repo: answered by the
      phase 1 go (2026-11-21); tenants opt-in, the MCP-servers directory, catalogs and analytics are still open.
- [x] T-11 Create `ever-works/directory-registry` (README, CONTRIBUTING, MIT, `registry.json`, a validate workflow per
      ADR-014), seeded with the 100 directories and the older ones. Done 2026-11-21: 115 entries (100 + `timetrack` +
      14 older Works with sites).
- [x] T-12 Add the custom domain to `apps/directory-hub/wrangler.jsonc`, set `REGISTRY_URL`, deploy with a Workers-scoped
      token; confirm sibling-Worker fetches work on the zone (plan §7). Done 2026-11-21: same-zone fetches work.
- [x] T-13 Live checks: MCP Inspector, the two example questions, `/data/search.json`, every discovery document (plan §0,
      "Phase 1 live"). Not run: connecting Claude itself (`claude mcp add --transport http ever-works https://directories.ever.works/mcp`).
- [ ] T-14 ever-works-website: `/llms.txt` section and `/.well-known/mcp.json` + `/.well-known/api-catalog` pointing to the hub.
      PR [ever-co/ever-works-website#322](https://github.com/ever-co/ever-works-website/pull/322), not merged yet.
- [ ] T-15 Deploy workflow for the Worker (manual dispatch first) with the token in repository secrets. The workflow is
      `.github/workflows/deploy-directory-hub.yml`; the `DIRECTORY_HUB_CLOUDFLARE_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
      secrets are not set yet (owner to choose the token).

## Phase 2

- [ ] T-20 Contract v1.1: optional `network: { name, url, mcp }` in `DirectoryInfo`, an `llms.txt` line and a card field,
      in both templates (minimal and full), so every directory points to the hub.
- [ ] T-21 Platform: forward-only migration adding a "list in the directory hub" flag to Work, a settings toggle, and
      `GET /api/public/directories`; the hub merges it with the catalog repo.
- [ ] T-22 Optional `ever.works/mcp*` Workers route to the same Worker.
- [ ] T-23 Cron Trigger + KV merged index, if cold-isolate latency or memory needs it.
- [ ] T-24 Publish `@ever-works/agent-api` to npm and drop the helper copy in `src/contract.ts`.

## Phase 3

- [ ] T-30 Official MCP Registry entry (`server.json`, remote `streamable-http`) and other catalogs (owner's go).
- [ ] T-31 Optional semantic search (Workers AI embeddings + Vectorize).
- [ ] T-32 Optional human "all directories" page (design rule, `unslop`).
