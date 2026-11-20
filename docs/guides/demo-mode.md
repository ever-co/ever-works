---
id: demo-mode
title: Run a public demo (DEMO mode)
sidebar_label: 'Self-host: public demo'
description: Operate an Ever Works instance as a public demo like demo.ever.works - every DEMO environment variable and its default, what a demo sandbox cannot do, how the 24 hour sweeper deletes sandboxes and their GitHub repositories, and the operator checklist.
---

# Run a public demo (`DEMO` mode)

Setting `DEMO=true` turns an instance into a public demo, the way <https://demo.ever.works> runs. A visitor clicks **Start the demo** and gets a private sandbox account with seeded example data and live AI on free OpenRouter models. No registration is needed. The sandbox, and the GitHub repositories it created, are deleted after 24 hours.

With `DEMO` unset, none of this exists: no route, no blocked feature, no cron job. Nothing in this guide applies to a normal instance.

Two sites are easy to confuse:

| Site                      | What it is                                                                        |
| ------------------------- | --------------------------------------------------------------------------------- |
| <https://demo.ever.works> | The platform itself in demo mode (this guide).                                    |
| <https://dir.ever.works>  | An example of a website Ever Works generated (the directory template's own demo). |

## What a visitor gets

- `POST /api/auth/demo` mints a sandbox user (`demo-` plus 8 hex characters, `registrationProvider = 'demo'`) that expires after `DEMO_SANDBOX_TTL_HOURS`. On a demo host this is the only way in for a new identity.
- The sandbox is seeded with a Project Work and a draft directory Work. Pressing Generate on the draft provisions a repository.
- The seeded starter-kit Agents are active, so "Run now" runs them. None has a heartbeat, so none runs on a schedule or spends AI quota until the visitor asks.
- A strip on every page reads "You are using a demo account. Finding our software useful? Click here to Sign Up and start using for free!", linking to `DEMO_SIGN_UP_URL`.
- AI runs on OpenRouter models whose id ends in `:free`, nothing else. Any other model id is refused and fails closed.

## Environment variables

Set these on the **API**. The web app reads the demo state from `GET /api/config`, so it needs no `DEMO*` variable of its own. Numeric values that are not a positive integer fall back to the default.

