# Platform demo mode (demo.ever.works) — design

Status: draft for owner approval · 2026-11-19 · branch `feat/platform-demo-mode`

## 1. Intent

`demo.ever.works` should be a live, try-it-yourself copy of the **Ever Works platform**, not the directory
template it serves today. A visitor lands on the demo, clicks one button, and is inside a workspace that already
holds sample data. There they create Works, build Missions, generate Goals and watch agents work, for free, on
**free OpenRouter models**. A strip at the top says it is a demo and links to a real sign-up on app.ever.works.
The directory-template demo moves to the existing `dir.ever.works` (already a template-built site).

Owner decisions (chat, 2026-11-19):

- **Option B — a private copy per click.** Each click on the demo button creates a fresh demo user plus
  Organization, seeded with the same sample data. It is deleted automatically after its time-to-live. Visitors
  never see or trample each other's work.
- **Delete the GitHub repos of expired demo users** together with the account.
- AI uses free OpenRouter models only ("all kind of free").
- **Live + recorded examples:** live AI while the free quota lasts, plus recorded results seeded into every
  sandbox so the demo still shows what the platform does once the quota is used up.
- **SQLite**, not Postgres, for the demo database.
- **GitHub org `ever-works-cloud`** for demo repos (the org production already uses for "Ever Works Git").
- Demo strip copy (owner brief 2026-11-07, already on demo.gauzy.co / demo.ever.team / demo.traduora.co):
  _"You are using a demo account. Finding our software useful? Click here to Sign Up and start using for free!"_

## 2. Goals, non-goals, anti-goals

**Goals**

1. One click from `demo.ever.works/login` to a seeded, working demo workspace. No email, no password, no
   verification.
2. The core loop works in the demo: create a Work (including AI generation of a directory Work), Missions,
   Goals that actually run (agent runs, task iterations), Tasks, Agents, chat.
3. AI cost is zero: only `:free` OpenRouter model ids are ever sent upstream.
4. Nothing in the demo can spend money or touch the outside world beyond `demo-` repos in `ever-works-cloud`,
   OpenRouter (free models, $0-limit key) and a free-tier web-search key.
5. Demo data cleans itself up: user, Organization, Tenant, Works, files and the demo's GitHub repos.
6. Same image as production: demo mode is a **runtime** switch (`DEMO=true`), not a separate build.

**Non-goals**

- Real sign-up, social login, magic link or password login for new users on the demo instance (they sign up
  on app.ever.works).
- Website deploys, custom domains, App Works, Fleet / desktop / cloud nodes, terminals, billing, emails.
- Persisting anything beyond the time-to-live; "claiming" a demo account into a real one.
- A shared, Gauzy-style login (rejected: option A).
- High availability: the demo API is a single pod (SQLite), and a short outage on each deploy is accepted.

**Anti-goals (a failure even if it "works")**

- Any paid model call, Stripe call, real email, real deploy or DNS change triggered from the demo.
- Demo traffic degrading **Ever Gauzy production** or app.ever.works (SQLite keeps the demo off the shared
  `pg` cluster entirely).
- **The repo-deleting cleanup touching any repo it did not create.** `ever-works-cloud` also holds real
  customers' repos, so deletion is ledger-based (5.2.5), never "everything owned by this Work".
- The demo flag leaking into production behaviour (every guard is inert when `DEMO` is off).
- Demo visitors able to read each other's data (option B isolation must hold).

## 3. Constraints

- **Free-model quota is shared.** OpenRouter limits free models per account: 20 requests/minute, ~1000/day
  (with ≥ $10 of credits bought; 50/day otherwise). All visitors share it, and one directory generation is
  dozens of calls. Hence per-visitor and global caps, a per-minute limiter, and the recorded examples.
- **Directory generation needs GitHub.** Generated items live only in the Work's Git data repo
  (`data-generator.service.ts:353` creates it); without credentials it fails _after_ spending AI calls.
