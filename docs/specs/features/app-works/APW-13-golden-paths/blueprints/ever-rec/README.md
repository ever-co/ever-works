# App Blueprint draft — Ever Rec

**Status:** `Draft`, **blocked for people to use** — seed content for the Blueprint repository
`ever-works/ever-rec-template` (topic `ever-works-app-blueprint`). **Shape:** `docs/specs/features/app-works/CONTRACTS.md`
§1. **Unverified** in the sense of the APW-13 spec §4.5: nothing here has run on a cluster yet.

Ever Rec, the screen recording and capture app, is two parts: a NestJS API (`ever-rec-api`) and a Next.js portal
(`ever-rec-portal`), with its data in **Firebase**. The API fits an App as it is, and `.works/works.yml` runs it. The
portal does not fit yet (see [Why the portal is not in the App yet](#why-the-portal-is-not-in-the-app-yet)), so this
Blueprint must not be published until the upstream change below lands and the portal component is added.

## What this repository is

The Ever Works App Blueprint for [`ever-co/ever-rec`](https://github.com/ever-co/ever-rec), **metadata-only**: the
application's source is not in this repository.

- `.works/works.yml` — the App spec, the only file the Blueprint resolver reads and applies.
- `.works/template.yml` — this repository's shape and app source, read by the catalog.

`blueprint.sha` is a placeholder until the release workflow stamps it.

## What the Blueprint decides

- **Build:** `image`, the upstream's `ghcr.io/ever-co/ever-rec-api`, pinned by digest (the `prod` tag of 2026-11-26,
  which the upstream builds from `main`; linux/amd64 only).
- **`api` component** (the public address until the portal joins): port 3000, uid 1000 (the image's `node`).
  `/api/v1/hello` for the probes and the smoke check. The root filesystem stays writable: the server creates
  `tmp_videos/` and `tmp_videos_fixed/` beside its build at start, and ffmpeg works in `/tmp` (scratch, no volume).
- **Addresses:** `API_BASE_URL`, `WEBSITE_URL` (the CORS origin) and `FIREBASE_REQ_URI` all follow the App's domain;
  a change restarts the App. With the portal in the App and forwarding `/api/v1`, all three stay that one address.
- **Secrets:** `REC_JWT_SECRET` (48 random bytes, base64) and `TERMS_IP_SALT` (32 random bytes, hex) are generated
  once; the API refuses to start without the first.
- **Asked at setup (group "Firebase"):** the three admin values of a service account key of the person's own Firebase
  project — `FIREBASE_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`, `FIREBASE_ADMIN_PRIVATE_KEY` (secret; the PEM block,
  `\n` escapes accepted) — and its web app config: `FIREBASE_API_KEY` (kept secret), `FIREBASE_AUTH_DOMAIN`,
  `FIREBASE_DATABASE_URL`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_APP_ID`, and optionally
  `FIREBASE_MEASUREMENT_ID`.
- **No managed dependency:** Rec stores everything in Firebase; there is no Postgres, S3 or local-disk alternative.
- **Privacy defaults:** anonymous statistics off (`EVER_STATS_ENABLED=false`); the connection to Ever Platform off (its
  default); `GAUZY_API_URL` left unset, because the upstream sample points at Ever Gauzy's production and would register
  every sign-up there.
- **Licence:** AGPL-3.0, a `green` class: managed hosting allowed, with a network source offer.

Optional integrations stay off until the owner adds their values: Postmark e-mail (`POSTMARK_CLIENT_TOKEN`,
`POSTMARK_SENDER_EMAIL`; otherwise Firebase sends the reset e-mails), Google, Dropbox, Slack, Jira, Trello, Twilio, the
video streaming services (`MUX_*`, `APIVIDEO_*`), Sentry, Segment, and Ever ID sign-in (`EVER_ID_*`).

## Why the portal is not in the App yet

1. **Its addresses are compiled in.** Every `NEXT_PUBLIC_*` value (`NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_WEBSITE_URL`,
   `NEXT_PUBLIC_STATIC_FILES_URL`, …) is a build argument of `.deploy/portal/Dockerfile`. The published `prod` image
   carries `https://api.rec.so` and `https://app.rec.so`, so an App running it would send its people to Ever's own
   Rec. The `latest` tag is older and has every value empty.
2. **Its browser code calls the API cross-origin**, at `NEXT_PUBLIC_API_BASE_URL` + `/api/v1/…`
   (`apps/portal/app/services/api/api.ts`), and the portal has no `/api` route of its own. An App has **one** public
   address (only the primary web component gets an Ingress), so the API would have no address the browser can reach.
   `next.config.js` also rewrites `/fonts/*` to a hard-coded `https://api.rec.so`.

**The upstream change that unblocks it** — the pattern Ever Teams already uses (its "proxy mode"):

- the portal reads its public settings at **run time** (an environment value served to the browser, not a build
  argument), so one published image serves any address;
- the portal forwards `/api/v1/*` and `/fonts/*` to the API **from its server**, at an address given at run time
  (`API_INTERNAL_URL`), so the browser only ever talks to the portal's own origin.

Then the portal joins this App as the primary component, on its own image (`components[].image`):

```yaml
  components:
    - name: web
      role: web
      image: ghcr.io/ever-co/ever-rec-portal@sha256:<digest of the first image with the change>
      port: 4200          # verified: EXPOSE 4200, PORT=4200 in today's image
      runAsUser: 1000     # verified: USER node in today's image
      writableRootFilesystem: true   # .next/cache
      probes: { readiness: { tcp: true } }   # no health route in today's portal; / answers 307
  env:
    - { name: API_INTERNAL_URL, from: components.api.internalUrl }
  domains:
    primaryComponent: web
```

The alternative — a platform feature routing paths of the one address to other components, plus a portal built per
App — needs more on both sides and still leaves the fonts rewrite pointing at Ever's own API.

## Facts and where they were read (2026-11-26)

- Licence AGPL-3.0, default branch `develop` (`stage` and `main` also exist), no releases or tags: repository metadata.
- Images on the registry: `ever-rec-api` and `ever-rec-portal`, tags `latest`, `dev`, `stage`, `prod` and
  `<env>-sha-<sha>`, linux/amd64 only. `prod` is built from `main` by `.github/workflows/k8s-build.yml`. On 2026-11-26
  `ever-rec-api:prod` was `sha256:7ffe2aa0…4438` and `ever-rec-portal:prod` was `sha256:3b8f9e35…529d`, whose image
  configuration carries the rec.so addresses.
- API image: `node:26.12.1-alpine`, `USER node`, working directory `/app/apps/api`, `EXPOSE 3000`,
  `CMD ["node", "dist/main"]`, files copied as `node`: `.deploy/api/Dockerfile` and the image configuration.
- Global prefix `api/v1`, `GET /api/v1/hello` answers `Hello world`, CORS origin `WEBSITE_URL`, `API_PORT` default 3000,
  the two scratch folders created unless `IS_DOCKER`: `apps/api/src/main.ts`, `apps/api/src/app.controller.ts`.
- The Firebase values: `apps/api/src/module/firebase/firebase.config.ts`; the admin three are required at start
  (`firebase.bootstrap.ts`), and the private key is a PEM string, not a key file.
- `REC_JWT_SECRET` is required at start: the API's auth module.
- Anonymous statistics are on unless `EVER_STATS_ENABLED` is exactly `false`; the connection to Ever Platform is off
  unless `EVER_CONNECT_ENABLED` is exactly `true`: `apps/api/src/common/ever-platform/env.ts`.
- Portal image: `USER node`, working directory `/app/apps/portal`, `EXPOSE 4200`, `CMD ["node", "server.js"]` (Next.js
  standalone), every `NEXT_PUBLIC_*` a build argument, the `/fonts` rewrite and the cross-origin API client:
  `.deploy/portal/Dockerfile`, `apps/portal/next.config.js`, `apps/portal/app/services/api/api.ts`.

## First cluster run

Before it: a Firebase project for the test (Firebase console) with **Realtime Database** and **Storage** turned on (and
**Firestore**, which a few API routes use — item 3 below), a **service account key** (Project settings → Service
accounts → Generate new private key) and a **web app** (Project settings → Your apps) for the web config.

1. Create an App Work from this Blueprint on a Your-cluster target, and answer the Firebase questions with that
   project's values.
2. Deploy. Expect the `hello` smoke check green and `/api/v1/hello` answering `Hello world` at the App's address.
3. Read the API's log for Firebase errors on start, and call one authenticated route to confirm the Realtime Database
   and Storage answer. Record whether Firestore must be enabled too.
4. Check that nothing reaches `api.ever.co` (statistics off) and that `GAUZY_API_URL` is unset in the running pod.
5. Measure memory while a short video is uploaded and processed, and set the request and limit from it.
6. Delete the App Work, then the test Firebase project.

Once the portal change has landed: add the portal component (above), pin its digest, and repeat with a sign-up, a
screenshot upload and a short recording through the portal.

## Unverified — resolve on the first verification run

1. The API with a fresh Firebase project: start, sign-up and upload (item 3 above), and whether Firestore is required.
2. uid 1000 writing the scratch folders beside `dist/`, and how much space video processing needs in the container.
3. Memory request and limit.
4. Everything about the portal, once it can join.
