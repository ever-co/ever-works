# App Blueprint draft — Ever Traduora

**Status:** `Draft` — seed content for the Blueprint repository `ever-works/ever-traduora-template` (topic
`ever-works-app-blueprint`). **Shape:** `docs/specs/features/app-works/CONTRACTS.md` §1. **Unverified** in the sense of
the APW-13 spec §4.5: nothing here has run on a cluster yet.

Ever Traduora is the Ever product that fits an App spec as it stands: one container from the upstream's own published
image, its database a SQLite file on a volume, no App dependency. It is the first of the Ever products' Blueprints.

## What this repository is

The Ever Works App Blueprint for [`ever-co/ever-traduora`](https://github.com/ever-co/ever-traduora), **metadata-only**:
the application's source is not in this repository.

- `.works/works.yml` — the App spec, the only file the Blueprint resolver reads and applies.
- `.works/template.yml` — this repository's shape and app source, read by the catalog.

`blueprint.sha` is a placeholder until the release workflow stamps it.

## What the Blueprint decides

- **Build:** `image`, the upstream's `ghcr.io/ever-co/ever-traduora`, pinned by digest (the `prod` tag of 2026-11-20).
- **Runtime:** one `web` component on port 8080, run as uid 1000 (the base image's `node` user; the image sets none).
  `/health` for the startup, readiness and liveness probes and the smoke check.
- **Database:** SQLite (`TR_DB_TYPE=better-sqlite3`, the image's default engine) in `/data/traduora.sqlite3` on a 1 GiB
  backed-up volume; one replica, since SQLite has one writer. The server migrates on start.
- **Secrets:** `TR_SECRET` generated once (32 random bytes, hex), never a published example value.
- **Public address:** `TR_VIRTUAL_HOST` follows the App's domain (links in invitation e-mails); a change restarts it.
- **Memory:** `NODE_OPTIONS=--max-old-space-size=768`, since the image sets a 12 GiB heap ceiling.
- **Privacy default:** anonymous statistics off (`TR_EVER_STATS_ENABLED=false`) until the owner turns them on; the
  connection to Ever Platform stays off as in the image (`TR_EVER_CONNECT_ENABLED` unset).
- **Licence:** AGPL-3.0, a `green` class: managed hosting allowed, with a network source offer.

## Facts and where they were read (2026-11-20)

- Licence AGPL-3.0, default branch `develop`, API version 0.24.0: repository metadata and `api/package.json`.
- Image `ghcr.io/ever-co/ever-traduora`, tag `prod` resolves to index `sha256:f1431ecc…c7b3` (linux/amd64): the
  registry's manifest for that tag.
- `EXPOSE 8080`, no `USER`, working directory `/opt/traduora`, entrypoint `./docker-entrypoint.sh` which runs
  `node src/main.js`: the image configuration and `docker-entrypoint.sh`.
- `NODE_OPTIONS=--max-old-space-size=12288` in the image: the image configuration and the `Dockerfile`.
- The server listens on `0.0.0.0` and `TR_PORT` (default 8080): `api/src/main.ts`, `api/src/config.ts`.
- `TR_DB_TYPE` defaults to `better-sqlite3`, `TR_DB_DATABASE` is the file, `TR_DB_AUTOMIGRATE` defaults to true:
  `api/src/config.ts`.
- `TR_SECRET` is required in production and published example values are refused: `api/src/config.ts`.
- `GET /health` answers `{"status":"ok","version":…}`: `api/src/controllers/health.controller.ts`.
- Anonymous statistics are on unless `TR_EVER_STATS_ENABLED` is exactly `false`; the connection is off unless
  `TR_EVER_CONNECT_ENABLED` is exactly `true`: `api/src/config.ts`.

## Unverified — resolve on the first verification run

1. Whether uid 1000 can write the volume (the platform's `fsGroup`) and read `/opt/traduora` (files copied as root).
2. Whether the root filesystem can be read-only (`writableRootFilesystem: false`).
3. Memory request and limit.
4. The first administrator: Traduora lets anyone sign up while `TR_SIGNUPS_ENABLED` is true (its default). A prompted
   first account and signups closed after it would need a first-deploy job against the API.

## The other Ever products

Ever Gauzy (`../ever-gauzy/`) and Ever Teams (`../ever-teams/`) have Blueprints too. Ever Gauzy ships its API and its
web interface as two images, which an App spec runs since components may name their own image
(`components[].image`, with `build.strategy: image`). Ever Teams is one web image over a Gauzy API that the person
names at setup. Ever Rec (`../ever-rec/`) is a draft blocked on an upstream change: its portal image has its
addresses compiled in and calls the API cross-origin.
