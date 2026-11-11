/**
 * Work "kind" vocabulary — the single source of truth shared by the API,
 * the agent package and the web app.
 *
 * This lives in `@ever-works/contracts` rather than in the TypeORM entity
 * because `apps/web` deliberately does not depend on `@ever-works/agent`;
 * contracts is the only package both sides import at runtime. The entity
 * (`packages/agent/src/entities/work.entity.ts`) re-exports from here so
 * there is exactly one list to extend when a new kind ships.
 */

/**
 * Kinds a user can pick from the chip catalog at creation time.
 *
 * `company` is deliberately absent: Company Works are minted only through
 * the dedicated Register-Company flow (`WorkLifecycleService.createCompanyWork`),
 * never through the general create path.
 *
 * `repo` (chip label "Repository") is the one selectable kind that is NOT a
 * generated site: it registers an EXISTING code repository — the platform
 * monorepo, a template repo, a website repo — as a first-class Work so
 * Tasks, Goals and fleet runs can attach to it (self-build slice D,
 * EW-766). Its data repository IS the code repository; see
 * `WORK_KIND_CAPABILITIES.repo`.
 *
 * `app` (chip label "App", APW-01 / README D1) is the second kind that wraps
 * code the platform did not generate: it takes a repository URL and links it,
 * forks it, or makes a private copy, then builds, runs and evolves that app.
 * It is appended AFTER `repo` — nothing above it moves — and it is the only
 * kind that is neither a generated site nor point-and-read: unlike `repo` it
 * deploys, and unlike every generated kind its code lives in the Work
 * Repository (`website` role) rather than in a data repository. Its chip is
 * fail-CLOSED where every other kind's chip fails open (Resolution R-6); see
 * `WORK_KIND_CAPABILITIES.app`.
 */
export const USER_SELECTABLE_WORK_KINDS = [
	'website',
	'landing-page',
	'blog',
	'directory',
	'awesome-repo',
	'repo',
	'app'
] as const;

export type UserSelectableWorkKind = (typeof USER_SELECTABLE_WORK_KINDS)[number];

/**
 * Every kind a persisted `work.kind` may hold.
 *
 *   - `default` — the column default. Carried by every Work created before
 *     the kind-aware create path shipped, which is the overwhelming majority
 *     of existing rows. It must behave identically to `directory`; see
 *     `WORK_KIND_CAPABILITIES` for why that invariant is load-bearing.
 *   - `company` — see above.
 *   - `campaign` — a go-to-market campaign Work: the artifact home for the
 *     lead lists, drafts, and reports a go-to-market pipeline produces. Like
 *     `company` it is minted by a dedicated flow (template activation), not
 *     by the general create path, so it stays out of the chip catalog.
 *   - `project` — a repo-less Work (EW-P2-4): plain project tracking, and the
 *     Ever Works side of a Gauzy project (Gauzy ↔ Ever Works integration, D3).
 *     No repositories, no deploy, no generator: Tasks run without a
 *     repository. Minted only by its own create route, behind the
 *     `EVER_WORKS_PROJECT_WORKS_ENABLED` switch (default OFF), so it stays out
 *     of the chip catalog. Inserted before `default`, which stays last.
 */
export const WORK_KINDS = [...USER_SELECTABLE_WORK_KINDS, 'company', 'campaign', 'project', 'default'] as const;

export type WorkKind = (typeof WORK_KINDS)[number];

const WORK_KIND_SET: ReadonlySet<string> = new Set<string>(WORK_KINDS);

/**
 * Coerce an arbitrary value into a known `WorkKind`.
 *
 * `work.kind` is persisted as `varchar(32)` and modelled as an open string
 * union so the server can ship a new kind without a coordinated web deploy.
 * Every consumer must therefore route unknown values through here and get
 * the safe generic `default` behaviour rather than crashing or silently
 * mis-rendering.
 *
 * `landing` is accepted as an alias for `landing-page`.
 *
 * NEVER throws.
 */
export function normalizeWorkKind(value?: string | null): WorkKind {
	if (typeof value !== 'string') {
		return 'default';
	}
	const normalized = value.trim().toLowerCase();
	if (!normalized) {
		return 'default';
	}
	const canonical = normalized === 'landing' ? 'landing-page' : normalized;
	return WORK_KIND_SET.has(canonical) ? (canonical as WorkKind) : 'default';
}

