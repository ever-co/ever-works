# Per-Work runtime env — allow-listed env vars for deployed directories

> Companion to [`docs/features/k8s-deployment.md`](../features/k8s-deployment.md)
> (how a Work reaches the cluster) and
> [`docs/specs/features/work-db-storage-and-subdomains/design.md`](../specs/features/work-db-storage-and-subdomains/design.md)
> (the `DATABASE_URL` / shared-DB half of the same endpoint).
> Code: `packages/agent/src/services/work-runtime-env.service.ts`,
> `packages/agent/src/services/work-runtime-env.constants.ts`,
> `apps/api/src/plugins-capabilities/deploy/deploy.controller.ts`,
> `apps/api/src/plugins-capabilities/deploy/deploy.service.ts`.

## What this is

A deployed directory site (`directory-web-template`) reads a handful of
**per-site** settings from `process.env` that the platform cannot derive on its
own — today the Stripe payment configuration. This runbook covers the small,
**allow-listed** set of per-Work runtime env vars an operator (the Work owner
or a member with edit rights) can set from the dashboard or the API, how they
are stored, and how they reach the running site.

It does **not** cover the platform-managed keys (`AUTH_SECRET`,
`COOKIE_SECRET`, `DATABASE_URL`, `GH_TOKEN`, `DATA_REPOSITORY`, `TENANT_ID`,
`SITE_URL`, `PLATFORM_*`, …). Those are minted by `DeployService` /
`WorkRuntimeEnvService` on every deploy and are deliberately **not** settable
through this surface — the allow-list is the guard.

### `GH_TOKEN`: the site's data-repo credential

The site uses `GH_TOKEN` to clone, pull and push **its own data repo** (items,
categories, collections, moderation). `DeployService` picks it, in this order:

0. **The site git-token broker**, when `EVER_WORKS_SITE_GIT_TOKEN_BROKER_ENABLED=true`
   and the data repo's owner is a managed org (below). The site gets no
   long-lived git credential at all; see
   [Per-site git tokens](#per-site-git-tokens-the-broker). Steps 1 and 2 below
   are the fallback when the broker is off or does not apply.
1. The platform site token for the data repo's owner:
   `EVER_WORKS_SITES_GIT_TOKEN` (`ever-works`),
   `EVER_WORKS_CUSTOMERS_SITES_GIT_TOKEN` (`ever-works-cloud`). Make it a
   fine-grained PAT with that org as resource owner, the `*-data` repos as
   repository access and **Contents: Read and write** only. It cannot delete,
   transfer or reconfigure a repo, touch workflows or reach another org.
2. Otherwise the deploying user's git token, unless
   `TENANT_USER_GIT_TOKEN_ENABLED=false`. That token reaches every repo the
   user can access (for the GitHub "connect" grant: `repo`, `workflow`,
   `write:repo_hook`, and `delete_repo` when
   `GITHUB_OAUTH_DELETE_REPO_SCOPE_ENABLED=true`), so production should run
   with a site token and the flag at `false`.

The same token goes to the website repo's `GH_TOKEN` Actions secret (build-time
data clone on the workflow path). Image pulls use `EVER_WORKS_GHCR_PULL_TOKEN`
/ `EVER_WORKS_CUSTOMERS_GHCR_PULL_TOKEN` (classic, `read:packages` only) ahead
of the broader `*_GITHUB_PAT_CLASSIC`. A running site picks up a changed token
only on its next deploy (the Secret is read through `envFrom`).

### Per-site git tokens (the broker)

An org-wide site token (step 1) reaches **every** data repo in the org, so one
compromised site pod can rewrite every other site's data; in
`ever-works-cloud` (one repo per customer) that is cross-tenant. The broker
gives each site a credential for its own data repo only.

**How it works**

- The platform's GitHub App mints an installation token narrowed at mint time
  to `repositories: ["<data repo>"]` and `permissions: {"contents": "write"}`
  (Metadata: read is implied). It can clone, pull, commit and push that one
  repo and nothing else: no other repo, no workflows, no administration. It
  expires after about one hour.
- The site refreshes it from `POST /api/sites/<workId>/git-token` with
  `Authorization: Bearer <EVER_WORKS_SITE_GIT_TOKEN_SECRET>`. The answer is
  `{ token, expiresAt, repository }` (`Cache-Control: no-store`, 30 req/min
  per IP). 401 = wrong secret or unknown Work (the same answer for both),
  409 = the Work's data repo is not one the broker serves, 502 = GitHub
  refused the mint, 503 = broker off or not configured.
