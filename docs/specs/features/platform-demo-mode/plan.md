# Platform Demo Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runtime `DEMO=true` mode for the Ever Works platform. One click on `/login` creates a private, seeded
24-hour sandbox. The instance uses free OpenRouter models only, risky features are blocked, and expired
sandboxes are swept together with exactly the GitHub repos they created.

**Architecture:** A new API module `apps/api/src/demo/` (sandbox creation, seeder, route guard, quota counters,
repo ledger, sweeper) is registered only when `DEMO` is on. A small policy layer in `packages/agent/src/demo/`
is used by `AiFacadeService` (free-model rewrite, quota port), `EverWorksGitProvider` (ledger port) and
`UserRepository`, so the same rules apply inside Trigger.dev workers. They reach the API's counters through the
existing remote-proxy channel. The web reads `features.demoMode` from `GET /api/config` at runtime and shows the
login card and the demo strip.

**Tech Stack:** NestJS 11 + TypeORM 0.3 (SQLite in the demo, Postgres elsewhere), Next.js 16 App Router +
next-intl, Jest (api, agent), Vitest (web), Playwright (web e2e). Node ≥ 26, pnpm.

**Spec:** `docs/specs/features/platform-demo-mode/design.md` (owner-approved 2026-11-19). Read it first. This
plan covers the platform code only. Infra (k8s-gitops, OpenBao, Trigger project, PVC) and the template-link
updates get a separate rollout plan once this merges.

## Global Constraints

- Every behaviour change is inert when `DEMO` is unset: no new route, no rewritten model, no blocked route, no
  cron. Each task has a "demo off" test.
- `DEMO` truthy = `true` | `1` | `yes` (case-insensitive, trimmed).
- Defaults: `DEMO_SANDBOX_TTL_HOURS=24`, `DEMO_SIGN_UP_URL=https://app.ever.works/register`,
  `DEMO_REPO_PREFIX=demo-`, `DEMO_AI_REQUESTS_PER_SANDBOX=120`, `DEMO_AI_REQUESTS_PER_DAY=900`,
  `DEMO_AI_REQUESTS_PER_MINUTE=18`, `DEMO_MAX_WORKS_PER_SANDBOX=3`, `DEMO_MAX_ACTIVE_SANDBOXES=300`,
  `DEMO_CREATE_PER_IP_PER_HOUR=5`.
- Demo user: `username = 'demo-' + 8 hex`, `isAnonymous = true`, `registrationProvider = 'demo'`,
  `anonymousExpiresAt = now + TTL`.
- A model id is free iff it ends with `:free`. Nothing else counts.
- Error codes (JSON `code` field): `DEMO_DISABLED` (403), `DEMO_FULL` (503), `DEMO_AI_QUOTA` (429),
  `DEMO_AI_BUSY` (429, with `retryAfterMs`), `DEMO_MODEL_NOT_ALLOWED` (500, fail closed),
  `DEMO_MODEL_UNAVAILABLE` (503).
- Strip copy, verbatim: "You are using a demo account. Finding our software useful? Click here to Sign Up and
  start using for free!" ("Click here to Sign Up" is the link).
- Repo deletion happens only when all four hold: a ledger row for this sandbox; owner `===` `DEMO_GITHUB_ORG`;
  name starts with `DEMO_REPO_PREFIX`; live GitHub repo id `===` ledger id. The code never lists the org and
  never deletes by pattern.
- Repo conventions (`CLAUDE.md`): pnpm only; tabs, width 120, single quotes, no trailing commas; conventional
  commits; every entity change ships a Postgres migration in the same PR. After changing `packages/agent`,
  rebuild it (`cd packages/agent && npx nest build -b swc && npx tsc -p tsconfig.types.json`) before running api
  tests. Use `getOptionalProvider` (not `ModuleRef.get`) for optional providers.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Sandbox expired or swept mid-session.** The next request gets a 401 and the cookie is cleared. The visitor
   must land on `/login?demo=expired` and see "Your demo workspace expired — start a new one", not a generic
   error. Test in Task 11.
2. **Double click on "Start the demo".** Exactly one sandbox should be created: the button is disabled while
   pending and the action is not re-entrant. Test in Task 11.
3. **A configured free model was removed from OpenRouter** (upstream 404 / "model not found"). The visitor sees
   "The demo AI model is temporarily unavailable" and the API logs an error naming the model id, instead of a
   raw provider error. Test in Task 3.
4. **An operator (non-demo user) logs in on a demo instance.** They are not blocked by the route guard, but
   still get free models only (the AI policy is instance-wide). Test in Task 7.
5. **A generation is interrupted by an API restart** (the demo uses `Recreate` rollouts). The Work must not sit
   "running" forever: the demo env sets `DIRECTORY_STALE_TIMEOUT_HOURS=0.5` so the existing stale sweep fails it
   within 30 minutes. Task 1 Step 4 makes that accessor accept fractional hours.

---

### Task 1: Demo config accessors, boot check, public config

**Files:**
- Modify: `packages/agent/src/config/index.ts` (add a `demo` block next to `appLauncher`, ~L2911)
- Create: `packages/agent/src/config/__tests__/demo-config.spec.ts`
- Modify: `apps/api/src/api.controller.ts:78-124` (`getConfig`)
- Modify: `apps/web/e2e/flow-config-public-contract.spec.ts` (add the new keys)
- Create: `apps/api/src/demo/demo-boot-check.ts` + `apps/api/src/demo/__tests__/demo-boot-check.spec.ts`

**Interfaces:**
- Produces: `config.demo.isEnabled(): boolean`, `.sandboxTtlHours(): number`, `.signUpUrl(): string`,
  `.githubOrg(): string`, `.repoPrefix(): string`, `.aiRequestsPerSandbox(): number`, `.aiRequestsPerDay(): number`,
  `.aiRequestsPerMinute(): number`, `.maxWorksPerSandbox(): number`, `.maxActiveSandboxes(): number`,
  `.createPerIpPerHour(): number`. Positive integers fall back to the defaults on garbage. `signUpUrl` falls back
  when it is not absolute `https:`.
- Produces: `assertDemoConfig(): void` (throws `Error` naming the env vars). It runs only when the demo is
  enabled: it requires `DEMO_GITHUB_ORG` non-empty and equal to `config.everWorks.git.getOrg()` when
  `config.everWorks.git.isEnabled()`.