- **Agent runs need Trigger.dev.** Agent task runs, chat replies and heartbeats dispatch only to Trigger.dev
  (`packages/tasks/src/dispatchers/agent-task-dispatchers.ts:31`, `JobRuntimeNotConfiguredError`); the task body
  (`agent-task-execute.task.ts`, ~1300 lines) is not something to re-implement in-process. Production uses the
  self-hosted Trigger.dev in namespace `trigger` (`trigger.ever.co`). Those workers do **not** open the database:
  `trigger-internal.module.ts` reaches the API's repositories and services through ~59 remote proxies over the
  internal HTTP channel (`TRIGGER_INTERNAL_API_URL` + `TRIGGER_INTERNAL_SECRET`). That is why SQLite works with
  Trigger. The worker modules that do open the DB (App Works runtime, workflow runs, webhook delivery,
  app-dependency provisioning) serve features that are off in the demo.
- **SQLite = one writer.** One API pod, its DB file on a persistent volume, `Recreate` rollouts. On SQLite the
  schema comes from TypeORM auto-sync (`DATABASE_AUTOMIGRATE`, the dev/CI path) instead of the Postgres
  migrations; pgvector is Postgres-only, so knowledge search falls back to lexical ranking
  (`work-knowledge-chunk.repository.ts:181`, documented fallback). CI runs the suites on SQLite.
- **Infra rules (homelab `AGENTS.md`):** one cluster `ever-k8s`, one namespace per platform+env, three envs
  (develop → stage → main), secrets only from OpenBao via External Secrets, config in `ever-co/k8s-gitops`,
  claim on `MAINTENANCE.md` before any live change, no cherry-picking (cascade develop → stage → main whole),
  GitHub writes only in allow-listed orgs (`ever-works-cloud` is on the list), never delete data/DBs/PVCs (the
  demo cleanup is a product feature the owner approved for demo data only). "dev/demo use SQLite" is the
  existing rule; a single-writer store must use replicated storage (Ceph RBD), float across nodes, and be
  flagged to the owner as a SPOF (it is, here).
