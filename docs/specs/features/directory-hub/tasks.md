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

- [x] T-10 Owner answers the open questions in [`spec.md`](./spec.md) §8. Address and registry repo: the phase 1 go
      (2026-11-21). On 2026-11-26: only our own directories, the MCP-servers directory exists (4,232 items), no catalog
      listing yet, log zero-result queries only.
- [x] T-11 Create `ever-works/directory-registry` (README, CONTRIBUTING, MIT, `registry.json`, a validate workflow per
      ADR-014), seeded with the 100 directories and the older ones. Done 2026-11-21: 115 entries (100 + `timetrack` +
      14 older Works with sites).
- [x] T-12 Add the custom domain to `apps/directory-hub/wrangler.jsonc`, set `REGISTRY_URL`, deploy with a Workers-scoped
      token; confirm sibling-Worker fetches work on the zone (plan §7). Done 2026-11-21: same-zone fetches work.
- [x] T-13 Live checks: MCP Inspector, the two example questions, `/data/search.json`, every discovery document (plan §0,
      "Phase 1 live"). Not run: connecting Claude itself (`claude mcp add --transport http ever-works https://directories.ever.works/mcp`).
- [x] T-14 ever-works-website: `/llms.txt` section and `/.well-known/mcp.json` + `/.well-known/api-catalog` pointing to the hub.
      PR [ever-co/ever-works-website#322](https://github.com/ever-co/ever-works-website/pull/322), merged 2026-11-21. Live
      (checked 2026-11-26): all three answer 200, and the catalog is served as `application/linkset+json`.
- [ ] T-15 Deploy workflow for the Worker (manual dispatch first). The workflow is
      `.github/workflows/deploy-directory-hub.yml` (environment `directory-hub`, `main` only). Since 2026-11-21 19:15Z
      the environment exists with deployment branches limited to `main`, and holds the `DIRECTORY_HUB_CLOUDFLARE_TOKEN`
      (owner: reuse the scoped deploy token) and `CLOUDFLARE_ACCOUNT_ID` secrets. Left: the first run, once this PR
      reaches `main`.
- [x] T-16 Hardening after the phase 1 code review (2026-11-21):
    - query caps: 12 words, no one-letter words;
    - word-prefix directory matching;
    - a 64 KB request body cap and an 8 KB cap on forwarded arguments;
    - shared loads kept alive with `waitUntil`;
    - a 4 MB `items.json` cap, descriptions cut to 2,000 characters, http(s)-only links;
    - unknown slugs answered from the item list, and timeouts reported as tool errors;
    - at most 400 registry entries (the subrequest budget).

- [x] T-17 Log the text of zero-result queries only (`zero_result_query`), per the owner's 2026-11-26 decision. Not
      logged: searches narrowed by `directories`/`category`/`tag`, searches that read no directory, and `list_directories`
      while no directory is available (`available_count: 0`). Workers Logs invocation
      logs are off (they stored caller IPs and location), and `/data/search.json` writes no line for a search with
      results.
- [x] T-18 Roll the template to the 15 older sites (`timetrack`, `mcpserver`, `vectordb`, `dir`, …; template `classic`,
      deploy provider `k8s`), done 2026-11-26. Their website repos got template `f52bb1d6` (with the agent API,
      directory-web-template#1181) on 2026-11-21, and the in-cluster `ci-builds` poller rebuilt `:prod` from it (GitHub
      Actions is off on these repos, so GitHub shows no runs). The sites still served the old build because these Works
      deploy server-side with the image pinned by digest (`DeployService.deployServerSideManaged`, `pinImageDigest`), and
      neither the template poller nor a build redeploys them. Fix: one platform redeploy per Work
      (`POST /api/deploy/works/:id`), plus a hand rebuild of `sustainable-fashion-website` `main`, whose 11-21 build had
      failed. Every site now answers `/data/directory.json`, `/data/items.json`, `/data/items/{slug}.json`,
      `/.well-known/mcp.json` and `OPTIONS /mcp`. `timetrack` names its canonical domain `https://timetrack.works`, so
      its registry entry moved there (ever-works/directory-registry#1). Open: the platform reports `itemsCount: 6` for
      Work `awesome-mcp-servers`, while the site lists 4,239 items.

## Phase 2

- [ ] T-20 Contract v1.1: optional `network: { name, url, mcp }` in `DirectoryInfo`, an `llms.txt` line and a card field,
      in both templates (minimal and full), so every directory points to the hub.
- [ ] ~~T-21 Platform: forward-only migration adding a "list in the directory hub" flag to Work, a settings toggle, and
      `GET /api/public/directories`.~~ Dropped: the hub lists only our own directories (owner, 2026-11-26).
- [ ] T-22 Optional `ever.works/mcp*` Workers route to the same Worker.
- [ ] T-23 Cron Trigger + KV merged index, if cold-isolate latency or memory needs it.
- [ ] T-24 Publish `@ever-works/agent-api` to npm and drop the helper copy in `src/contract.ts`.

## Phase 3

- [ ] T-30 Official MCP Registry entry (`server.json`, remote `streamable-http`) and other catalogs. Owner 2026-11-26:
      not yet.
- [ ] T-31 Optional semantic search (Workers AI embeddings + Vectorize).
- [ ] T-32 Optional human "all directories" page (design rule, `unslop`).