| Variable                       | Default                           | Meaning                                                                                                                           |
| ------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `DEMO`                         | unset (off)                       | `true`, `1` or `yes` (any case) turns demo mode on. Anything else is off.                                                         |
| `DEMO_SANDBOX_TTL_HOURS`       | `24`                              | Life of a sandbox, in hours.                                                                                                      |
| `DEMO_SIGN_UP_URL`             | `https://app.ever.works/register` | Target of the strip link. Must be an absolute `https:` URL, else the default is used.                                             |
| `DEMO_GITHUB_ORG`              | none                              | GitHub org that holds demo repositories. Required when git storage is on; must equal `EVER_WORKS_CUSTOMERS_GITHUB_ORG`.           |
| `DEMO_REPO_PREFIX`             | `demo-`                           | Every demo repository name starts with it; the sweeper refuses to delete a repository without it.                                 |
| `DEMO_AI_REQUESTS_PER_SANDBOX` | `120`                             | AI requests one sandbox may make in its life. Over it: `DEMO_AI_QUOTA` (429).                                                     |
| `DEMO_AI_REQUESTS_PER_DAY`     | `900`                             | AI requests for the whole instance per UTC day. Keep it below OpenRouter's free daily cap.                                        |
| `DEMO_AI_REQUESTS_PER_MINUTE`  | `18`                              | AI requests for the whole instance per minute (OpenRouter's free limit is 20). Over it: `DEMO_AI_BUSY` (429) with `retryAfterMs`. |
| `DEMO_MAX_WORKS_PER_SANDBOX`   | `3`                               | Works with a repository that one sandbox may create.                                                                              |
| `DEMO_MAX_ACTIVE_SANDBOXES`    | `300`                             | Instance cap on live sandboxes. Over it: `DEMO_FULL` (503).                                                                       |
| `DEMO_CREATE_PER_IP_PER_HOUR`  | `5`                               | Sandboxes one IP may create per hour (the `long` throttler).                                                                      |

Related variables that are not `DEMO*` but that a demo depends on:

| Variable                                                  | Value on a demo                         | Why                                                                                                 |
| --------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `EVER_WORKS_PROJECT_WORKS_ENABLED`                        | `true`                                  | Every sandbox is seeded with a Project Work. The API refuses to boot with `DEMO=true` and this off. |
| `STORAGE_EVER_WORKS_GIT_ENABLED`                          | `true` for a demo that can generate     | Repositories are created through the Ever Works git provider.                                       |
| `EVER_WORKS_CUSTOMERS_GITHUB_ORG`                         | the same value as `DEMO_GITHUB_ORG`     | See "Why the demo org must be the customers' org".                                                  |
| `PLUGIN_OPENROUTER_{DEFAULT,SIMPLE,MEDIUM,COMPLEX}_MODEL` | `:free` model ids                       | The model ids the demo uses. The free list on OpenRouter changes; a stale id fails closed.          |
| `WORK_STALE_TIMEOUT_HOURS`                                | `0.5` (code default is `2`)             | Closes a generation that stopped progressing. Accepts decimals, so `0.5` is 30 minutes.             |
| `CAPTCHA_PROVIDER`, `CAPTCHA_SECRET`                      | Turnstile, plus its secret              | Protects `POST /api/auth/demo`. Optional; when captcha is not configured the check is skipped.      |
| `DATABASE_TYPE`, `DATABASE_PATH`                          | `sqlite`, a path on a persistent volume | The reference demo runs on one SQLite file.                                                         |

The boot check (`assertDemoConfig`) refuses to start the API when `DEMO` is on and project Works are off, or when git storage is on and `DEMO_GITHUB_ORG` is empty or differs from `EVER_WORKS_CUSTOMERS_GITHUB_ORG`.

## What a demo sandbox cannot do

A blocked request answers `DEMO_DISABLED` (403). Two scopes exist:

- **Everyone** (even a signed-in operator): registration, anonymous sign-in, magic links, social and Ever ID sign-in, GitHub App sign-in, and anonymous uploads. The only way in is `POST /api/auth/demo`.
- **Demo sandboxes only**: anything that spends money, reaches the outside world or changes the account. By category: plugin and model-account settings and credentials, your own API keys; webhooks, notification channels, MCP connections, Composio and connected accounts; deploy, custom domains, subdomains, runtime environment, custom databases; screenshot capture (generation skips its image step on a demo, whatever screenshot provider is installed, and items keep their placeholders); importing a repository or a company, copying a template repository, changing a Work's repository owner or visibility, Work invitations (mailed, or an owner-claim link that would transfer the Work and its repositories), and accepting one (a sandbox never joins another account's Work); App Works; invitations by email; public share links of a workspace (turning one on, a new link, or publishing more through it; turning it off stays open); password change, username change, device sign-in, data export, account import, claim and deletion.

The full list is `DEMO_BLOCKED_ROUTES` in `apps/api/src/demo/demo-restrictions.ts`.

AI is also restricted. Only models whose id ends in `:free` run; paid ids answer `DEMO_MODEL_NOT_ALLOWED` (500, fail closed), and a free model that is down answers `DEMO_MODEL_UNAVAILABLE` (503). Generation uses the standard pipeline.

The assistant chat stays open: it calls the OpenAI-compatible `POST /api/v1/chat/completions`, which runs every call through the same AI policy (OpenRouter, `:free` models, the quotas). A refused chat call answers with its demo code (`DEMO_AI_QUOTA`, `DEMO_AI_BUSY`, `DEMO_MODEL_UNAVAILABLE`) and the chat shows the matching message. A sandbox cannot create an API key, so it reaches that endpoint only with its own session.

**Operators** (normal accounts) can log in on a demo instance. They are not route-blocked, except for the "everyone" rows, but they get free models only.

## Cleanup: the sweeper

On a demo instance a cron job runs every 15 minutes under a distributed lock. For each expired sandbox it deletes the GitHub repositories the sandbox created, then the sandbox and its data. A generation still open on an expired sandbox defers the purge, for at most 2 hours past expiry.

Repositories are shared with real customers' repositories, so deletion is strict. A repository is deleted only when **all four** hold:

1. there is a ledger row recording it for this sandbox;
2. its owner equals `DEMO_GITHUB_ORG`;
3. its name starts with `DEMO_REPO_PREFIX`;
4. the live GitHub repository id equals the id recorded in the ledger.