- **Web image is built once:** `NEXT_PUBLIC_*` is baked at build time, so the web must learn about demo mode at
  runtime (from the API's public `GET /api/config`, already cached 60 s and contract-tested).

## 4. Approaches considered

|       | Approach                                                                                                                                                   | Trade-off                                                                                                             | Verdict           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------- |
| A     | Shared predefined accounts (Gauzy-style buttons), nightly wipe + reseed                                                                                    | Simplest; but visitors see/delete each other's Works, long AI jobs collide in one org, throttler buckets are per user | Rejected by owner |
| **B** | **Private sandbox per click**: fresh demo user + Organization seeded from fixtures, time-to-live, automatic cleanup (reusing the anonymous-user machinery) | A few hundred rows and up to N GitHub repos per visitor; needs a sweeper + careful repo deletion                      | **Chosen**        |

Sub-choices within B:

- **Database: SQLite** (owner). Considered Postgres on `Cluster/pg` (two API replicas, pgvector, the real
  migration path), but it puts public demo traffic on the cluster that serves Gauzy production and needs new
  databases, roles and pooler changes. SQLite costs one API pod, a short outage per deploy, and lexical-only
  knowledge search.
- **Job runtime:** a dedicated **Trigger.dev project "Ever Works Demo"** on the self-hosted instance (its
  workers call the demo API, never production). _Not_ the experimental pg-boss/BullMQ runtimes (per-task
  dispatching is "operator-provisioned", agent runs are Trigger-only).
- **GitHub: `ever-works-cloud`** (owner), shared with real customer repos, so every demo repo is named with a
  `demo-` prefix, tagged, and recorded in a ledger at creation; only ledger entries are ever deleted.
- **Sandbox user** = an anonymous-style user (`isAnonymous: true`, `anonymousExpiresAt`) marked
  `registrationProvider: 'demo'`. Reuses the session minting (`AnonymousAuthService`) and purge
  (`AnonymousUserCleanupService`), and keeps demo users out of every "real user" path.
- **One button** (my call): no "team member" variant; in code `ensureAdmin` equals `ensureMember`
  (`entities/types.ts:126-135`), so it would look identical while doubling users per click.

## 5. The design

### 5.1 Switches (API env; all default off / safe)

| Env                            | Default                           | Meaning                                                                                                                                                                       |
| ------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEMO`                         | off                               | Master switch (`true`/`1`/`yes`, like Gauzy's `DEMO`). Every guard below is inert without it.                                                                                 |
| `DEMO_SANDBOX_TTL_HOURS`       | `24`                              | Life of a sandbox.                                                                                                                                                            |
| `DEMO_SIGN_UP_URL`             | `https://app.ever.works/register` | Strip + register-page link. Must be absolute https.                                                                                                                           |
| `DEMO_GITHUB_ORG`              | —                                 | Required when `DEMO` is on and generation is enabled; must equal `EVER_WORKS_CUSTOMERS_GITHUB_ORG` (`ever-works-cloud`). The API refuses to boot in demo mode if they differ. |
| `DEMO_REPO_PREFIX`             | `demo-`                           | Every demo repo name starts with it; the sweeper refuses to delete a repo without it.                                                                                         |
| `DEMO_AI_REQUESTS_PER_SANDBOX` | `120`                             | LLM calls per sandbox per TTL.                                                                                                                                                |
| `DEMO_AI_REQUESTS_PER_DAY`     | `900`                             | LLM calls per instance per UTC day (below OpenRouter's free cap).                                                                                                             |
| `DEMO_AI_REQUESTS_PER_MINUTE`  | `18`                              | Instance-wide limiter (OpenRouter free limit is 20/min).                                                                                                                      |
| `DEMO_MAX_WORKS_PER_SANDBOX`   | `3`                               | Caps repo creation per visitor.                                                                                                                                               |
| `DEMO_MAX_ACTIVE_SANDBOXES`    | `300`                             | Global cap; above it the button answers "the demo is full, try again later".                                                                                                  |
| `DEMO_CREATE_PER_IP_PER_HOUR`  | `5`                               | Throttle on sandbox creation.                                                                                                                                                 |

Free model ids are **not** new switches: the existing `PLUGIN_OPENROUTER_{DEFAULT,SIMPLE,MEDIUM,COMPLEX}_MODEL`
are set to `:free` ids in the demo's env (e.g. `google/gemma-4-31b-it:free`,
`nvidia/nemotron-3.5-super-vl:free`, `inclusionai/ling-3.2-flash:free`). The list on OpenRouter changes; the
guard makes a stale id fail closed rather than fall through to a paid model.

### 5.2 API — new `apps/api/src/demo/` module (registered only when `DEMO` is on)

1. **`GET /api/config`** gains `features.demoMode: boolean` and `demo: { signUpUrl, sandboxTtlHours } | null`
   (allow-listed, public, safe). Update the public-config contract spec
   (`apps/web/e2e/flow-config-public-contract.spec.ts`).
2. **`POST /api/auth/demo`** (`@Public`, 404 when demo is off): body `{ captchaToken? }`.
    - Throttled per IP (`DEMO_CREATE_PER_IP_PER_HOUR`); captcha verified via `CaptchaVerifierService` when
      configured (same rule as `POST /auth/anonymous`).
    - Refuses with 503 + `{code: 'DEMO_FULL'}` above `DEMO_MAX_ACTIVE_SANDBOXES`.
    - Creates the user like `AnonymousAuthService.createAnonymousUser` (username `demo-<hex>`, display name
      "Demo User", `isAnonymous: true`, `registrationProvider: 'demo'`, `anonymousExpiresAt = now + TTL`,
      `onboardingState` marked complete with storage `ever-works-git`), mints the session (expiry = TTL), runs
      the **sandbox seeder** (3), returns `{ access_token, user, expiresAt }`.
    - Seeding failure rolls back (delete the half-made user) and returns 500 with a generic message.
3. **Sandbox seeder** (`DemoSandboxSeederService`), one request, target < 3 s, no AI calls, no GitHub calls.
   Content lives in a typed fixture (`demo-sandbox.fixture.ts` + recorded JSON) so marketing can tune it:
    - Organization "Acme Labs (Demo)" via `OrganizationService.createOrganization` (visitor = admin).
    - 2 Teams, ~4 Agents from the onboarding starter kit (`OnboardingRoleSeedingService.seed`).
    - A **Project Work** "Launch the Acme website" (no repo; `EVER_WORKS_PROJECT_WORKS_ENABLED=true` in the
      demo env) with 2 Missions, 3 Goals in different states, ~8 Tasks with comments/history, a few knowledge
      notes.
    - A **draft directory Work** "Awesome AI Coding Tools" with a prefilled prompt, ready for Generate (the
      "watch it build" moment; creates `demo-` repos, counted against `DEMO_MAX_WORKS_PER_SANDBOX`).
    - **Recorded examples** (plain DB rows): a Goal with 2 completed iterations, each with its Tasks done and an
      Agent run (status succeeded, messages/tool-call transcript, model = a free model id, cost 0); a Mission
      with a generated plan and one finished run; an Agent chat conversation; activity-log entries. Captured
      once from a real run on Works dev with free models, exported, reviewed and committed as JSON; the seeder
      rewrites ids and timestamps per sandbox ("2 hours ago" relative to sandbox creation).
    - No pre-generated directory Work (its items would need repos per click); the login card and the draft Work
      link to `https://dir.ever.works` as "a site Ever Works generated".
4. **Demo guard** (`DemoGuardService` + a global interceptor/guard; active only when `DEMO` is on and the caller
   is a demo user):
    - **AI**: in `AiFacadeService`, where `enforceBudget` runs before each provider call (`askJson`,
      `createChatCompletion`, `createStreamingChatCompletion`), force provider `openrouter`; if the resolved
      model id does not end in `:free`, replace it with the configured tier model; if that is not `:free`
      either, throw `DemoModelNotAllowedError` (fail closed). Count the call against the per-sandbox, daily and
      per-minute limits (counters in the demo DB). Over a daily cap → `DemoQuotaExceededError` → 429 with the
      quota message; per-minute: background work (generation steps, agent iterations) waits for a token
      (bounded), interactive chat gets 429 "busy, retry in a few seconds". Trigger workers run the same facade
      with `DEMO=true`; they reach the counters through the existing internal HTTP channel (a remote proxy like
      the ~59 already in `trigger-internal.module.ts`), since they have no DB.
    - **Embeddings**: skipped in the demo. On SQLite there is no pgvector to store or query them, so `embed`
      short-circuits (no upstream call, saves quota) and knowledge features use the lexical fallback; the
      builder checks that KB/memory paths degrade cleanly (no failed jobs, no error toasts).
    - **Pipelines**: generation is locked to `standard-pipeline`. `agent-pipeline` (own model client,
      `agent-pipeline.plugin.ts:492`) and the CLI pipelines (claude-code, codex, gemini, opencode, hermes-agent;
      own keys) are disabled for demo users and hidden from the picker; Agents run on the platform OpenRouter
      provider only.
    - **Generation helpers**: web search uses a dedicated **free-tier** search key (Tavily free plan); screenshots
      are off (the image step is skipped, placeholders shown); content extraction uses `local-content-extractor`.
    - **Model choice surfaces**: `GET /api/plugins/:id/models` returns only `:free` models; chat/agent DTOs with a
      non-free `model` are rewritten by the facade rule (no 4xx; the picker never offers them).
    - **Blocked in demo (403 `{code: 'DEMO_DISABLED'}`)**: plugin settings writes that carry secrets (BYOK) at
      user/org/work scope, API key creation, model
      accounts / credentials, outbound webhooks, notification channels, MCP connections, Composio/Zapier and
      other integration connects, OAuth "connect GitHub/Vercel", deploy / add-domain, App Works, account claim,
      password/email change, account deletion request (the sweeper does it), org invites by email, data export,
      changing a Work's repo owner/name. One table in code (route pattern → reason), unit-tested that every
      pattern matches a real route. `POST /api/v1/chat/completions` (the OpenAI-compatible proxy) stays open
      (final-review ruling R39): the web's assistant chat calls it, and every call through it gets the AI rule
      above; its demo refusals keep their status and `code` so the chat can show the friendly message.
    - **Works**: `storageProvider` forced to `ever-works-git` (private repos in `ever-works-cloud`), Work repo
      names forced to start with `DEMO_REPO_PREFIX` + the sandbox's short id (e.g.
      `demo-3f9a1c-awesome-ai-coding-tools-data`), `deployProvider` forced to an inert value so generation never
      deploys, `DEMO_MAX_WORKS_PER_SANDBOX` enforced on create.
      The prefix comes almost for free: with `ever-works-git` storage the repo is created **at Work creation**,
      before any generation (`work-lifecycle.service.ts:735-770`), named by `EverWorksGitProvider.buildRepoName`
      from the user's slug, which is why production's anonymous visitors produce `anon-<hex>-<prompt>-<suffix>`
      repos in `ever-works-cloud`. Demo usernames `demo-<hex>` therefore yield `demo-<hex>-…` repos; the guard
      still asserts the prefix on every create.
    - **Repo ledger**: every repo the platform creates for a demo Work (the create-time repo above, plus any
      data/website/copy repos generation creates) is written to a `demo_github_repos` ledger row
      (`sandboxUserId`, `owner`, `name`, GitHub repo id, createdAt) at creation, and tagged with the GitHub topic
      `ever-works-demo`. Hook point: `EverWorksGitProvider.createRepository` and `GitFacadeService`'s
      `createRepository` / `createRepositoryFromTemplate` / `createRepositoryCopy`.
    - **Registration**: `POST /api/auth/register`, magic link and social callbacks answer 403 `DEMO_DISABLED`
      when `DEMO` is on (platform operators log in normally).
