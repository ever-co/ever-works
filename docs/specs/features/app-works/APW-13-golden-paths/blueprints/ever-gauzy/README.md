# App Blueprint draft — Ever Gauzy

**Status:** `Draft` — seed content for the Blueprint repository `ever-works/ever-gauzy-template` (topic
`ever-works-app-blueprint`). **Shape:** `docs/specs/features/app-works/CONTRACTS.md` §1. **Unverified** in the sense of
the APW-13 spec §4.5: nothing here has run on a cluster yet.

Ever Gauzy ships its API and its web interface as two images. This Blueprint runs both in one App, each component on
its own image (`components[].image`, added to the App spec for this), with a managed Postgres. The App has one public
address: the web app's, whose nginx also forwards the API's paths to the API inside the App, the same routing as the
upstream's own single-domain setups (`.deploy/caddy/Caddyfile`, `.do/deploy.template.yaml`).

Ever Teams can use an App made from this Blueprint as its Gauzy API: give the App's address to the Ever Teams
Blueprint (`../ever-teams/`).

## What this repository is

The Ever Works App Blueprint for [`ever-co/ever-gauzy`](https://github.com/ever-co/ever-gauzy), **metadata-only**: the
application's source is not in this repository.

- `.works/works.yml` — the App spec, the only file the Blueprint resolver reads and applies.
- `.works/template.yml` — this repository's shape and app source, read by the catalog.

`blueprint.sha` is a placeholder until the release workflow stamps it.

## What the Blueprint decides

- **Build:** `image`. `build.image` is the API's `ghcr.io/ever-co/gauzy-api`; the `web` component names
  `ghcr.io/ever-co/gauzy-webapp`. Both are pinned by digest (the `latest` tags of 2026-11-26).
- **`api` component** (role `web` for its Service, with no Ingress of its own): port 3000, uid 1000 (the image's
  `node:node`). Startup and liveness probes on `/api/health/live` (no dependency checks; up to 20 minutes for the
  first start, which migrates and seeds), readiness on `/api/health` (checks the database). Uploaded files live on a
  5 GiB backed-up volume at `/srv/gauzy/apps/api/public`, so it runs one replica. The volume hides the images the
  image ships in that folder (seed pictures, task icons), so the component's command copies them back from
  `apps/api/src/assets/seed` without overwriting anything, then starts as the image does.
- **`web` component** (the public address): port 4200, uid 101. The image runs as root and its nginx switches to the
  `nginx` user by name, which a pod with every capability dropped cannot do. So the component's command does what the
  image's entrypoint does (substitute the environment into the bundles with the image's `replacements.sed`), then
  starts nginx with its own configuration (`GAUZY_WEB_NGINX_CONF`), whose pid and temporary files are in `/tmp`.
  That configuration forwards `/api`, `/graphql`, `/public/…` and the Swagger pages (`/swg…`) to
  `components.api.internalUrl` (WebSocket upgrades included, `CF-Connecting-IP` dropped, as in the Caddyfile) and
  serves everything else from the Angular app.
- **One address:** `API_BASE_URL`, `CLIENT_BASE_URL` and `ALLOWED_ORIGINS` all follow the App's domain; a change
  restarts the App (the web app substitutes it into its bundles at start).
- **Database:** managed Postgres 16 (`DB_TYPE=postgres` and `DB_*` from the dependency; the image's default is
  SQLite). Redis is off (`REDIS_ENABLED=false`); `works.yml` shows how to add Redis and the worker image.
- **Secrets:** `JWT_SECRET`, `JWT_REFRESH_TOKEN_SECRET`, `JWT_VERIFICATION_TOKEN_SECRET` and
  `EXPRESS_SESSION_SECRET` are generated once (64 random bytes, hex), as the API requires.
- **First accounts:** the first start seeds a Super Admin, an Admin and an Employee and refuses default passwords.
  The Super Admin's e-mail and password are asked at setup (12 to 50 characters); the other two get generated
  passwords that nobody is shown.