- Produces: `/api/config` → `features.demoMode: boolean` and top-level `demo: { signUpUrl: string;
  sandboxTtlHours: number } | null`.

- [ ] **Step 1: Write failing tests.** `demo-config.spec.ts`: `isEnabled` true for `'true'`, `'1'`, `'YES '`;
  false for unset, `'false'`, `'0'`; `sandboxTtlHours()` → 24 when unset, 24 for `'abc'`, 6 for `'6'`;
  `signUpUrl()` → default for `'http://x'` and `'/register'`, kept for `'https://app.ever.works/register'`.
  `demo-boot-check.spec.ts`: no throw when the demo is off whatever the org; throws
  `/DEMO_GITHUB_ORG/` when on with git enabled and `DEMO_GITHUB_ORG='ever-works-demo'` vs
  `EVER_WORKS_CUSTOMERS_GITHUB_ORG='ever-works-cloud'`; passes when both are `ever-works-cloud`.
  Contract spec: `features.demoMode === false` and `demo === null` on the default test server.
- [ ] **Step 2: Run them to see them fail.** `cd packages/agent && npx jest demo-config` → FAIL
  (`config.demo` undefined); `cd apps/api && npx jest demo-boot-check` → FAIL (module not found).
- [ ] **Step 3: Implement** the accessors, `assertDemoConfig`, and the two `getConfig` fields (allow-list
  comment: both are public-safe).
- [ ] **Step 4: Check the stale-timeout accessor.** Read the `DIRECTORY_STALE_TIMEOUT_HOURS` accessor in
  `packages/agent/src/config/index.ts`. If it parses integers only, make it accept a positive decimal, with a
  unit test that `'0.5'` → 0.5 and the old integer cases are unchanged (Review Focus 5).
- [ ] **Step 5: Run tests to see them pass.** The same commands, plus `cd apps/api && npx jest api.controller` →
  PASS.
- [ ] **Step 6: Commit** `feat(demo): demo config accessors and public config flags`.

### Task 2: Demo tables (usage counters, repo ledger)

**Files:**
- Create: `packages/agent/src/entities/demo-usage-counter.entity.ts`,
  `packages/agent/src/entities/demo-github-repo.entity.ts`
- Modify: `packages/agent/src/database/_entities-inventory.ts` (register both)
- Create: `packages/agent/src/database/repositories/demo-usage-counter.repository.ts`,
  `packages/agent/src/database/repositories/demo-github-repo.repository.ts` (+ export from the repositories
  index and `DatabaseModule` providers, following `WorkKnowledgeChunkRepository`)
- Create: `apps/api/src/migrations/1798300000000-AddDemoModeTables.ts` (Postgres only, guarded on the driver like
  `1782100000000-CreateGoalsTables.ts`; SQLite gets the tables from auto-sync)
- Test: `packages/agent/src/database/repositories/__tests__/demo-repos.spec.ts` (SQLite in-memory, like the
  existing repository specs)

**Interfaces:**
- Produces: entity `DemoUsageCounter` table `demo_usage_counters`: `key varchar(160) PK`, `count int not null
  default 0`, `windowEndsAt timestamp not null`, `updatedAt`.
- Produces: `DemoUsageCounterRepository.increment(key: string, windowEndsAt: Date, now: Date): Promise<number>`.
  It returns the new count; if the stored window ended (`windowEndsAt <= now`) it resets to 1 with the new
  window. It must be atomic per key: one transaction with `INSERT … ON CONFLICT DO UPDATE` on Postgres, and a
  transaction on SQLite, which serializes writers. `.peek(key: string, now: Date): Promise<number>` returns 0
  for a missing or ended window.
- Produces: entity `DemoGithubRepo` table `demo_github_repos`: `id uuid PK`, `sandboxUserId uuid not null`
  (indexed, **no FK**, so the ledger survives the user delete until the repo is gone), `owner varchar`,
  `name varchar`, `githubId bigint null`, `createdAt`, `deletedAt null`, `lastError text null`, `attempts int
  default 0`.
- Produces: `DemoGithubRepoRepository.record(row: {sandboxUserId; owner; name; githubId: number | null}):
  Promise<DemoGithubRepo>`, `.pendingForSandbox(sandboxUserId: string): Promise<DemoGithubRepo[]>` (where
  `deletedAt` is null), `.markDeleted(id: string, at: Date)`, `.markFailed(id: string, error: string)`.

- [ ] **Step 1: Write failing tests.** `increment` returns 1, 2, 3 in one window and 1 after the window ends;
  20 concurrent `increment` calls on one key end at 20; `record` + `pendingForSandbox` returns only non-deleted
  rows of that sandbox; `markFailed` bumps `attempts`.
- [ ] **Step 2: Run them to see them fail.** `cd packages/agent && npx jest demo-repos` → FAIL.
- [ ] **Step 3: Implement** the entities, repositories and the migration (`up` creates both tables + an index on
  `demo_github_repos(sandboxUserId)`; `down` drops them).
- [ ] **Step 4: Run them to see them pass**, plus `cd apps/api && npx jest migrations` (the repo's
  migration-shape specs) → PASS.
- [ ] **Step 5: Commit** `feat(demo): usage counter and GitHub repo ledger tables`.

### Task 3: Free-model policy in `AiFacadeService` + quota port

**Files:**
- Create: `packages/agent/src/demo/demo-ai-policy.ts`, `packages/agent/src/demo/demo-errors.ts`,
  `packages/agent/src/demo/index.ts` (+ a `demo` sub-export in `packages/agent/package.json` exports, like the
  other sub-modules)
- Modify: `packages/agent/src/facades/ai.facade.ts` (constructor ~L115; `askJson` ~L391; `createChatCompletion`
  ~L617; `createStreamingChatCompletion` ~L711; `embed` ~L816; the escalation helper `escalateModel` ~L525-561)
- Test: `packages/agent/src/demo/__tests__/demo-ai-policy.spec.ts`,
  `packages/agent/src/facades/__tests__/ai.facade.demo.spec.ts`