- The per-site secret is `ewsgt_` + HMAC-SHA256(`EVER_WORKS_SITE_GIT_TOKEN_KEY`,
  Work id). It is derived, not stored: no column, no migration, and a **new
  Work is covered on its first deploy** with no token edit anywhere. A leaked
  site secret can only mint tokens for that one Work's data repo.
- The repository comes from the Work row (`getRepoOwner('data')` +
  `getDataRepo()`), never from the request.
- On deploy the site gets `EVER_WORKS_SITE_GIT_TOKEN_URL`,
  `EVER_WORKS_SITE_GIT_TOKEN_SECRET`, and `GH_TOKEN` = a first token minted at
  deploy (one repo, about one hour) so a build or a site that cannot yet
  refresh works at once. The website repo's Actions secrets get the same three
  values. If that first mint fails, `GH_TOKEN` is left unset rather than
  falling back to a broad token; the site fetches one at runtime.
- The site template (`ever-works/directory-web-template`) reads the token
  through its site-git-token resolver: the broker when both broker vars are
  set (cached until 5 minutes before expiry, refreshed and retried once on a
  401), else `GH_TOKEN`. A site on an older template keeps working only until
  its bootstrap `GH_TOKEN` expires, so **update the sites' template before
  turning the broker on**.

**Platform env**