5. **Sweeper** (`DemoSandboxSweeperService`, Nest `@Cron` every 15 min, `DistributedTaskLockService.runExclusive`,
   only when `DEMO` is on), for each expired demo user (`registrationProvider = 'demo'` and
   `anonymousExpiresAt < now`, batches of 20):
    1. Delete its ledger repos. A repo is deleted **only if all hold**: it is in the ledger for this sandbox; the
       owner is `DEMO_GITHUB_ORG`; the name starts with `DEMO_REPO_PREFIX`; the live GitHub repo id equals the
       ledger's id (so a later, unrelated repo with the same name is never hit). Anything else is logged and
       skipped. "Already gone" counts as success. No listing of the org and no deletion by pattern, ever.
    2. Delete Works through the normal `deleteWork` path, then the user via `AnonymousUserCleanupService`
       (storage GC + row cascade), then the demo Organization and Tenant.
    3. One failure logs and continues; a sandbox failing 3 times is logged with its id.
       The nightly `anonymous-user-cleanup` (`UserRepository.findExpiredAnonymous`, `user.repository.ts:268`) must
       **exclude** `registrationProvider = 'demo'`, or it could delete a demo user before its repos.

### 5.3 Web

1. Read `features.demoMode` + `demo` from the API config server-side (fetch-and-fail-closed pattern of
   `lib/feature-flags/app-launcher.ts`), pass down as props.