- **Proxies:** `TRUST_PROXY=2` (the cluster's ingress, then the web app's nginx).
- **Memory:** `NODE_OPTIONS=--max-old-space-size=1536`, since the image sets a 12 GiB heap ceiling.
- **Privacy default:** anonymous statistics off (`EVER_STATS_ENABLED=false`) until the owner turns them on.
- **Licence:** AGPL-3.0, a `green` class: managed hosting allowed, with a network source offer.

## Facts and where they were read (2026-11-26)

- Licence AGPL-3.0, default branch `develop`: repository metadata.
- Images, tag `latest` (linux/amd64 indexes): `gauzy-api` `sha256:ffa2be9b…3d8e`, `gauzy-webapp` `sha256:9757fbe2…02e0`,
  `gauzy-worker` `sha256:e4d2c6a0…9697`, all built 2026-10-29: the registry's manifests and image configurations.
- API image: `USER node:node`, working directory `/srv/gauzy`, `EXPOSE 3000`, entrypoint `./entrypoint.prod.sh`
  running `node main.js`, `DB_TYPE=better-sqlite3` and `NODE_OPTIONS=--max-old-space-size=12288` by default: the image
  configuration and `.deploy/api/Dockerfile`.
- Web image: `nginx:alpine` with no `USER`, `user nginx;` in its configuration, `listen 4200`, root `/srv/gauzy`, the
  bundles rewritten at start from `replacements.sed` (files owned by `nginx`): `.deploy/webapp/Dockerfile`,
  `.deploy/webapp/entrypoint.prod.sh`, `.deploy/webapp/nginx.prod.conf`.
- The single-domain routing (`/api`, `/api/*`, `/graphql`, `/public/*`, `/swg`, `/swg/*`, `/swg-json`, `/swg-yaml` to
  the API) and `API_BASE_URL` = `CLIENT_BASE_URL` = `ALLOWED_ORIGINS` = the public address: `.deploy/caddy/Caddyfile`,
  `docker-compose.caddy.yml`, `.do/deploy.template.yaml`.
- Uploads under `/srv/gauzy/apps/api/public` and served at `<API_BASE_URL>/public/…`; the seed images copied into that
  folder at build time: `apps/api/src/plugin.config.ts`, the local file provider, `.deploy/api/Dockerfile`.
- `GET /api/health` checks the database; `GET /api/health/live` checks only the process and answers
  `{"status":"ok",…}`: `packages/core/src/lib/health/health.controller.ts`, `health.service.ts`.
- The four secrets and the three seed passwords are refused when unset or default in production: `README.md`
  ("Production"), `.env.caddy.sample`, `packages/config/src/lib/environments/environment.prod.ts`.
- The pgvector migration is guarded and falls back to text search when the extension is unavailable:
  `packages/core/src/lib/database/migrations/1790000002000-AddDocumentChunkVector.ts`.
- Anonymous statistics are on unless `EVER_STATS_ENABLED` is exactly `false`:
  `packages/plugins/ever-stats/src/lib/ever-stats-enabled.ts`.

## Unverified — resolve on the first verification run

1. The `web` command end to end as uid 101: the bundles rewritten in place, nginx started from `/tmp/nginx.conf`
   (its compiled-in log path is a link to stderr in `nginx:alpine`), and the forwarding of each API path, including
   GraphQL subscriptions over WebSocket.
2. The `api` command: the seed images copied onto the volume (its group is the platform's `fsGroup`), and whether the
   API writes anything else under `/srv/gauzy` (`ormlogs.log`) once the root filesystem is read-only.
3. The database: the App's Postgres user creating `uuid-ossp` (a trusted extension from Postgres 13), and
   `DB_SSL_MODE` against each Postgres provider (the operator's speaks TLS).
4. `TRUST_PROXY=2`: that rate limits count the client's address, not the ingress's.
5. The first start: migrations and seeding inside the 20-minute startup window, and sign-in as the Super Admin.
   Sign-up stays open (the upstream's default) unless the owner sets `APP_USER_REGISTRATION` and
   `ALLOW_TENANTS_REGISTRATION` to `false`.
6. Memory requests and limits of both components.
7. Redis and the worker, when turned on.
