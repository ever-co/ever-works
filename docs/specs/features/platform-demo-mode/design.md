# Platform demo mode (demo.ever.works) — design

Status: draft for owner approval (option B + live and recorded AI chosen) · 2026-11-19 · branch `feat/platform-demo-mode`

## 1. Intent

`demo.ever.works` should be a live, try-it-yourself copy of the **Ever Works platform**, not the directory
template it serves today. A visitor lands on the demo, clicks one button, and is inside a workspace that already
holds sample data. There they create Works, build Missions, generate Goals and watch agents work, for free, on
**free OpenRouter models**. A strip at the top says it is a demo and links to a real sign-up on app.ever.works.
The directory-template demo moves to the existing `dir.ever.works` (already a template-built site).

Owner decisions (chat, 2026-11-19):

- **Option B — a private copy per click.** Each click on a demo button creates a fresh demo user plus
  Organization, seeded with the same sample data. It is deleted automatically after its time-to-live. Visitors
  never see or trample each other's work.
- **Delete the GitHub repos of expired demo users** together with the account.
- AI uses free OpenRouter models only ("all kind of free").
- Demo strip copy (owner brief 2026-11-07, already on demo.gauzy.co / demo.ever.team / demo.traduora.co):
  *"You are using a demo account. Finding our software useful? Click here to Sign Up and start using for free!"*

## 2. Goals, non-goals, anti-goals

**Goals**

1. One click from `demo.ever.works/login` to a seeded, working demo workspace. No email, no password, no
   verification.
2. The core loop works in the demo: create a Work (including AI generation of a directory Work), Missions,
   Goals that actually run (agent runs, task iterations), Tasks, Agents, chat.
3. AI cost is zero: only `:free` OpenRouter model ids are ever sent upstream.
4. Nothing in the demo can spend money or touch the outside world beyond the demo GitHub org, OpenRouter (free
   models, $0-limit key) and a free-tier web-search key.
5. Demo data cleans itself up: user, Organization, Tenant, Works, files and the demo-org GitHub repos.
6. Same image as production: demo mode is a **runtime** switch (`DEMO=true`), not a separate build.

**Non-goals**

- Real sign-up, social login, magic link or password login for new users on the demo instance (they sign up
  on app.ever.works).
- Website deploys, custom domains, App Works, Fleet / desktop / cloud nodes, terminals, billing, emails.
- Persisting anything beyond the time-to-live; "claiming" a demo account into a real one.
- A shared, Gauzy-style login (rejected: option A).

**Anti-goals (a failure even if it "works")**

- Any paid model call, Stripe call, real email, real deploy or DNS change triggered from the demo.
- Demo traffic degrading **Ever Gauzy production** (it shares the `pg` Postgres cluster), or app.ever.works.
- The repo-deleting cleanup ever touching a repo outside the demo GitHub org.
- The demo flag leaking into production behaviour (every guard is inert when `DEMO` is off).
- Demo visitors able to read each other's data (option B isolation must hold).

## 3. Constraints

- **Free-model quota is shared.** OpenRouter limits free models per account: 20 requests/minute, ~1000/day
  (with ≥ $10 of credits bought; 50/day otherwise). All visitors share it, and one directory generation is
  dozens of calls. So the demo needs a per-visitor and a global daily AI cap, with a friendly message when hit.
- **Directory generation needs GitHub.** Generated items live only in the Work's Git data repo
  (`data-generator.service.ts:353` creates it); without credentials it fails *after* spending AI calls.
- **Agent runs need Trigger.dev.** Agent task runs, chat replies and heartbeats dispatch only to Trigger.dev
  (`packages/tasks/src/dispatchers/agent-task-dispatchers.ts:31`, `JobRuntimeNotConfiguredError`). The task
  body (`agent-task-execute.task.ts`, ~1300 lines) is not something to re-implement in-process. Production uses
  the self-hosted Trigger.dev in namespace `trigger` (`trigger.ever.co`); Trigger task workers bootstrap Nest and
  connect to the database directly, so they need the demo DB's env.
- **Shared Postgres.** Works dev/stage use databases on CNPG `Cluster/pg`, which also serves Gauzy production.
  Works clients go through `pg-pooler-works` (PgBouncer, transaction mode, max 2 server connections per database
  per instance, 3 instances → ≤ 6 per database).