2. **Login page** (`(auth)/login/page.tsx`, `login-client.tsx`) in demo mode: a top card _"Try Ever Works — no
   sign-up needed"_ with one primary button **"Start the demo"**, and the line "Your private demo workspace is
   deleted after 24 hours. AI runs on free models and may be slower." The email/password form stays below,
   collapsed under "Operator login". The button calls a server action `startDemo()` (template:
   `actions/onboarding/anonymous.ts`) → `POST /api/auth/demo` → `setAuthAccessCookie` → dashboard home.
   Turnstile token passed when a site key is configured.
3. **Landing**: `/` for a signed-out visitor goes to `/login`; the register page shows a card pointing to
   `DEMO_SIGN_UP_URL` plus the demo button instead of the form.
4. **Demo strip** for demo users, above `DashboardHeader` in `(dashboard)/layout-client.tsx`, modelled on
   `JobRuntimeDegradedBanner` (role="status", next-intl, not dismissible): the owner's copy with "Click here to
   Sign Up" → `DEMO_SIGN_UP_URL` (new tab), plus "Demo workspace expires in 23 h".
5. **Friendly errors**: `DEMO_DISABLED` → toast "Not available in the demo — sign up to use it"; quota 429 →
   the quota message; `DEMO_FULL` → message on the login card. When the daily AI quota is used up
   (`demo.aiQuotaExhausted` on the demo user's profile), the strip adds "Live AI is used up for today — explore
   the recorded examples" with a link to the recorded Goal.
6. Strings in `en` plus the existing locales' fallbacks (next-intl); follow the repo's i18n checks.

### 5.4 Infrastructure (`ever-co/k8s-gitops`, OpenBao, Trigger.dev, GitHub)

1. **Namespaces**: reuse `ever-works-demo-{dev,stage,prod}` (hosts `demodev`, `demostage`, `demo.ever.works`
   unchanged). Replace the template `web` Deployment with the platform's `ever-works-api` (**1 replica,
   `strategy: Recreate`**) + `ever-works-web` (2 replicas), images
   `ghcr.io/ever-works/ever-works-{api,web}:{dev,stage,prod}`, ArgoCD Image Updater annotations switched to those
   images. No MCP. Ingress `demo*.ever.works` → web; the web reaches the API in-cluster
   (`API_URL=http://ever-works-api:3100`) and proxies browser calls through its own `/api/*` routes, so no
   public API host (the features that need `NEXT_PUBLIC_API_URL` — terminals, computer sessions — are off).
   The old template `web` Deployment is scaled to 0 and annotated `ever-works.io/retired` (no-removal rule;
   prune is off on these apps); deleting it later is the owner's call.