| Variable                                   | Meaning                                                                                                                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVER_WORKS_SITE_GIT_TOKEN_BROKER_ENABLED` | `true` turns the broker on. Default off.                                                                                                                                                                                |
| `EVER_WORKS_SITE_GIT_TOKEN_KEY`            | HMAC key for the site secrets, at least 32 characters (`openssl rand -hex 32`). Rotating it rotates every site's secret; each site picks up its new one at its next deploy, so redeploy all sites after a rotation.     |
| `EVER_WORKS_SITE_GIT_TOKEN_BROKER_URL`     | The API origin as a site reaches it (`https://api.ever.works`). Defaults to `PUBLIC_API_URL`, then `PLATFORM_API_URL`. https only (localhost may be http).                                                              |
| `EVER_WORKS_SITE_GIT_TOKEN_ORGS`           | Managed orgs the broker serves. Default `ever-works,ever-works-cloud`. Use it to roll out one org at a time.                                                                                                            |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`  | The Ever Works App, already used elsewhere. It must be **installed on every managed org** with Contents: write. "All repositories" is fine and is what makes new Works automatic: every token is narrowed at mint time. |

**Tenant clusters (k8s-works, k8s-works-shared, custom kubeconfig):** nothing
new. No CronJob, RBAC or mounted Secret: the two broker keys ride in the
existing `<slug>-runtime-env` Secret (server-side deploy, or `deploy_k8s.yaml`
forwarding repo secrets), and the token itself lives only in the site
process's memory. The one requirement is HTTPS egress from the site pod to the
broker origin, which Directory site pods have today (they carry no egress
NetworkPolicy). Any future egress fence on tenant namespaces (P0.1 or a
per-namespace policy) must allow the broker origin alongside `github.com`.
Vercel-hosted sites get the two keys through `deploy_vercel.yaml`.

Enabled but missing the key, the URL or the App = the broker does not apply and
the deploy keeps steps 1 and 2 (logged as a warning). A data repo outside the
managed orgs, or an org with no App installation, also keeps steps 1 and 2
(the latter logged as an error).

**Rollout**

1. Install the Ever Works GitHub App on every managed org that lacks it
   (`ever-works-cloud` had none on 2026-11-07), repository access "All".
2. Ship the template change to the sites (their website repos must carry the
   resolver) and rebuild their images.
3. Set `EVER_WORKS_SITE_GIT_TOKEN_KEY` (and `EVER_WORKS_SITE_GIT_TOKEN_BROKER_URL`
   if `PUBLIC_API_URL` is not the public origin) in the API env, then
   `EVER_WORKS_SITE_GIT_TOKEN_BROKER_ENABLED=true`. Optionally start with
   `EVER_WORKS_SITE_GIT_TOKEN_ORGS=ever-works`.
4. Redeploy the sites. Check one: its `<slug>-runtime-env` Secret has the two
   broker keys and a `ghs_` `GH_TOKEN`; the API log shows
   `site git token issued for <org>/<slug>-data` about every 40 minutes per
   site process.
5. Remove `EVER_WORKS_SITES_GIT_TOKEN` / `EVER_WORKS_CUSTOMERS_SITES_GIT_TOKEN`
   from the API env and revoke those PATs, and set
   `TENANT_USER_GIT_TOKEN_ENABLED=false`. Sites outside the managed orgs then
   get no `GH_TOKEN` (logged loudly) instead of a broad one.

Not covered yet: a data repo in a member's own account (the broker serves
managed orgs only; those Works keep steps 1 and 2).

## The allow-list

Source of truth: `WORK_RUNTIME_ENV_ALLOWED_KEYS` in
`packages/agent/src/services/work-runtime-env.constants.ts`.

| Key                                  | Secret (masked `***`) | Purpose in the template                                 |
| ------------------------------------ | --------------------- | ------------------------------------------------------- |
| `NEXT_PUBLIC_PAYMENT_PROVIDER`       | no                    | Selects the payment provider (`stripe`).                |
| `STRIPE_SECRET_KEY`                  | **yes**               | Server-side Stripe API key (`sk_live_…` / `sk_test_…`). |
| `STRIPE_PUBLISHABLE_KEY`             | no                    | Publishable key (server-side alias).                    |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | no                    | Publishable key exposed to the browser bundle.          |
| `STRIPE_WEBHOOK_SECRET`              | **yes**               | Signing secret for `/api/webhooks/stripe` (`whsec_…`).  |
| `NEXT_PUBLIC_STRIPE_DYNAMIC_PRICING` | no                    | Feature toggle (`true` / `false`).                      |
| `STRIPE_SPONSOR_WEEKLY_PRICE_ID`     | no                    | Stripe Price id for the weekly sponsor slot.            |
| `STRIPE_SPONSOR_MONTHLY_PRICE_ID`    | no                    | Stripe Price id for the monthly sponsor slot.           |

Rules enforced by `WorkRuntimeEnvService.setRuntimeEnvVars`:

- Any key outside the list → **400** (`Unsupported runtime env key(s): …`);
  the whole call is rejected, nothing is written.
- Values are trimmed; empty / whitespace-only / `null` **removes** the key.
- Max 4096 characters per value; control characters are rejected.
- Merge-patch semantics: keys you do not mention are left untouched.

To add a key: extend `WORK_RUNTIME_ENV_ALLOWED_KEYS` (and
`WORK_RUNTIME_ENV_SECRET_KEYS` if it is a credential), run the agent spec
`work-runtime-env.service.spec.ts`, and update the table above. The dashboard
renders the form from the API's `allowedEnvKeys`, so no UI change is needed.

## Storage

All configured keys for a Work are stored as **one JSON map**, AES-256-GCM
encrypted with `PLATFORM_ENCRYPTION_KEY`, in `works.deployRuntimeEnvEncrypted`
(migration `1787423600000-AddWorkDeployRuntimeEnvVars`). Same envelope and
helper as the sibling `deployDatabaseUrlEncrypted` column. `NULL` means
nothing is configured.

Reads are defensive: keys no longer allow-listed (or non-string values) are
dropped when the map is decoded, so the allow-list remains authoritative even
over old rows.

## How the values reach the site

Nothing is applied live — **a redeploy is required** after any change.

1. **Server-side managed k8s deploys** (`k8s-works` / `k8s-works-shared`):
   `DeployService.collectServerSideRuntimeEnv` merges the map into the env the
   k8s plugin writes to the `${slug}-runtime-env` Secret (mounted via
   `envFrom`). The merge runs **after** every platform-managed key, so a
   managed key always wins on a collision. Applied key names (never values)
   are logged at `debug`.
2. **Workflow deploys** (GitHub Actions — custom kubeconfig and Vercel):
   `DeployService.pushWorkRuntimeEnvSecrets` pushes each configured key as a
   **GitHub Actions repo secret** on the Work's website repo, right after the
   managed runtime env. `deploy_k8s.yaml` forwards every non-CI repo secret
   into the cluster Secret; the Vercel workflows can read
   `secrets.STRIPE_SECRET_KEY` etc. the same way. Provider-agnostic and
   best-effort (a push failure logs and the deploy continues).

## API

Both endpoints require edit rights on the Work (`WorkOwnershipService.ensureCanEdit`).

### Read (masked)

```http
GET /api/deploy/works/{workId}/runtime-env
```

```json
{
	"status": "success",
	"mode": "shared",
	"sharedAvailable": true,
	"databaseUrl": { "configured": true, "masked": "postgresql://app:***@db.example.com/work_123" },
	"managed": ["AUTH_SECRET", "COOKIE_SECRET", "COOKIE_SECURE"],
	"allowedEnvKeys": [
		"NEXT_PUBLIC_PAYMENT_PROVIDER",
		"STRIPE_SECRET_KEY",
		"STRIPE_PUBLISHABLE_KEY",
		"NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
		"STRIPE_WEBHOOK_SECRET",
		"NEXT_PUBLIC_STRIPE_DYNAMIC_PRICING",
		"STRIPE_SPONSOR_WEEKLY_PRICE_ID",
		"STRIPE_SPONSOR_MONTHLY_PRICE_ID"
	],
	"env": [
		{ "key": "NEXT_PUBLIC_PAYMENT_PROVIDER", "set": true, "masked": "stripe", "secret": false },
		{ "key": "STRIPE_SECRET_KEY", "set": true, "masked": "***", "secret": true },
		{ "key": "STRIPE_PUBLISHABLE_KEY", "set": false, "masked": null, "secret": false },
		{ "key": "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "set": true, "masked": "pk_live…", "secret": false },
		{ "key": "STRIPE_WEBHOOK_SECRET", "set": false, "masked": null, "secret": true },
		{ "key": "NEXT_PUBLIC_STRIPE_DYNAMIC_PRICING", "set": false, "masked": null, "secret": false },
		{ "key": "STRIPE_SPONSOR_WEEKLY_PRICE_ID", "set": false, "masked": null, "secret": false },
		{ "key": "STRIPE_SPONSOR_MONTHLY_PRICE_ID", "set": false, "masked": null, "secret": false }
	]
}
```

`env` always lists **every** allow-listed key so a client can render the full
form; `masked` is `***` for secrets and a 7-character prefix + `…` otherwise
(short toggle/enum values such as `stripe` or `true` are shown verbatim).
Plaintext is never returned.

### Write (merge-patch)

```http
PUT /api/deploy/works/{workId}/runtime-env
Content-Type: application/json

{
    "env": {
        "NEXT_PUBLIC_PAYMENT_PROVIDER": "stripe",
        "STRIPE_SECRET_KEY": "sk_live_…",
        "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY": "pk_live_…",
        "STRIPE_WEBHOOK_SECRET": null
    }
}
```

- A body with **only `env`** leaves the database mode/URL untouched.
- `mode` / `databaseUrl` keep their pre-existing behaviour and may be sent
  together with `env` in one call.
- Response: same shape as `GET` plus `message` (for example
  `"Environment variables updated. Redeploy to apply them to the live site."`).
- `400` for a non-allow-listed key, an over-long value, or a malformed body.

### Dashboard

**Work → Deploy → Database & environment → Environment variables**: one row
per allow-listed key with the masked current value, an input, **Save**, and
**Remove** (sends `null`). Secrets use a password field and are never echoed
back.

## Operational notes

- **Rotation**: save the new value, then redeploy. Server-side deploys
  re-apply the Secret on every deploy (server-side apply is idempotent); the
  workflow path overwrites the repo secret.
- **Removing a key** from the Work does not delete an already-pushed GitHub
  repo secret (GitHub has no "unset on next deploy" semantics for a value we
  no longer know about); delete it in the repo's _Settings → Secrets_ if the
  leftover matters. The server-side k8s path rebuilds the Secret from scratch
  each deploy, so removals take effect there on the next deploy.
- **`PLATFORM_ENCRYPTION_KEY` missing** on the API: writes fail with a clear
  error; deploys log `Runtime-env per-Work env lookup failed …` and proceed
  without the vars.
- **`PUT … {"mode":"shared"}` answers 503 `SHARED_DB_PROVISION_FAILED`**: the
  API switched the Work to the Ever Works DB mode but `ensureDatabaseForWork`
  (direct DDL over `DB_EVER_WORKS_SHARED_ADMIN_URL`: `CREATE ROLE` /
  `CREATE DATABASE`) threw. The body's `reason` is the sanitized errno /
  SQLSTATE class — `connection refused [ECONNREFUSED]`,
  `host not found [ENOTFOUND]`, `password authentication failed [28P01]`,
  `insufficient privilege … [42501]`, … — never the connection string (the
  full error is in the API log: `Shared DB provisioning failed for work …`).
  Fix the admin connection (reachability from the API pods, credentials,
  `CREATEDB` / `CREATEROLE` on the admin role) and re-send the same request;
  deploys also retry provisioning idempotently (warn-level
  `Shared DB provision failed for work …` when it keeps failing — the site then
  runs without `DATABASE_URL`). Before this the endpoint answered a bare 500.
- **Audit**: every write logs an Activity Feed entry
  (`work.runtime-env.updated`) with the changed key **names**; values are
  never logged anywhere.