The org is never listed, and nothing is ever deleted by name pattern. A ledger row with no recorded id is never deleted: the sandbox is held for an operator. A row that fails 3 times, or a sandbox whose purge fails 3 times, is also held. Demo repositories carry the GitHub topic `ever-works-demo`; searching the org for that topic is how an operator finds a repository that leaked.

### Why the demo org must be the customers' org

The Ever Works git provider creates every repository in `EVER_WORKS_CUSTOMERS_GITHUB_ORG`. If `DEMO_GITHUB_ORG` were a different org, demo repositories would be created where cleanup never looks. So the two must be equal when git storage is on, and the boot check enforces it. It also means demo repositories live beside customer repositories, which is why the four deletion conditions above are strict.

## Known limits

- **One API replica.** Run the demo API as a single replica with the `Recreate` strategy. The per-sandbox Works cap uses an in-process lock, and SQLite is one file.
- **Trigger.dev.** The Trigger.dev project used by the demo must set `DEMO=true` in its own environment, so background workers apply the same AI policy as the API.
- **Turnstile.** If you use Cloudflare Turnstile, the site's hostname allowlist must include the demo hosts.
- **No pgvector on SQLite.** Knowledge search is lexical.
- **Not available on a demo:** workflow-run AI nodes, and the Ideas and User research features.

## Operator checklist

1. **Namespaces and images.** One environment per demo host (`demodev`, `demostage`, `demo.ever.works` here). Run the API image (1 replica, `Recreate`) and the web image. The web reaches the API in-cluster and proxies browser calls through its own `/api/*` routes, so the API needs no public host. Leave `NEXT_PUBLIC_API_URL` unset.
2. **Storage.** A persistent volume for the SQLite file and the uploads directory (`DATABASE_TYPE=sqlite`, `DATABASE_PATH` on the volume). The sweeper resets the demo; never wipe the volume. It is a single-writer point of failure.
3. **Secrets.** Names only: `AUTH_SECRET`, `PLATFORM_ENCRYPTION_KEY`, `PLUGIN_SECRET_ENCRYPTION_KEY`, the OpenRouter key, the GitHub token for the demo org, the Trigger.dev secret key and internal secret, `CAPTCHA_SECRET`, the search key. In this fleet they live in OpenBao and reach the pod through an ExternalSecret; elsewhere, use your secret store. Plain flags (`DEMO=true`, model ids) can live in the Deployment env in Git. Never commit a value.
4. **GitHub.** A dedicated org (or the customers' org) and a token that can create and delete repositories there. Use a token separate from production's so revoking the demo never affects production.
5. **OpenRouter.** A dedicated key with a **$0 credit limit**, so even a bug in the guard cannot buy a paid call. On an account that has bought at least $10 of credits once, which raises the free limit from 50 to 1000 requests a day.
6. **Search.** A free-tier search provider key for generation.
7. **Trigger.dev.** A project for the demo with `DEMO=true`, the demo API's internal URL and secret, and the plugin keys and model ids. Cap it to a small concurrency so demo runs never crowd out production runs on shared workers.
8. **Switch off** on the demo: billing and subscriptions, credits enforcement, deploys, fleet, terminal sessions, Ever Connect, statistics, scheduled updates, template auto-update, magic links, OAuth client ids and the mailer. Switch on: project Works, git storage, the customers' org, and Trigger.dev where Works must run.
9. **Check it.** `GET /api/config` shows `features.demoMode: true`. "Start the demo" lands in a sandbox. After the TTL the sandbox and its repositories are gone. Search the org for the `ever-works-demo` topic and expect no leftovers.
10. **Monitoring.** `external-uptime-monitor.yml` probes `https://demo.ever.works/login` ("Platform demo") and `https://dir.ever.works/` ("Demo directory").

## Local try-out

```bash
DEMO=true EVER_WORKS_PROJECT_WORKS_ENABLED=true DATABASE_TYPE=sqlite DATABASE_PATH=./data/demo.sqlite DATABASE_AUTOMIGRATE=true RUN_MIGRATIONS=false pnpm dev:api
```

With git storage off, "Start the demo" works but Generate cannot create repositories.
