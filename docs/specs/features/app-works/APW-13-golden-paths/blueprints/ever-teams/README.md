# App Blueprint draft — Ever Teams

**Status:** `Draft` — seed content for the Blueprint repository `ever-works/ever-teams-template` (topic
`ever-works-app-blueprint`). **Shape:** `docs/specs/features/app-works/CONTRACTS.md` §1. **Unverified** in the sense of
the APW-13 spec §4.5: nothing here has run on a cluster yet.

Ever Teams is a web app over an Ever Gauzy API: it keeps no data of its own. This Blueprint runs the web app and asks,
at setup, which Ever Gauzy API it should use: the person's own Ever Gauzy App (`../ever-gauzy/`), or Ever's hosted
API. An App spec cannot depend on another App, so the API is named by its address.

## What this repository is

The Ever Works App Blueprint for [`ever-co/ever-teams`](https://github.com/ever-co/ever-teams), **metadata-only**: the
application's source is not in this repository.

- `.works/works.yml` — the App spec, the only file the Blueprint resolver reads and applies.
- `.works/template.yml` — this repository's shape and app source, read by the catalog.

`blueprint.sha` is a placeholder until the release workflow stamps it.

## What the Blueprint decides

- **Build:** `image`, the upstream's `ghcr.io/ever-co/ever-teams-webapp`, pinned by digest (the `latest` tag of
  2026-11-26).
- **Runtime:** one `web` component on port 3030, run as uid 1000 (the base image's `node` user; the image sets none).
  `/api/health` for the startup, readiness and liveness probes and the smoke check. `HOSTNAME=0.0.0.0`, so the
  standalone server listens on every interface.
- **The Gauzy API:** `GAUZY_API_SERVER_URL` is asked at setup and checked to be an `http(s)` origin (no path, so no
  `/api`, which the app appends itself). `NEXT_PUBLIC_GAUZY_API_SERVER_URL` stays unset, which is Ever Teams'
  **proxy mode**: the browser calls this App's own `/api` routes, and the server forwards them to the Gauzy API after
  checking the caller's token there. The Gauzy API therefore needs no address the browser can reach, and the App needs
  no cross-origin setup.
- **Secrets:** `AUTH_SECRET` (Auth.js sessions) generated once (32 random bytes, base64), never the published sample
  value.
- **Public address:** `NEXT_PUBLIC_WEB_APP_URL` follows the App's domain; a change restarts it.
- **Privacy default:** anonymous statistics off (`EVER_STATS_ENABLED=false`) until the owner turns them on.
- **Licence:** AGPL-3.0, a `green` class: managed hosting allowed, with a network source offer.

## Facts and where they were read (2026-11-26)

- Licence AGPL-3.0, default branch `develop`: repository metadata. Latest release `v0.318.2` (2026-11-25 23:24 UTC).
- Image `ghcr.io/ever-co/ever-teams-webapp`, tag `latest` resolves to index `sha256:65d340a9…7774` (linux/amd64),
  created 2026-11-25 23:48 UTC: the registry's manifest and image configuration for that tag.
- `EXPOSE 3030`, `PORT=3030`, no `USER`, working directory `/app`, command `node ./apps/web/server.js`,
  `NODE_OPTIONS=--max-old-space-size=1536`: the image configuration and `.deploy/web/Dockerfile`.
- `GET /api/health` answers `{"data":{"status":200,…},…}`: `apps/web/app/api/health/route.ts`; the upstream's own
  Kubernetes example probes it (`.deploy/ever-k8s/ever-teams-web.yaml`).
- `GAUZY_API_SERVER_URL` is the origin the server-side `/api` routes call, without `/api`; with
  `NEXT_PUBLIC_GAUZY_API_SERVER_URL` unset the browser uses those routes (proxy mode):
  `apps/web/core/constants/config/constants.tsx`, `apps/web/.env.sample`, `apps/web/core/hooks/auth/use-accept-invite.ts`.
- Auth.js trusts the forwarded host in production (`trustHost`), so no `AUTH_URL` is needed: `apps/web/auth.ts`.
- Anonymous statistics are on unless `EVER_STATS_ENABLED` is exactly `false`: `apps/web/.env.sample`.

## Unverified — resolve on the first verification run

1. Whether uid 1000 can run the server from `/app` (files copied as root) and what fails when `.next/cache` is not
   writable for it (image optimisation caches there).
2. Whether the root filesystem can be read-only (`writableRootFilesystem: false`).
3. Memory request and limit.
4. Sign-in and sign-up end to end in proxy mode against an Ever Gauzy App made from `../ever-gauzy/`, including the
   invitation e-mail links.
5. Live updates (`NEXT_PUBLIC_REALTIME_ENABLED`, off by default): in proxy mode its socket address must be given
   explicitly (`NEXT_PUBLIC_REALTIME_URL`); the Blueprint leaves the feature off.
