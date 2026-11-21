# Ever Works directory hub

One public, read-only MCP server and JSON API across every Ever Works directory. An agent connects once and can list
the directories, search all of their items at once ("find time tracking tools", "MCP servers for databases"), read one
item in full, or call any Agent Access Contract v1 tool on one directory.

- Spec: [`docs/specs/features/directory-hub/spec.md`](../../docs/specs/features/directory-hub/spec.md)
- Plan (options, ranking, caching, rollout): [`plan.md`](../../docs/specs/features/directory-hub/plan.md)
- Decision: [ADR-019](../../docs/specs/decisions/019-directory-hub-edge-worker.md)

**Status: not deployed.** Going live (custom domain `directories.ever.works`, the registry repo) is phase 1 and waits
for the owner's go and a board claim.

## What it serves

| Path                           | What                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `POST /mcp`                    | MCP (Streamable HTTP, stateless): `list_directories`, `search_all`, `get_item`, `query_directory` |
| `GET /data/search.json?q=…`    | `search_all` as REST (`directories`, `category`, `tag`, `limit`, `per_directory`)                 |
| `GET /data/directories.json`   | Every directory with live metadata, plus the unavailable ones                                     |
| `GET /data/openapi.json`       | OpenAPI 3.1                                                                                       |
| `GET /.well-known/mcp.json`    | MCP server card                                                                                   |
| `GET /.well-known/api-catalog` | RFC 9727 API catalog (the hub and every directory)                                                |
| `GET /llms.txt`                | llmstxt.org index linking every directory                                                         |

## How it works

- The list of directories comes from a **Directory Registry** document at `REGISTRY_URL` (a catalog repo, ADR-014).
  Each entry is only an origin plus optional topics and aliases; names, descriptions and counts are read live from the
  directory's own `/data/directory.json`, which also proves it speaks Contract v1.
- `search_all` ranks one merged index built from each directory's `/data/items.json`, with the Contract v1 weights and
  one addition: a query word may be matched by the item's directory (name, topics, aliases, id), so a topic query
  surfaces that directory. Filler words such as "find", "best" or "tools" are optional.
- `query_directory` forwards one Contract v1 tool call to the directory's own `/mcp` and returns its answer unchanged.
- Caching: per isolate (10 min) and at the Cloudflare edge (registry 1 h, directory documents 15 min); a failed refresh
  serves the last good copy and retries after a minute. A directory that is down never fails a cross-directory call.
- Safety: only registry origins are fetched (tool arguments are ids, never URLs), redirects are not followed,
  every document has a byte cap, and item text is returned as data.

## Develop

```bash
pnpm --filter ever-works-directory-hub test
pnpm --filter ever-works-directory-hub type-check
pnpm --filter ever-works-directory-hub lint
```

Run it locally against any registry (no deploy, no Cloudflare account needed for `wrangler dev`):

```bash
cd apps/directory-hub
npx wrangler@4 dev --var REGISTRY_URL:https://example.com/registry.json --var HUB_URL:http://localhost:8787
```

Registry document (Directory Registry v1):

```json
{
	"version": 1,
	"name": "Ever Works directories",
	"directories": [{ "id": "crm", "url": "https://crm.ever.works", "topics": ["sales"] }]
}
```

A Contract v1 `items.json` whose items' `website` are directory origins works as a registry too.

## Deploy

Live at `https://directories.ever.works` since 2026-11-21 (Workers Custom Domain, set in `wrangler.jsonc`). The
registry is [`ever-works/directory-registry`](https://github.com/ever-works/directory-registry); to add a directory,
open a pull request there. No hub deploy is needed.

Every deploy needs a board claim (workspace `MAINTENANCE.md`). Use one of:

- the manual workflow `.github/workflows/deploy-directory-hub.yml` (GitHub-hosted; tests, then deploys, then smoke
  tests). It needs the `DIRECTORY_HUB_CLOUDFLARE_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets;
- or `npx wrangler@4 deploy` from this folder, with `CLOUDFLARE_API_TOKEN` scoped to Workers Scripts on the account
  and Workers Routes on the `ever.works` zone.

Then check `https://directories.ever.works/.well-known/mcp.json` and an MCP `tools/list`.

Rollback: `npx wrangler@4 rollback` to the previous version. To take the hub offline, remove the custom domain. The
directories are untouched either way; the hub only reads them.