- **Infra rules (homelab `AGENTS.md`):** one cluster `ever-k8s`, one namespace per platform+env, three envs
  (develop → stage → main), secrets only from OpenBao via External Secrets, config in `ever-co/k8s-gitops`,
  claim on `MAINTENANCE.md` before any live change, no cherry-picking (cascade develop → stage → main whole),
  GitHub writes only in allow-listed orgs, never delete data/DBs/PVCs (the demo cleanup is a product feature the
  owner approved for the demo only).
- **Web image is built once:** `NEXT_PUBLIC_*` is baked at build time, so the web must learn about demo mode at
  runtime (from the API's public `GET /api/config`, already cached 60 s and contract-tested).

## 4. Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| A | Shared predefined accounts (Gauzy-style buttons "Demo Admin / Demo Member"), nightly wipe + reseed | Simplest; but visitors see/delete each other's Works, long AI jobs collide in one org, throttler buckets are per user so one visitor exhausts everyone's | Rejected by owner |
| **B** | **Private sandbox per click**: fresh demo user + Organization seeded from fixtures, time-to-live, automatic cleanup (reusing the anonymous-user machinery) | A few hundred rows and up to N GitHub repos per visitor; needs a sweeper + repo deletion | **Chosen** |

Within B, the sub-choices made (builder's / my calls, owner may correct):

- **Database:** Postgres (a new database per demo env on `Cluster/pg` through `pg-pooler-works`), like Works
  dev/stage. *Not* SQLite: parts of the product are Postgres-only (pgvector retrieval, Postgres-only migrations),
  and SQLite would also cap the API at one replica.
- **Job runtime:** a dedicated **Trigger.dev project "Ever Works Demo"** on the self-hosted instance, so demo
  workers can never read or write the production database. *Not* the experimental pg-boss/BullMQ runtimes
  (per-task dispatching is "operator-provisioned", agent runs are Trigger-only).
- **GitHub:** a dedicated org (proposed **`ever-works-demo`**) used as the "Ever Works Git" storage org for demo
  Works. *Not* `ever-works-cloud` (customer repos must never sit next to auto-deleted demo repos).
- **Sandbox user** = an anonymous-style user (`isAnonymous: true`, `anonymousExpiresAt`) marked
  `registrationProvider: 'demo'`. This reuses the existing session minting (`AnonymousAuthService`) and purge
  (`AnonymousUserCleanupService`), and keeps demo users out of every "real user" path (account-deletion emails,
  claims).

## 5. The design

### 5.1 Switches (API env; all default off / safe)

| Env | Default | Meaning |
|---|---|---|
| `DEMO` | off | Master switch (`true`/`1`/`yes`, like Gauzy's `DEMO`). Every guard below is inert without it. |
| `DEMO_SANDBOX_TTL_HOURS` | `24` | Life of a sandbox. |
| `DEMO_SIGN_UP_URL` | `https://app.ever.works/register` | Strip + register-page link. Must be absolute https. |
| `DEMO_GITHUB_ORG` | — | Required when `DEMO` is on and directory generation is enabled. Must equal `EVER_WORKS_CUSTOMERS_GITHUB_ORG`; the API refuses to boot in demo mode if they differ (cheap guard against pointing demo cleanup at a real org). |
| `DEMO_AI_REQUESTS_PER_SANDBOX` | `120` | LLM calls per sandbox per TTL. |
| `DEMO_AI_REQUESTS_PER_DAY` | `900` | LLM calls per instance per UTC day (below OpenRouter's free cap). |
| `DEMO_MAX_WORKS_PER_SANDBOX` | `3` | Caps repo creation per visitor. |
| `DEMO_MAX_ACTIVE_SANDBOXES` | `300` | Global cap; above it the button answers "the demo is full, try again later". |
| `DEMO_CREATE_PER_IP_PER_HOUR` | `5` | Throttle on sandbox creation. |

Free model ids are **not** new switches: the existing `PLUGIN_OPENROUTER_{DEFAULT,SIMPLE,MEDIUM,COMPLEX}_MODEL`
are set to `:free` ids in the demo's env (e.g. `google/gemma-4-31b-it:free`,
`nvidia/nemotron-3.5-super-vl:free`, `inclusionai/ling-3.2-flash:free`). The list on OpenRouter changes; the
guard below makes a stale id fail closed rather than fall through to a paid model.

### 5.2 API — new `apps/api/src/demo/` module (registered only when `DEMO` is on)

1. **`GET /api/config`** gains `features.demoMode: boolean` and `demo: { signUpUrl, sandboxTtlHours } | null`
   (allow-listed, public, safe). Update the public-config contract spec
   (`apps/web/e2e/flow-config-public-contract.spec.ts`).
2. **`POST /api/auth/demo`** (`@Public`, 404 when demo is off): body `{ captchaToken? }`.
   - Throttled per IP (`DEMO_CREATE_PER_IP_PER_HOUR`); captcha verified via `CaptchaVerifierService` when
     configured (same rule as `POST /auth/anonymous`: required in production when a provider is configured).
   - Refuses with 503 + `{code: 'DEMO_FULL'}` above `DEMO_MAX_ACTIVE_SANDBOXES`.
   - Creates the user like `AnonymousAuthService.createAnonymousUser` (username `demo-<hex>`, display name
     "Demo User", `isAnonymous: true`, `registrationProvider: 'demo'`, `anonymousExpiresAt = now + TTL`,
     `onboardingState` marked complete with storage `ever-works-git`), mints the session (expiry = TTL), then
     runs the **sandbox seeder** (5.3) and returns `{ access_token, user, expiresAt }`.
   - Seeding failure rolls back (delete the half-made user) and returns 500 with a generic message.
3. **Sandbox seeder** (`DemoSandboxSeederService`), all inside one request, target < 3 s, no AI calls, no GitHub
   calls. Content lives in a typed fixture file (`demo-sandbox.fixture.ts`) so marketing can tune it:
   - Organization "Acme Labs (Demo)" via `OrganizationService.createOrganization` (visitor = admin). *(My call,
     builder check: no "team member" variant. In code `ensureAdmin` equals `ensureMember`
     (`entities/types.ts:126-135`), so a member sandbox would look identical while doubling users per click.)*
   - 2 Teams, ~4 Agents from the onboarding starter kit (`OnboardingRoleSeedingService.seed`).
   - A **Project Work** "Launch the Acme website" (no repo; needs `EVER_WORKS_PROJECT_WORKS_ENABLED=true` in the
     demo env) with 2 Missions, 3 Goals in different states, ~8 Tasks with comments/history, and a few
     knowledge notes.
   - A **draft directory Work** "Awesome AI Coding Tools" with a prefilled prompt, ready for the visitor to press
     Generate (that is the "watch it build" moment; it creates repos in the demo org, counted against
     `DEMO_MAX_WORKS_PER_SANDBOX`).
   - **Recorded examples** (owner decision 2026-11-19: "Live + recorded examples"), so every visitor sees what
     the platform does even after the day's free AI quota is gone. All are plain DB rows written by the seeder,
     no AI and no GitHub at seed time:
     - a Goal with 2 completed iterations, each with its Tasks done and an Agent run (status succeeded, the run's
       messages/tool-call transcript, model = a free model id, cost 0);
     - a Mission with a generated plan (its proposals/Tasks) and one finished run;
     - an Agent chat conversation with a short sample exchange;
     - activity-log entries so the timelines are not empty.
     The recorded content is captured once from a real run on Works dev with free models, exported, reviewed and
     committed as a fixture (JSON next to `demo-sandbox.fixture.ts`); the seeder rewrites ids/timestamps so each
     sandbox gets its own rows ("2 hours ago" relative to sandbox creation).
   - No pre-generated directory Work: its items would need a GitHub repo per click. The login card and the
     draft directory Work link to `https://dir.ever.works` as "a site Ever Works generated"; visitors generate
     their own directory Work live while the quota lasts.
4. **Demo guard** (`DemoGuardService` + a global interceptor/guard, active only when `DEMO` is on and the caller
   is a demo user):
   - **AI**: in `AiFacadeService`, right where `enforceBudget` runs before each provider call (`askJson`,
     `createChatCompletion`, `createStreamingChatCompletion`, `embed`): force provider `openrouter`; if the
     resolved model id does not end in `:free`, replace it with the configured tier model; if that is not
     `:free` either, throw `DemoModelNotAllowedError` (fail closed). Count the call against the per-sandbox and
     the global daily caps (DB-backed counters, so all API replicas and Trigger workers share them); over the
     cap throw `DemoQuotaExceededError` → 429 with a message the web shows ("The free demo AI quota is used up
     for today — sign up on app.ever.works to keep going"). This also applies inside Trigger workers (they run
     the same facade with `DEMO=true` in their env).
   - **Rate**: besides the daily caps, a global limiter keeps the instance under OpenRouter's 20 requests/minute
     for free models (target ≤ 18/min, DB-backed token bucket shared by API replicas and Trigger workers).
     Background work (generation steps, agent iterations) waits for a token (bounded wait, then fails the step
     with the quota message); interactive chat gets a 429 "busy, retry in a few seconds".
   - **Embeddings**: `embed` goes through the same guard (the builder check found it skips `enforceBudget`) and
     uses the free embedding model `nvidia/nemotron-3.5-embed-1b:free` (OpenRouter lists three free embedding
     models today), so knowledge notes, pgvector retrieval and agent memory keep working.
   - **Pipelines**: generation is locked to `standard-pipeline` in the demo. `agent-pipeline` (own model client,
     `agent-pipeline.plugin.ts:492`) and the CLI pipelines (claude-code, codex, gemini, opencode, hermes-agent;
     own keys) are disabled for demo users and hidden from the pipeline picker; Agents run on the platform
     OpenRouter provider only.
   - **Generation helpers**: web search uses a dedicated **free-tier** search key (Tavily free plan; owner
     provides it, it cannot spend money); screenshots are off (the image step is skipped, placeholders shown);
     content extraction uses the bundled `local-content-extractor` (no key).
   - **Model choice surfaces**: `GET /api/plugins/:id/models` returns only `:free` models; chat/agent DTOs with a
     non-free `model` are rewritten by the facade rule above (no 4xx, the picker just never offers them).
   - **Blocked in demo (403 `{code: 'DEMO_DISABLED'}`)**: plugin settings writes that carry secrets (BYOK) at
     user/org/work scope, the OpenAI-compatible endpoint `POST /api/v1/chat/completions`, API key creation,
     model accounts / credentials, outbound webhooks, notification channels, MCP connections, Composio/Zapier
     and other integration connects, OAuth "connect GitHub/Vercel", deploy / add-domain, App Works, account claim,
     password/email change, account deletion request (the sweeper does it), org invites by email, data export.
     The list is one table in code (route-pattern → reason) with a unit test that it is non-empty and that each
     pattern matches a real route.
   - **Works**: `storageProvider` forced to `ever-works-git` (repos land in `DEMO_GITHUB_ORG`, private),
     `deployProvider` forced to an inert value so generation never deploys; `DEMO_MAX_WORKS_PER_SANDBOX`
     enforced on create.
   - **Registration**: `POST /api/auth/register`, magic link and social callbacks answer 403 `DEMO_DISABLED`
     when `DEMO` is on (the instance has no real users except platform operators, who log in normally).
5. **Sweeper** (`DemoSandboxSweeperService`, Nest `@Cron` every 15 min, wrapped in
   `DistributedTaskLockService.runExclusive`, only when `DEMO` is on), for each expired demo user
   (`registrationProvider = 'demo'` and `anonymousExpiresAt < now`, batches of 20):
   1. For each of its Works: delete the Work's GitHub repos (data + website) **only if** the repo owner equals
      `DEMO_GITHUB_ORG` (hard check on the resolved owner; anything else is logged and skipped, never deleted).
      "Repo already gone" counts as success.
   2. Delete Works through the normal `deleteWork` path, then the user via
      `AnonymousUserCleanupService` (storage GC + row cascade), then the now-empty demo Organization and Tenant.
   3. One failure logs and continues; a sandbox that fails 3 times is reported in the log with its id.
   The existing nightly `anonymous-user-cleanup` (`UserRepository.findExpiredAnonymous`, filters on
   `isAnonymous` only, `user.repository.ts:268`) must **exclude** `registrationProvider = 'demo'`; otherwise it
   can delete a demo user and its Works first and orphan their GitHub repos in the demo org.

### 5.3 Web

1. Read `features.demoMode` + `demo` from the API config (server side, same fetch-and-fail-closed pattern as
   `lib/feature-flags/app-launcher.ts`), pass down as props.
2. **Login page** (`(auth)/login/page.tsx`, `login-client.tsx`) in demo mode: a top card *"Try Ever Works — no
   sign-up needed"* with one primary button, **"Start the demo"**, plus a line: "Your private demo workspace is
   deleted after 24 hours. AI runs on free models and may be slower." The email/password form stays below,
   collapsed under "Operator login". The button calls a new
   server action `startDemo()` (template: `actions/onboarding/anonymous.ts`) → `POST /api/auth/demo` →
   `setAuthAccessCookie` → redirect to the dashboard home. Turnstile (managed/invisible) token is passed when a
   site key is configured.
3. **Landing**: `/` for a signed-out visitor on a demo instance goes to `/login` (already the case for the
   app); the register page shows a card pointing to `DEMO_SIGN_UP_URL` plus the demo buttons instead of the form.
4. **Demo strip** for demo users, above `DashboardHeader` in `(dashboard)/layout-client.tsx`, modelled on
   `JobRuntimeDegradedBanner` (role="status", next-intl, not dismissible): the owner's copy, with "Click here to
   Sign Up" linking to `DEMO_SIGN_UP_URL` (new tab), plus a small "Demo workspace expires in 23 h" countdown.
5. **Friendly errors**: `DEMO_DISABLED` → toast "Not available in the demo — sign up to use it"; quota 429 →
   the quota message; `DEMO_FULL` → message on the login card. When the daily AI quota is used up (the API
   reports `demo.aiQuotaExhausted` on the demo user's profile/config), the strip adds "Live AI is used up for
   today — explore the recorded examples" and links to the recorded Goal.
6. Strings in `en` plus the existing locales' fallbacks (next-intl); follow the repo's i18n checks.

### 5.4 Infrastructure (`ever-co/k8s-gitops`, OpenBao, Trigger.dev, GitHub)

1. **Namespaces**: reuse `ever-works-demo-{dev,stage,prod}` (hosts `demodev`, `demostage`, `demo.ever.works`
   unchanged). Replace the template `web` Deployment with the platform's `ever-works-api` (2 replicas) +
   `ever-works-web` (2 replicas), images `ghcr.io/ever-works/ever-works-{api,web}:{dev,stage,prod}`, ArgoCD
   Image Updater annotations switched to those images. No MCP. Ingress: `demo*.ever.works` → web; the API is
   reached by the web in-cluster (`API_URL=http://ever-works-api:3100`); browser-side API calls go through the
   web's existing proxy routes (to be confirmed by the builder; if the browser needs a public API host, add
   `api-demo*.ever.works` with the cert/tunnel pattern of `api-*.ever.works`). Old template manifests are
   removed from Git; per the no-removal rule the old `web` Deployment is scaled to 0 and annotated
   `ever-works.io/retired` first, then deleted only with the owner's OK (prune is off on these apps).
2. **Databases**: `ever_works_demo_dev`, `ever_works_demo_stage`, `ever_works_demo` on `Cluster/pg`
   (CNPG `Database` CRs in `apps/databases`, roles created out of band, least privilege, `CONNECTION LIMIT 10`,
   reclaim `retain`), added to `pg-pooler-works`. Backups-first and a board claim before the `databases` sync.
   The API self-migrates on boot.
3. **Secrets**: OpenBao `kv/ever-works/demo/{dev,stage,prod}` → `ExternalSecret ever-works-demo-secrets` per
   namespace (DB creds, `AUTH_SECRET`, `PLATFORM_ENCRYPTION_KEY`, `PLUGIN_SECRET_ENCRYPTION_KEY`, OpenRouter key,
   demo GitHub PAT, Trigger secret key, captcha secret). Plain flags (`DEMO=true`, model ids, switches off) live
   in the Deployment env in Git.
4. **Trigger.dev**: a new project "Ever Works Demo" on `trigger.ever.co` with environments `staging`
   (demostage) and `prod` (demo); its env vars = the demo API's env. The deploy workflow
   (`.github/workflows/release-trigger-selfhosted.yml`) deploys the same task bundle to this project too (a
   second job/matrix entry keyed on a `TRIGGER_DEMO_PROJECT_REF` variable). demodev runs without Trigger (as
   Works dev does today), so goals there are created but do not execute. *(My call, builder check:)* each demo
   Trigger environment gets a hard concurrency limit (2 runs) so demo runs can never crowd out app.ever.works
   runs on the shared self-hosted workers; no separate worker group.
5. **GitHub**: org `ever-works-demo` (owner creates it and adds it to the agent org allow-list), a token with
   repo create + delete rights in that org only.
6. **OpenRouter**: a dedicated API key for the demo with a **credit limit of $0**, so even a bug in the guard
   cannot buy a paid call (OpenRouter rejects paid models on a zero-limit key). Owner creates it.
7. Explicitly **off** in the demo env: Stripe keys + `STRIPE_RELAY_ENABLED`, `SUBSCRIPTIONS_ENABLED`, credits
   enforcement, `DEPLOY_EVER_WORKS_ENABLED`, `EVER_WORKS_APP_*`, `FLEET_ENABLED=false` + all `FLEET_*`,
   `TERMINAL_SESSIONS_ENABLED`, `EVER_CONNECT_*`, `EVER_STATS_ENABLED`, `SCHEDULED_UPDATES_ENABLED`,
   `WEBSITE_TEMPLATE_AUTO_UPDATE_ENABLED`, `USER_RESEARCH_ENABLED`, `MAGIC_LINK_ENABLED`, OAuth client ids,
   `MAILER_PROVIDER=none`, PostHog/Sentry optional. `REQUIRE_EMAIL_VERIFICATION` stays on (no one registers).
   `EVER_WORKS_PROJECT_WORKS_ENABLED=true`, `STORAGE_EVER_WORKS_GIT_ENABLED=true`.

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
2. Normal cascade develop → stage → main (no cherry-picks), coordinated on the board with the lanes that are
   cascading today; demostage then demo follow their image tags.
3. Infra per env in order dev → stage → prod: DB, OpenBao secret, ExternalSecret, Deployments, Trigger project
   env. Verify each: login card visible, button lands in a seeded workspace, strip visible, a Goal runs one
   iteration on a free model, a directory Work generates into `ever-works-demo`, a forced sweeper run deletes an
   expired sandbox and its repos, no non-`:free` model id in the API logs.

## 6. Testing

- API unit: demo config shape; `POST /auth/demo` (off → 404, throttle, cap, rollback on seed failure); seeder
  output counts and isolation (two sandboxes never share an Organization/Tenant); guard table; model rewrite +
  fail-closed; quota counters; sweeper (repo owner check, idempotency, partial failure).
- API e2e (Postgres): full flow create → act → expire → sweep, with the GitHub facade faked.
- Web unit: login card, strip, server action. Playwright: demo button → dashboard → strip visible; strip absent
  when `DEMO` is off.
- Boot the built API + web with `DEMO=true` against a local Postgres and click through (repo rule: green CI is
  not proof the app boots). Public-contract check: `/api/config` keys only added, nothing removed.

## 7. Left to the builder

Exact file/route names, the counter table design (a small `demo_usage_counters` table with a migration, or an
existing generic counter if one fits), fixture wording, how the sweeper resolves each Work's repo names (use the
same resolvers generation uses), whether the web needs a public API host, i18n plumbing, and splitting the work
into PRs (suggested: API core + guard; seeder + sweeper; web; infra; template-link updates).

## 8. Needs the owner (outside code)

1. Create GitHub org `ever-works-demo` (or name another) and approve it for agent writes; create a token there
   with repo create/delete.
2. Create the dedicated OpenRouter key with a $0 credit limit (or approve reusing the dev key with a limit).
   The account it sits under must have bought ≥ $10 of credits once (free-model cap 1000/day instead of 50/day).
3. A free-tier search key for generation (Tavily free plan, or name another provider).
4. OK to replace the template Deployments in `ever-works-demo-{dev,stage,prod}` (scale old to 0 first).