/** True when `value` is a kind the create-path chip catalog offers. */
export function isUserSelectableWorkKind(value?: string | null): value is UserSelectableWorkKind {
	if (typeof value !== 'string') {
		return false;
	}
	const canonical = value.trim().toLowerCase() === 'landing' ? 'landing-page' : value.trim().toLowerCase();
	return (USER_SELECTABLE_WORK_KINDS as readonly string[]).includes(canonical);
}

/**
 * True when `value` names the Repository kind (`repo`) — the one kind whose
 * data repository is a code repository the user already owns rather than
 * something the platform generated (self-build slice D, EW-766).
 *
 * This is deliberately a KIND test rather than a capability test. The
 * content pipelines (item generation, README regeneration, deployment) are
 * not capability-gated for any kind today; what is special about a
 * Repository Work is not "it has no items" — a Company Work has none either
 * — but that running the directory pipeline against its data repository
 * would write generated scaffolding into a human's source tree. Callers
 * that must never touch that repository check this predicate. Accepts the
 * same loose input as `normalizeWorkKind` and never throws.
 */
export function isRepositoryWorkKind(value?: string | null): boolean {
	return normalizeWorkKind(value) === 'repo';
}

/**
 * True when `value` names the App kind (`app`, APW-01) — the kind whose Work
 * Repository is an existing GitHub repository Ever Works links, forks or
 * copies, and then builds, runs and evolves (README D1).
 *
 * Like `isRepositoryWorkKind` this is a KIND test rather than a capability
 * test, and for the same reason: the content pipelines and every writer that
 * would generate into the Work Repository are refused by kind, not by
 * capability. `app` and `repo` are the two kinds that wrap code the platform
 * did not generate — `repo` never writes to it, `app` is allowed to — so
 * callers must never treat one predicate as the other.
 *
 * Accepts the same loose input as `normalizeWorkKind` (`' APP '` is `app`)
 * and never throws.
 */
export function isAppWorkKind(value?: string | null): boolean {
	return normalizeWorkKind(value) === 'app';
}

/**
 * True when Tasks on a Work of this kind are delivered as pull requests an
 * agent run opens: the agent works on the Task's own branch of a code
 * repository the platform did not generate, and the change reaches the base
 * branch only as a reviewed pull request. True for `app` and `repo`, false
 * for every other kind.
 *
 * This is the one question two loops ask before they plan on that fact:
 *
 *   - a Mission's Task output files and starts Tasks only on such Works
 *     (each planned Task is one pull request), and
 *   - a Goal's loop waits while an earlier iteration's pull request on such
 *     a Work is still open, so iteration N+1 never branches from a base that
 *     lacks iteration N's change.
 *
 * It is a KIND test, like `isAppWorkKind` and `isRepositoryWorkKind`, and not
 * a capability flag: it names exactly the two kinds that wrap code the
 * platform did not generate, and no generated kind is meant to opt in. It
 * says what the kind's Tasks are FOR, not that a given Task will get a
 * branch: an App Work always isolates its Tasks, a Repository Work only
 * while its Task isolation setting is on, so a caller that needs the branch
 * must still ask `resolveTaskIsolation` (in `@ever-works/agent`).
 *
 * Callers that need to tell the two kinds apart (the App kill switch, the
 * App delivery chain) keep using `isAppWorkKind`. Accepts the same loose
 * input as `normalizeWorkKind` and never throws.
 */
export function workKindDeliversTasksAsPullRequests(value?: string | null): boolean {
	const kind = normalizeWorkKind(value);
	return kind === 'app' || kind === 'repo';
}

/**
 * True when `value` names the Project kind (`project`, EW-P2-4) — the one
 * repo-less kind: no data, work or website repository, no deploy, no
 * generator. Callers that would clone, generate into, build or deploy a
 * Work's repository refuse it; Tasks on it run without a repository.
 *
 * A KIND test, like `isRepositoryWorkKind`, for the same reason: the content
 * pipelines are refused by kind. Accepts the same loose input as
 * `normalizeWorkKind` and never throws.
 */
export function isProjectWorkKind(value?: string | null): boolean {
	return normalizeWorkKind(value) === 'project';
}