2. **Storage**: a PVC `ever-works-demo-data` (Ceph RBD, RWO, 5 Gi) mounted at `/app/apps/api/data`, holding
   `DATABASE_PATH=/app/apps/api/data/demo.sqlite` and the uploads dir (`STORAGE_BACKEND=local-fs`,
   `UPLOADS_DIR` under the same mount). `DATABASE_TYPE=sqlite`, `DATABASE_AUTOMIGRATE=true`,
   `RUN_MIGRATIONS=false`. Flagged to the owner as a single-writer SPOF (this document). Never deleted by
   automation; resetting the demo = the sweeper, not wiping the volume.
3. **Secrets**: OpenBao `kv/ever-works/demo/{dev,stage,prod}` → `ExternalSecret ever-works-demo-secrets` per
   namespace (`AUTH_SECRET`, `PLATFORM_ENCRYPTION_KEY`, `PLUGIN_SECRET_ENCRYPTION_KEY`, OpenRouter key, the
   `ever-works-cloud` token, Trigger secret key + internal secret, captcha secret, search key). Plain flags
   (`DEMO=true`, model ids, switches off) live in the Deployment env in Git.
4. **Trigger.dev**: a new project "Ever Works Demo" on `trigger.ever.co`, environments `staging` (demostage)
   and `prod` (demo); env vars = `DEMO=true`, the internal API URL/secret of the demo API, the plugin keys and
   model ids. `.github/workflows/release-trigger-selfhosted.yml` deploys the same task bundle to this project
   too (a second job keyed on a `TRIGGER_DEMO_PROJECT_REF` variable). Each demo environment gets a hard
   concurrency limit of 2 runs so demo runs never crowd out app.ever.works runs on the shared workers.
   demodev runs without Trigger (as Works dev does today), so goals there are created but do not execute.
5. **GitHub**: org `ever-works-cloud` (owner). A dedicated token for the demo with repo create + delete there
   (classic `repo` + `delete_repo`, or fine-grained Administration write), separate from production's
   `EVER_WORKS_CUSTOMERS_GITHUB_PAT` so revoking the demo never affects production.
6. **OpenRouter**: a dedicated API key with a **$0 credit limit**, so even a bug in the guard cannot buy a paid
   call. On an account that has bought ≥ $10 of credits once (1000 free requests/day instead of 50).