**Interfaces:**
- Produces (`demo-errors.ts`): `class DemoError extends Error { code; httpStatus; retryAfterMs? }` and the
  subclasses `DemoFeatureDisabledError(feature: string)` (`DEMO_DISABLED`, 403),
  `DemoQuotaExceededError(scope: 'sandbox' | 'day')` (`DEMO_AI_QUOTA`, 429),
  `DemoRateLimitedError(retryAfterMs: number)` (`DEMO_AI_BUSY`, 429),
  `DemoModelNotAllowedError(modelId: string)` (`DEMO_MODEL_NOT_ALLOWED`, 500),
  `DemoModelUnavailableError(modelId: string)` (`DEMO_MODEL_UNAVAILABLE`, 503, message "The demo AI model is
  temporarily unavailable").
- Produces (`demo-ai-policy.ts`): `isFreeModelId(id: string | undefined): boolean`;
  `pickFreeModel(requested: string | undefined, settings: Record<string, unknown>, tier?: 'simple' | 'medium' |
  'complex'): string`. It returns `requested` if free; else `settings[`${tier}Model`]` if free; else
  `settings.defaultModel` if free; else throws `DemoModelNotAllowedError(requested ?? '')`.
  `DEMO_AI_PROVIDER_ID = 'openrouter'`.
- Produces: injection token `DEMO_AI_QUOTA` and `interface DemoAiQuotaPort { consume(userId: string |
  undefined): Promise<void> }`. It throws `DemoQuotaExceededError` or `DemoRateLimitedError`.
- Consumes: `config.demo.isEnabled()` (Task 1).

- [ ] **Step 1: Write failing policy tests.** `isFreeModelId('google/gemma-4-31b-it:free')` true;
  `isFreeModelId('openai/gpt-6.1-sol')` false; `isFreeModelId('x:free:')` false; `pickFreeModel('openai/gpt-6.1-sol',
  { complexModel: 'a:free', defaultModel: 'b:free' }, 'complex')` → `'a:free'`; with no free setting → throws
  `DemoModelNotAllowedError`.
- [ ] **Step 2: Write failing facade tests** (fake plugin registry, `DEMO=true`, OpenRouter settings with free
  tier models). Cases:
  - `askJson` with `routing.modelOverride: 'openai/gpt-6.1-sol'` calls the plugin with the tier's free model.
  - `providerOverride: 'anthropic'` still resolves the `openrouter` plugin.
  - `createChatCompletion({ model: 'openai/gpt-4o' })` sends a free model.
  - The quota port's `consume` is called once per call with `facadeOptions.userId`.
  - `consume` rejecting with `DemoQuotaExceededError` → the call rejects with it and the plugin is not called.
  - `askJson` with `consume` rejecting `DemoRateLimitedError(50)` once and then resolving retries and succeeds
    (fake timers).
  - `createChatCompletion` with the same rethrows `DemoRateLimitedError` (interactive, no wait).
  - A plugin error whose message matches `/model.*(not found|does not exist)|No endpoints found/i` →
    `DemoModelUnavailableError` (Review Focus 3).
  - `embed` → `DemoFeatureDisabledError('embeddings')` without calling the plugin.
  - The escalation path never escalates to a non-free model.
  - With `DEMO` unset, every existing facade spec passes unchanged (run the whole facade suite).
- [ ] **Step 3: Run them to see them fail.** `cd packages/agent && npx jest demo-ai-policy ai.facade.demo` → FAIL.
- [ ] **Step 4: Implement.**
  - Add `@Optional() @Inject(DEMO_AI_QUOTA) private readonly demoQuota?: DemoAiQuotaPort` as the last
    constructor param.
  - In each of the three call methods, when the demo is on: pass `DEMO_AI_PROVIDER_ID` to `resolvePlugin`;
    replace the resolved/effective model with `pickFreeModel(…, routing?.complexity)`; `await
    this.consumeDemoQuota(facadeOptions, mode)` right before `enforceBudget`.
  - `consumeDemoQuota`: for `'background'` (askJson), retry on `DemoRateLimitedError` sleeping `retryAfterMs`,
    up to 60 s in total, then rethrow; for `'interactive'` (chat/streaming), call once.
  - Guard the escalation result with `isFreeModelId`, falling back to the current model.
  - Map provider "model not found" errors to `DemoModelUnavailableError` and `logger.error` the model id.
  - `embed`: throw `DemoFeatureDisabledError('embeddings')` first thing when the demo is on.
- [ ] **Step 5: Check every `embed` caller.** `git grep -n "\.embed(" packages apps -- ':!*.spec.ts'`. Each
  caller must already catch facade errors and degrade (KB semantic search → lexical, memory → no vector). For
  any that does not, wrap it in `try/catch` treating `DemoFeatureDisabledError` as "no semantic signal", with a
  unit test per changed caller.
- [ ] **Step 6: Rebuild the agent package and run tests.** `cd packages/agent && npx nest build -b swc && npx tsc
  -p tsconfig.types.json && npx jest facades demo` → PASS.
- [ ] **Step 7: Commit** `feat(demo): free-model policy and quota port in the AI facade`.

### Task 4: API quota service + Trigger remote proxy

**Files:**
- Create: `apps/api/src/demo/demo-ai-quota.service.ts`, `apps/api/src/demo/demo.module.ts`
- Modify: `apps/api/src/api.module.ts` (import `DemoModule.register()`, which returns an empty module when the
  demo is off; call `assertDemoConfig()` in its `onModuleInit`)
- Modify: `apps/api/src/trigger/trigger-internal.controller.ts` (`remoteMap` ~L1150: add `DemoAiQuotaService`
  when injected, `@Optional()`)
- Modify: `packages/tasks/src/trigger/worker/modules/trigger-facades.module.ts` (provide `DEMO_AI_QUOTA` via
  `createRemoteProxy(apiClient, 'DemoAiQuotaService')` when `config.demo.isEnabled()`)
- Modify: the global exception filter that maps errors to HTTP (find it with `git grep -n "implements
  ExceptionFilter" apps/api/src`) so any `DemoError` becomes `{ statusCode, code, message, retryAfterMs? }`
- Test: `apps/api/src/demo/__tests__/demo-ai-quota.service.spec.ts`,
  `apps/api/src/demo/__tests__/demo-error.filter.spec.ts`

**Interfaces:**
- Consumes: `DemoUsageCounterRepository.increment/peek` (Task 2), `config.demo.*` (Task 1), `DemoAiQuotaPort`
  and errors (Task 3).
- Produces: `DemoAiQuotaService implements DemoAiQuotaPort`, provided as `DEMO_AI_QUOTA` globally by
  `DemoModule`. Keys: `ai:sandbox:<userId>` (window = the user's `anonymousExpiresAt`), `ai:day:<YYYY-MM-DD>`
  (window = next UTC midnight), `ai:min:<YYYY-MM-DDTHH:MM>` (window = minute end). The minute check runs first
  and throws `DemoRateLimitedError(ms to the minute end)`. Then the day and sandbox checks throw
  `DemoQuotaExceededError`. An `undefined` userId (system jobs) skips the sandbox counter only.
- Produces: `DemoAiQuotaService.isDayExhausted(now?: Date): Promise<boolean>` (Task 12 uses it).

- [ ] **Step 1: Write failing tests.**
  - The 121st call for one user (per-sandbox 120) → `DemoQuotaExceededError('sandbox')`.
  - The 901st call in a UTC day across users → `'day'`.
  - The 19th call in one minute → `DemoRateLimitedError` with `0 < retryAfterMs <= 60000`.
  - The next minute → allowed.
  - `isDayExhausted` flips at 900.
  - Filter: `DemoQuotaExceededError` → 429 body `{ code: 'DEMO_AI_QUOTA' }`; `DemoFeatureDisabledError` → 403
    `DEMO_DISABLED`.
  - The trigger controller spec: `remote/call` with `name: 'DemoAiQuotaService', method: 'consume'` is
    allowed when provided, and an unknown target when the demo is off.
- [ ] **Step 2: Run them to see them fail.** `cd apps/api && npx jest demo-ai-quota demo-error.filter
  trigger-internal.controller` → FAIL.
- [ ] **Step 3: Implement.** Make the worker side surface a remote `DEMO_AI_*` failure with its `code`: read
  `TriggerInternalApiClient.callRemote` error handling and rethrow the matching `DemoError` subclass from the
  response body's `code`, with a unit test in `packages/tasks`.
- [ ] **Step 4: Run tests to see them pass**, plus `cd packages/tasks && npx jest remote-proxy` → PASS.
- [ ] **Step 5: Commit** `feat(demo): DB-backed AI quota, remote proxy for workers, error mapping`.

### Task 5: `POST /api/auth/demo` — sandbox user + session

**Files:**
- Create: `apps/api/src/demo/demo-sandbox.service.ts`, `apps/api/src/demo/demo.controller.ts`,
  `apps/api/src/demo/dto/create-demo-sandbox.dto.ts`
- Modify: `packages/agent/src/database/repositories/user.repository.ts:268` (`findExpiredAnonymous` excludes
  `registrationProvider = 'demo'`); add `findExpiredDemo(now: Date, limit: number): Promise<User[]>` and
  `countActiveDemo(now: Date): Promise<number>`
- Test: `apps/api/src/demo/__tests__/demo-sandbox.service.spec.ts`,
  `apps/api/src/demo/__tests__/demo.controller.spec.ts`,
  `packages/agent/src/database/repositories/__tests__/user.repository.demo.spec.ts`

**Interfaces:**
- Consumes: the `AnonymousAuthService.createAnonymousUser` pattern
  (`apps/api/src/auth/services/anonymous-auth.service.ts:58-111`: `userRepository.create`, `AuthSession` row with
  `tokenHash = hashSessionToken(raw)`), `CaptchaVerifierService` (same use as `auth.controller.ts:263-276`), the
  `@Throttle` decorator.
- Produces: `DemoSandboxService.createSandbox(meta: { ipAddress: string | null; userAgent: string | null }):
  Promise<{ access_token: string; user: { id: string; username: string; isDemo: true }; expiresAt: string }>`.
  It throws `DemoError` subclasses. It calls `DemoSandboxSeederService.seed(user)` (Task 6). If that throws, it
  deletes the user (cascade) and rethrows a generic `InternalServerErrorException('Could not start the demo')`.
- Produces: route `POST /api/auth/demo` (`@Public`, `@Throttle({ demo: { limit:
  config.demo.createPerIpPerHour(), ttl: 3_600_000 } })` per IP, captcha checked when
  `captchaVerifier.isEnabled()`). It exists only when `DemoModule` is registered, so it is a 404 when the demo is
  off. Over `maxActiveSandboxes` → `DemoError` `DEMO_FULL` (503).
- Produces: user fields `onboardingState` = `ONBOARDING_DEFAULT_STATE` with `completedAt = now`, storage
  `ever-works-git` and deploy `ever-works`; display name "Demo User".

- [ ] **Step 1: Write failing tests.**
  - Service: the user has `username` matching `/^demo-[0-9a-f]{8}$/`, `registrationProvider 'demo'`,
    `isAnonymous true`, `anonymousExpiresAt` ≈ now + 24 h, and a session row with `expiresAt` equal to it and
    `token` null.
  - The seeder is called once with the user.
  - The seeder throwing → the user row is gone and a generic 500 is thrown.
  - `countActiveDemo >= 300` → `DEMO_FULL`.
  - Controller: captcha enabled + bad token → 400; the throttle metadata is present.
  - Repository: `findExpiredAnonymous` ignores an expired demo user; `findExpiredDemo` returns only expired demo
    users, `limit` respected; `countActiveDemo` counts unexpired demo users.
- [ ] **Step 2: Run them to see them fail.** `cd apps/api && npx jest demo-sandbox demo.controller` and `cd
  packages/agent && npx jest user.repository.demo` → FAIL.
- [ ] **Step 3: Implement** the service, DTO (`captchaToken?: string`, max 4096) and controller, and register
  the controller in `DemoModule`.
- [ ] **Step 4: Rebuild agent, run tests to see them pass.**
- [ ] **Step 5: Commit** `feat(demo): one-click demo sandbox endpoint`.

### Task 6: Sandbox seeder — workspace, Project Work, draft directory Work

**Files:**
- Create: `apps/api/src/demo/seed/demo-sandbox.fixture.ts`, `apps/api/src/demo/seed/demo-sandbox-seeder.service.ts`
- Test: `apps/api/src/demo/__tests__/demo-sandbox-seeder.spec.ts` (SQLite in-memory API test module; follow an
  existing integration-style api spec that boots `DatabaseModule` on SQLite)

**Interfaces:**
- Consumes: `OrganizationService.createOrganization(userId, name, slugOverride?, extra?)`
  (`apps/api/src/organizations/organization.service.ts:492`), `TeamsService.create`
  (`packages/agent/src/teams/teams.service.ts:105`), `OnboardingRoleSeedingService.seed(userId, roles)`
  (`packages/agent/src/agents/role-seeding.service.ts:53`), `WorkLifecycleService.createProjectWork`
  (`work-lifecycle.service.ts:1411`) and `createDraftWork` (`:1511`), `MissionsService.create`
  (`missions.service.ts:589`), `GoalsService.create` (`goals.service.ts:312`), `TasksService.create`
  (`tasks.service.ts:961`).
- Produces: `DemoSandboxSeederService.seed(user: User): Promise<DemoSeedSummary>` with `DemoSeedSummary = {
  organizationId: string; projectWorkId: string; directoryWorkId: string; recordedGoalId: string | null }`
  (Task 9 fills `recordedGoalId`).
- Produces: `DEMO_SANDBOX_FIXTURE` (typed const): org name "Acme Labs (Demo)"; teams "Product" and "Growth";
  starter-kit roles (pick 4 ids that exist in the role catalogue, e.g. researcher, writer, developer,
  marketer — check `OnboardingRoleSeedingService`'s catalogue); Project Work "Launch the Acme website" with
  Missions "Ship the launch site" and "Grow newsletter signups", Goals "Publish the launch blog post"
  (completed), "Collect 100 newsletter signups" (in progress), "Add a pricing page" (not started), 8 Tasks
  across them with 1–2 comments each, and 3 short knowledge notes; draft directory Work "Awesome AI Coding Tools"
  with prompt "A curated directory of AI coding assistants, code-review bots and agentic IDEs, with pricing and
  open-source status".
- Constraint: no AI and no GitHub calls (`AiFacadeService` and `GitFacadeService` must not be invoked: assert
  with spies). Target < 3 s on SQLite.

- [ ] **Step 1: Write failing tests.**
  - After `seed(user)`: one Organization where the user is admin, 2 Teams, ≥ 4 Agents, 2 Works of kinds
    `project` and the directory kind; the directory Work is in draft (no `sourceRepository`); 2 Missions, 3
    Goals, 8 Tasks.
  - The AI/Git facade spies were not called.
  - Two `seed` calls for two users share no Organization/Tenant id.
  - Runtime < 3000 ms.
- [ ] **Step 2: Run them to see them fail.** `cd apps/api && npx jest demo-sandbox-seeder` → FAIL.
- [ ] **Step 3: Implement** the seeder by calling the services (not raw inserts) so domain invariants and
  activity logs hold. Wrap them in one transaction only if the services accept an EntityManager. Otherwise rely
  on Task 5's delete-on-failure.
- [ ] **Step 4: Run tests to see them pass.**
- [ ] **Step 5: Commit** `feat(demo): seed a private demo workspace per sandbox`.

### Task 7: Route guard — blocked features and registration

**Files:**
- Create: `apps/api/src/demo/demo-restrictions.ts` (the table), `apps/api/src/demo/demo-restrictions.guard.ts`
- Modify: `DemoModule` (register the guard as `APP_GUARD`, so it is present only when the demo is on)
- Test: `apps/api/src/demo/__tests__/demo-restrictions.guard.spec.ts`,
  `apps/api/src/demo/__tests__/demo-restrictions.routes.spec.ts`

**Interfaces:**
- Produces: `DEMO_BLOCKED_ROUTES: ReadonlyArray<{ method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | '*';
  path: RegExp; feature: string; scope: 'demo-users' | 'everyone' }>`.
  - Entries with `scope: 'everyone'`: `POST /api/auth/register`, magic-link request/verify, social OAuth
    start/callback routes. Nobody registers on a demo instance; operators already exist.
  - Entries with `scope: 'demo-users'`: plugin settings writes (`PATCH /api/plugins/:id/settings`, `PATCH
    /api/works/:workId/plugins/:id/settings`); `POST /api/v1/chat/completions`; API keys create; model accounts
    and model-account credentials; webhooks create/update; notification channels; MCP connections; integration
    connects (Composio/Zapier/OAuth connect for GitHub/Vercel); deploy and add-domain; App Works create;
    `POST /api/auth/claim`; password/email change; account deletion request; org invites by email; data/account
    export; changing a Work's repository owner/name. Use each controller's real path: find them with `git grep -n
    "@Controller\|@Post\|@Patch\|@Delete" apps/api/src/<module>`.
- Produces: `DemoRestrictionsGuard.canActivate(ctx)`. For a match it throws `DemoFeatureDisabledError(feature)`;
  `demo-users` entries apply only when `req.user` has `registrationProvider === 'demo'`. Find where the auth
  guard puts the user on the request and which fields it carries. If `registrationProvider` is not there, look
  it up via `UserRepository.findById` with a 60 s in-memory cache keyed by user id.

- [ ] **Step 1: Write failing tests.**
  - Guard: a demo user + `PATCH /api/plugins/openrouter/settings` → `DEMO_DISABLED`; a demo user + `GET
    /api/works` → allowed.
  - **An operator (non-demo user) + `PATCH /api/plugins/openrouter/settings` → allowed** (Review Focus 4).
  - Anyone + `POST /api/auth/register` → `DEMO_DISABLED`.
  - Routes spec: boot the Nest app with `DEMO=true` and collect every registered route from the router. Every
    `DEMO_BLOCKED_ROUTES` entry matches ≥ 1 real route, and the table has ≥ 15 entries.
- [ ] **Step 2: Run them to see them fail.** `cd apps/api && npx jest demo-restrictions` → FAIL.
- [ ] **Step 3: Implement** the table and the guard.
- [ ] **Step 4: Run tests to see them pass.**
- [ ] **Step 5: Commit** `feat(demo): block money, outbound and account features for demo users`.

### Task 8: Work policy — storage, repo prefix, cap, pipeline, free model list

**Files:**
- Modify: `packages/agent/src/services/work-lifecycle.service.ts` (`resolveProviderDefaults` ~L401-430 and
  the create path ~L570-843)
- Modify: `packages/agent/src/ever-works-providers/ever-works-git.provider.ts` (`createRepository` ~L98: assert
  the prefix when the demo is on)
- Modify: the pipeline resolution for generation (find it with `git grep -n "pipelinePluginId\|resolvePipeline"
  packages/agent/src`) to force `standard-pipeline` when the demo is on
- Modify: `apps/api/src/plugins/plugins.controller.ts:226` (`GET /api/plugins/:id/models`: free models only
  when the demo is on) and the pipeline picker list endpoint (hide non-standard pipelines when the demo is on)
- Test: `packages/agent/src/services/__tests__/work-lifecycle.demo.spec.ts`,
  `packages/agent/src/ever-works-providers/__tests__/ever-works-git.provider.demo.spec.ts`,
  `apps/api/src/plugins/__tests__/plugins.controller.demo.spec.ts`

**Interfaces:**
- Consumes: `config.demo.*`, `DemoFeatureDisabledError`, `isFreeModelId`.
- Produces (behaviour when the demo is on and the user is a demo user):
  - `storageProvider` = `'ever-works-git'` whatever the DTO says; `deployProvider` = `'ever-works'` (with
    `DEPLOY_EVER_WORKS_ENABLED` off this resolves to the existing no-deploy path; confirm generation completes
    without a deploy).
  - Creating a repo-backed Work when the user already has `maxWorksPerSandbox` (3) Works with a
    `sourceRepository` → `DemoFeatureDisabledError('more than 3 generated Works')`. The seeded draft and project
    Works have no repo and do not count.
  - With no screenshot plugin configured (the demo env sets none), the standard pipeline's image-capture step
    (`packages/plugins/standard-pipeline/src/steps/image-capture.step.ts`) skips and generation completes; if it
    fails today, make it skip when no screenshot capability resolves.
  - `EverWorksGitProvider.createRepository` throws `DemoFeatureDisabledError('repository name')` when the built
    name does not start with `config.demo.repoPrefix()`.

- [ ] **Step 1: Write failing tests.**
  - A demo user creating a Work with `storageProvider: 'user-github'` persists `ever-works-git`.
  - A 4th repo-backed Work is refused; the seeded draft and project Works do not count.
  - The provider refuses `anon-x-foo` in demo mode and accepts `demo-1a2b3c4d-foo`; with the demo off it
    accepts both.
  - Generation of a demo Work resolves `standard-pipeline` even when the Work's settings name `agent-pipeline`.
  - `GET /api/plugins/openrouter/models` lists only `:free` ids in demo mode and everything when off.
  - The image-capture step with no screenshot capability resolved returns a skipped result (no throw).
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Rebuild agent, run tests to see them pass.**
- [ ] **Step 5: Commit** `feat(demo): demo Works use Ever Works Git with demo- repos and the standard pipeline`.

### Task 9: Recorded examples in the seed

**Files:**
- Create: `apps/api/src/demo/seed/demo-recorded.fixture.json`,
  `apps/api/src/demo/seed/demo-recorded-seeder.ts`
- Modify: `demo-sandbox-seeder.service.ts` (call it; fill `recordedGoalId`)
- Test: extend `demo-sandbox-seeder.spec.ts`

**Interfaces:**
- Consumes: Task 6's seeded ids. The entities `AgentRun` (`packages/agent/src/entities/agent-run*.entity.ts`), the
  goal-iteration entity used by `goal-orchestrator.service.ts`, the AI conversation + message entities
  (`apps/api/src/ai-conversation/`), and `ActivityLog`. Write through their repositories.
- Produces: in each sandbox:
  - The completed Goal "Publish the launch blog post" gets 2 iterations. Each has its Tasks `done` and 1 Agent
    run (`status: succeeded`, `model: 'google/gemma-4-31b-it:free'`, cost 0, the transcript from the fixture).
  - The Mission "Ship the launch site" gets its plan (Tasks from the fixture) and 1 finished run.
  - 1 Agent chat conversation with 4 messages.
  - ~10 activity-log entries.
  - Timestamps are relative to sandbox creation (the fixture stores offsets in minutes, e.g. `-120`).
- Decision (deviation from the spec, noted in the PR): the recorded content is **hand-written** realistic
  content now. Capturing it from a real Works-dev run is a later improvement; the fixture format allows a drop-in
  replacement.

- [ ] **Step 1: Write failing tests.** After `seed`: the completed Goal has 2 iterations and 2 succeeded runs
  with non-empty transcripts and free model ids; the conversation has 4 messages; all timestamps are < now;
  two sandboxes get distinct run ids.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Write the fixture JSON and the seeder** (ids are generated, never taken from the JSON).
- [ ] **Step 4: Run to see them pass**; also `seed` still < 3 s.
- [ ] **Step 5: Commit** `feat(demo): recorded goal runs, mission plan and chat in every sandbox`.

### Task 10: Repo ledger + sweeper

**Files:**
- Create: `packages/agent/src/demo/demo-repo-ledger.port.ts` (token `DEMO_REPO_LEDGER`, `interface
  DemoRepoLedgerPort { record(entry: { sandboxUserId: string; owner: string; name: string; githubId: number |
  null }): Promise<void> }`)
- Modify: `ever-works-git.provider.ts`. Add `id: number` to `EverWorksGitRepoRef` (`types.ts:21`, from the
  GitHub response). Add `getRepositoryId(owner: string, name: string): Promise<number | null>` (null on 404) and
  `deleteRepository(owner: string, name: string): Promise<'deleted' | 'gone'>`, using the same PAT and
  fetch-injection pattern as `createRepository`. After a successful create when the demo is on, call
  `ledger?.record(...)` (`@Optional() @Inject(DEMO_REPO_LEDGER)`); the create path must pass the `userId` it
  already has as `sandboxUserId`.
- Modify: `packages/agent/src/facades/git.facade.ts` `createRepository` / `createRepositoryFromTemplate` /
  `createRepositoryCopy` (~L864/941/2076): the same optional ledger record when the demo is on and the
  `GitFacadeOptions` carry a `userId` (`githubId: null`; the sweeper resolves it later)
- Create: `apps/api/src/demo/demo-repo-ledger.service.ts` (implements the port on `DemoGithubRepoRepository`;
  bound to `DEMO_REPO_LEDGER` in `DemoModule`, and remote-proxied for workers like Task 4)
- Create: `apps/api/src/demo/demo-sandbox-sweeper.service.ts`
- Test: `apps/api/src/demo/__tests__/demo-sandbox-sweeper.spec.ts`,
  `packages/agent/src/ever-works-providers/__tests__/ever-works-git.provider.ledger.spec.ts`

**Interfaces:**
- Consumes: `UserRepository.findExpiredDemo(now, 20)` (Task 5); `DemoGithubRepoRepository` (Task 2);
  `DistributedTaskLockService.runExclusive(key, fn, { maxLifetimeMs })`
  (`packages/agent/src/cache/distributed-task-lock.service.ts:66`); the Work delete path
  (`AccountDeletionService` / `deleteWork`, see `apps/api/src/account-deletion/account-deletion.service.ts:524-558`);
  `AnonymousUserCleanupService` (`packages/agent/src/services/anonymous-user-cleanup.service.ts`); the cron
  pattern of `apps/api/src/works/tasks/work-cleanup.service.ts:24-66`.
- Produces: `DemoSandboxSweeperService.sweep(now?: Date): Promise<{ sandboxes: number; reposDeleted: number;
  reposSkipped: number; failures: number }>` and `@Cron('*/15 * * * *') handleCron()` →
  `runExclusive('demo-sandbox-sweeper', () => this.sweep())`.
- Algorithm per expired demo user (exact order):
  1. For each `pendingForSandbox(user.id)` row: skip, log a warning and `markFailed` unless `row.owner ===
     config.demo.githubOrg()` and `row.name.startsWith(config.demo.repoPrefix())`.
  2. `liveId = getRepositoryId(owner, name)`. `null` → `markDeleted` (gone). If `row.githubId` is set and `liveId
     !== row.githubId` → skip and `markFailed('id mismatch')`. Otherwise `deleteRepository` → `markDeleted`.
  3. Only when no ledger row of this user is still pending: delete the user's Works, then the user via
     `AnonymousUserCleanupService`'s per-user purge (extract its per-user body into a public `purgeUser(user)` if
     only `purgeExpired` exists), then the user's Organization(s) and Tenant if they are now empty.
  4. A user with any row at `attempts >= 3` is logged at error level with its id and left for an operator.
  Errors in one user never stop the batch.

- [ ] **Step 1: Write failing tests** (fake `EverWorksGitProvider`, SQLite repos):
  - Owner `ever-works-cloud` + prefix `demo-` + matching id → deleted, user purged.
  - Owner `ever-works` → skipped, user **not** purged.
  - Name `anon-…` → skipped.
  - Id mismatch → skipped, `attempts` 1.
  - 404 on lookup → treated as gone, user purged.
  - A delete throwing → `attempts` 1, user not purged, the next user in the batch still processed.
  - An unexpired demo user is untouched.
  - The demo off → the cron is not registered (module absent) and `sweep` is never called.
  - Provider: in demo mode a successful create calls `ledger.record` with the response's id and the user id; a
    failed create does not record; with the demo off no ledger call.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Rebuild agent, run tests to see them pass.**
- [ ] **Step 5: Commit** `feat(demo): ledger every demo repo and sweep expired sandboxes`.

### Task 11: Web — demo config, login card, start action, register page

**Files:**
- Create: `apps/web/src/lib/feature-flags/demo.ts` (`getDemoConfig()`, same fetch/timeout/fail-closed pattern as
  `readApiSwitch` in `lib/feature-flags/app-launcher.ts`)
- Create: `apps/web/src/app/actions/demo/start-demo.ts` (pattern: `actions/onboarding/anonymous.ts`)
- Create: `apps/web/src/components/demo/DemoLoginCard.tsx`
- Modify: `apps/web/src/lib/api/auth.ts` (add `authAPI.startDemo({ captchaToken? })` → `POST /auth/demo`)
- Modify: `apps/web/src/app/[locale]/(auth)/login/page.tsx` and `login-client.tsx` (card above the form; form
  collapsed under "Operator login" in demo mode)
- Modify: `apps/web/src/app/[locale]/(auth)/register/page.tsx` (demo mode: card linking to `signUpUrl` + the
  demo button, no form)
- Modify: the 401 handling that clears the cookie (`apps/web/src/lib/auth/index.ts:101` `getAuthFromCookie`)
  so a demo instance redirects to `/login?demo=expired`
- Modify: `apps/web/messages/en.json` (+ the other 20 locale files only if the repo's locale-parity test
  requires every key; then copy the English strings)
- Test: `apps/web/src/components/demo/DemoLoginCard.unit.spec.tsx`,
  `apps/web/src/app/actions/demo/start-demo.unit.spec.ts`, `apps/web/src/lib/feature-flags/demo.unit.spec.ts`

**Interfaces:**
- Produces: `getDemoConfig(): Promise<{ enabled: boolean; signUpUrl: string; sandboxTtlHours: number }>`.
  Unreachable API → `{ enabled: false, … }`.
- Produces: `startDemo(input: { captchaToken?: string }): Promise<{ success: true } | { success: false; reason:
  'throttled' | 'full' | 'captcha' | 'error'; error: string }>`. 429 → throttled; 503 + `DEMO_FULL` → full;
  400 → captcha. On success it sets the auth cookie with `setAuthAccessCookie`.
- Produces: `<DemoLoginCard ttlHours={number} expired={boolean} />`. Title "Try Ever Works — no sign-up needed";
  button "Start the demo"; note "Your private demo workspace is deleted after {hours} hours. AI runs on free
  models and may be slower."; secondary link "See a site Ever Works generated" → `https://dir.ever.works`; with
  `expired` → "Your demo workspace expired — start a new one". The button is disabled while pending and the
  action is not re-entrant (Review Focus 2). Turnstile token via `use-turnstile.ts` when a site key exists.
  Success → `router.push('/')` (the dashboard home).
- i18n namespace: `demo.login.*`, `demo.register.*`.

- [ ] **Step 1: Write failing tests.**
  - The card renders the title, button and TTL text, and the expired variant.
  - Two quick clicks call `startDemo` once.
  - A `full` result shows "The demo is full right now — please try again in a few minutes."
  - The action maps 429/503/400 as above and sets the cookie on success.
  - `getDemoConfig` → disabled on fetch error/timeout/non-200.
- [ ] **Step 2: Run them to see them fail.** `cd apps/web && npx vitest run demo` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests to see them pass**, plus `cd apps/web && npx tsc --noEmit -p .` → no errors.
- [ ] **Step 5: Commit** `feat(demo): one-click demo login card`.

### Task 12: Web — demo strip, quota state, demo error toasts

**Files:**
- Modify: the API profile response (`GET /auth/profile`, `apps/api/src/auth/controllers/auth.controller.ts` ~L450+)
  to add `demo: { expiresAt: string; aiQuotaExhausted: boolean } | null` for demo users (uses
  `DemoAiQuotaService.isDayExhausted()` via `getOptionalProvider`); add the field to the web profile type
- Create: `apps/web/src/components/demo/DemoStrip.tsx` (modelled on
  `components/dashboard/JobRuntimeDegradedBanner.tsx`: `role="status"`, next-intl, **not** dismissible)
- Modify: `apps/web/src/app/[locale]/(dashboard)/layout.tsx` (pass `demo` from the profile + `signUpUrl` from
  `getDemoConfig()`) and `layout-client.tsx` (render `<DemoStrip>` above `<DashboardHeader>`, ~L677)
- Modify: the web's shared API error → toast helper (find it with `git grep -n "statusCode === 403"
  apps/web/src/lib`) to map `code: 'DEMO_DISABLED' | 'DEMO_AI_QUOTA' | 'DEMO_AI_BUSY'` to friendly messages
- Test: `apps/web/src/components/demo/DemoStrip.unit.spec.tsx`, an api spec for the profile field

**Interfaces:**
- Produces: `<DemoStrip signUpUrl={string} expiresAt={string} aiQuotaExhausted={boolean} recordedGoalHref={string | null} />`.
  - Text: the verbatim strip copy (Global Constraints), with "Click here to Sign Up" as the link (new tab,
    `rel="noopener noreferrer"`).
  - "Demo workspace expires in {n} h" (rounded down, minimum "less than 1 h").
  - When `aiQuotaExhausted`: "Live AI is used up for today — explore the recorded examples" linking to
    `recordedGoalHref`. To build it, find the seeded recorded Goal by fixture name in the profile service and
    return its id in `demo.recordedGoalId`.
- Toasts: `DEMO_DISABLED` → "Not available in the demo — sign up to use it"; `DEMO_AI_QUOTA` → "The free demo
  AI quota is used up for today — sign up on app.ever.works to keep going"; `DEMO_AI_BUSY` → "The demo AI is
  busy — try again in a few seconds".

- [ ] **Step 1: Write failing tests.**
  - The strip renders the exact copy and the link href, the expiry text for +23.5 h → "23 h", and the quota line
    only when exhausted.
  - The layout does not render the strip when `demo` is null.
  - The API profile has `demo` for a demo user and `null` for a normal user and with the demo off.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests to see them pass**, plus web `tsc` clean.
- [ ] **Step 5: Commit** `feat(demo): demo strip and friendly demo errors`.

### Task 13: Docs, env examples, README, uptime monitor

**Files:**
- Create: `docs/self-hosting/demo-mode.md` (what it is, every env var with default, what is blocked, the
  operator checklist from design §5.4 and §8). Add it to `apps/docs/sidebarsPlatform.ts`.
- Modify: `apps/api/.env.example` (commented `DEMO*` block); `apps/web/.env.example` if the web reads any env
- Modify: `README.md:95-115` (the platform demo is `https://demo.ever.works`; the generated-directory example is
  `https://dir.ever.works`)
- Modify: `.github/workflows/external-uptime-monitor.yml:144` (`Demo directory|https://dir.ever.works/|…` with
  dir's real `<title>` "Discover | Awesome Directories", plus `Platform demo|https://demo.ever.works/login|<the
  login page title>`) and `apps/node/src/core/external-uptime-monitor.contract.spec.ts` if it pins those URLs
- Modify: `scripts/ci/check-default-off-switches.mjs`. Only if it flags a new switch: `DEMO` must be listed as
  default-off (no compose file turns it on)

- [ ] **Step 1: Write the docs and examples.**
- [ ] **Step 2: Run the checks.** `node scripts/ci/check-default-off-switches.mjs` → exit 0; `cd apps/node &&
  npx jest external-uptime-monitor` → PASS; `pnpm --filter ./apps/docs build` (or the docs build script) →
  success.
- [ ] **Step 3: Commit** `docs(demo): demo mode operator guide, README and uptime monitor`.

### Task 14: Boot it — local demo instance on SQLite + Playwright

**Files:**
- Create: `apps/web/e2e/demo-mode.spec.ts` (Playwright, tagged so it runs only when `E2E_DEMO=1`)
- Create: `scripts/dev/demo-local.env.example` (the minimal env to run a local demo: `DEMO=true`,
  `DATABASE_TYPE=sqlite`, `DATABASE_PATH=./data/demo.sqlite`, `DATABASE_AUTOMIGRATE=true`, `RUN_MIGRATIONS=false`,
  `MAILER_PROVIDER=none`, `TRIGGER_ENABLED=false`, `STORAGE_EVER_WORKS_GIT_ENABLED=false`, free
  `PLUGIN_OPENROUTER_*_MODEL` ids, no secrets)

**Interfaces:** consumes everything above.

- [ ] **Step 1: Write the e2e spec.**
  - `/login` shows "Start the demo"; clicking it lands on the dashboard with the strip text.
  - The seeded Works "Launch the Acme website" and "Awesome AI Coding Tools" are listed.
  - The recorded Goal page shows 2 iterations.
  - `PATCH /api/plugins/openrouter/settings` from the page context → 403 `DEMO_DISABLED`.
  - Strip absent when run against a non-demo server (second project, `E2E_DEMO=0`).
- [ ] **Step 2: Build and boot.** `pnpm install --frozen-lockfile && pnpm build`, then start the built API and
  web with the local env (Node 26 from `E:\nvm\v26.10.0` first on `PATH`). `GET /api/config` →
  `features.demoMode: true`, and the API log shows no errors at boot.
- [ ] **Step 3: Run the e2e.** `cd apps/web && E2E_DEMO=1 npx playwright test demo-mode` → PASS. Take a
  screenshot of the login card and the strip for the PR.
- [ ] **Step 4: Run the full suites touched.** `pnpm --filter @ever-works/agent test`, `cd apps/api && pnpm
  test`, `cd apps/web && pnpm test`, `pnpm type-check`, `pnpm lint` → green. Compare `GET /api/config` and
  Swagger with `develop`: only added keys/routes.
- [ ] **Step 5: Commit** `test(demo): local demo e2e`.

---

## After this plan

Rollout plan (separate, after merge):
- k8s-gitops for `ever-works-demo-{dev,stage,prod}`: API with 1 replica, `Recreate`, a 5 Gi Ceph RBD PVC; web
  with 2 replicas; env per design §5.4.7, plus `DIRECTORY_STALE_TIMEOUT_HOURS=0.5`.
- OpenBao paths and ExternalSecrets.
- The Trigger project "Ever Works Demo" (concurrency 2) and the deploy-workflow entry.
- The Turnstile widget hostname allow-list must include `demo.ever.works`, `demostage.ever.works` and
  `demodev.ever.works`, or the button fails captcha in production.
- Board claims, and the template links in `directory-web-template`, `demo-data`, `k8s-gitops` docs and homelab
  docs.