7. Explicitly **off** in the demo env: Stripe keys + `STRIPE_RELAY_ENABLED`, `SUBSCRIPTIONS_ENABLED`, credits
   enforcement, `DEPLOY_EVER_WORKS_ENABLED`, `EVER_WORKS_APP_*`, `FLEET_ENABLED=false` + all `FLEET_*`,
   `TERMINAL_SESSIONS_ENABLED`, `EVER_CONNECT_*`, `EVER_STATS_ENABLED`, `SCHEDULED_UPDATES_ENABLED`,
   `WEBSITE_TEMPLATE_AUTO_UPDATE_ENABLED`, `USER_RESEARCH_ENABLED`, `MAGIC_LINK_ENABLED`, OAuth client ids,
   `MAILER_PROVIDER=none`, `NEXT_PUBLIC_API_URL` unset, PostHog/Sentry optional. On:
   `EVER_WORKS_PROJECT_WORKS_ENABLED=true`, `STORAGE_EVER_WORKS_GIT_ENABLED=true`,
   `EVER_WORKS_CUSTOMERS_GITHUB_ORG=ever-works-cloud`, `TRIGGER_ENABLED=true` (stage/prod).

### 5.5 Template demo → dir.ever.works

Update the links that call the template demo "demo.ever.works": `directory-web-template` README + docs
(`docs/index.md`, `docs/support.md`, `robots.ts` if it names the host), `ever-works/demo-data` README, the
platform README (§ "See an example of what it builds"), `.github/workflows/external-uptime-monitor.yml` (check
`dir.ever.works` for the template and `demo.ever.works` for the platform login page), `k8s-gitops`
`docs/web-properties.md`, homelab docs. The ever.works website's header "Demo" button already points to
`https://demo.ever.works`, which is now the right target. `docs-demo-ever-works-*` (docs.demo.ever.works) is not
touched.

### 5.6 Rollout

1. Platform PR → `develop` (CI, AI-review rule) → Image Updater rolls `ever-works-demo-dev` once the gitops
   change for demodev is in (board claim).
2. Normal cascade develop → stage → main (no cherry-picks), coordinated on the board with the lanes cascading
   today; demostage then demo follow their image tags.
3. Infra per env in order dev → stage → prod: OpenBao secret, ExternalSecret, PVC, Deployments, Trigger project
   env. Verify each: login card visible, button lands in a seeded workspace, strip visible, recorded examples
   render, a Goal runs one iteration on a free model, a directory Work generates into a `demo-` repo in
   `ever-works-cloud`, a forced sweeper run deletes an expired sandbox and exactly its ledger repos, no non-`:free`
   model id in the API logs.

## 6. Testing

- API unit: demo config shape; `POST /auth/demo` (off → 404, throttle, cap, rollback on seed failure); seeder
  output and isolation (two sandboxes never share an Organization/Tenant); guard table; model rewrite +
  fail-closed; quota counters and limiter; repo naming; ledger; sweeper (every deletion condition, id mismatch,
  missing prefix, idempotency, partial failure); anonymous cleanup excludes demo users.
- API e2e on SQLite (the CI path): create → act → expire → sweep, with the GitHub facade faked.
- Web unit: login card, strip, server action. Playwright: demo button → dashboard → strip visible; strip absent
  when `DEMO` is off.
- Boot the built API + web locally with `DEMO=true` on SQLite and click through (repo rule: green CI is not
  proof the app boots). Public-contract check: `/api/config` keys only added, nothing removed.

## 7. Left to the builder

Exact file/route names, the counter and ledger table design (with migrations for Postgres too, since the code
ships to every install), fixture wording, how repo names get the prefix (same resolver generation uses),
i18n plumbing, and splitting the work into PRs (suggested: API core + guard; seeder + sweeper + ledger; web;
infra; template-link updates).

## 8. Needs the owner (outside code)

1. A token for `ever-works-cloud` with repo create + delete, dedicated to the demo.
2. A dedicated OpenRouter key with a $0 credit limit, on an account that has bought ≥ $10 of credits once.
3. A free-tier search key for generation (Tavily free plan, or name another provider).
4. OK to scale the template Deployments in `ever-works-demo-{dev,stage,prod}` to 0 and replace them.
