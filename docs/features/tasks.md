---
id: tasks
title: Tasks
sidebar_label: Tasks
---

# Tasks

A **Task** is one trackable unit of work — a fix, a review, a chore — with a status, a priority, labels, and optionally an Agent that executes it. Where a Work is a finished website and a Mission is a standing goal that keeps proposing new ones, a Task is the small, concrete thing somebody (or some Agent) actually does next.

Reach for a Task when you know what needs doing and want it tracked to completion. Tasks live at `/tasks`.

The Tasks surface carries a two-tab strip — **Tasks | Triggers**. Everything below describes the Tasks tab; the [Triggers tab](#the-triggers-tab) holds the standing rules that create Tasks for you when something happens outside the platform.

## When to use a Task vs a Work, Mission or Idea

| You want to…                                                   | Use a…                           |
| -------------------------------------------------------------- | -------------------------------- |
| Track one concrete piece of work through to done               | **Task**                         |
| Hand a piece of work to an Agent and watch the run             | **Task** with an Agent           |
| Publish a whole site / directory / blog from a prompt          | [**Work**](./creating-a-work.md) |
| Have the platform keep finding new angles on a topic over time | [**Mission**](./missions.md)     |
| Park a proposed Work until you decide whether to build it      | [**Idea**](./ideas.md)           |

A Task is not exclusive to any one of those. The same Task can belong to a Work **and** carry a Mission or Idea association at the same time — these are independent, additive associations, not a single "parent" choice.

## Creating a Task

Go to `/tasks` → **New Task**, or straight to `/tasks/new`. (**Browse templates**, beside it in the page header, opens the template catalog described below.)

| Field                 | Required | What it does                                                                                                                                 |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Title**             | Yes      | Up to **200 characters** — the input stops accepting more, and the API rejects anything longer. **Create** stays disabled while it is blank. |
| **Description**       | No       | Free text. Rejected with a 400 if it contains a secret-like value (API keys and similar) — credentials belong in plugin settings.            |
| **Work**              | No       | Files the Task under a Work. Attachments only work on a Work-scoped Task, so pick one here if you plan to attach anything.                   |
| **Priority**          | No       | `p0`–`p4`. Defaults to **P3**.                                                                                                               |
| **Labels**            | No       | Comma-separated. Blank entries are dropped and each label is trimmed. See the auto-derive rule below.                                        |
| **Acceptance checks** | No       | Collapsed section. Plus a **Max gate attempts** picker (_Inherit from Work_, or 1–5). Left empty, the Task inherits the Work's defaults.     |

A new Task is created in **Backlog** — the form has no status picker. It is given a per-account slug (`T-1`, `T-2`, …) that shows on every card, row and board tile. Slugs are numbered per account, so two accounts can each hold a `T-1`.

### Labels are derived from the title until you touch them

The Labels field mirrors the **slugified title** as you type: lowercase, every run of characters outside `a`–`z` and `0`–`9` collapsed to a single `-`, no leading or trailing hyphen. `Redesign onboarding flow` becomes `redesign-onboarding-flow`. Accented and non-Latin letters fall outside that set, so `Café update` derives `caf-update`, and a title written entirely in a non-Latin script derives nothing — type the label yourself there. The moment you edit the Labels field yourself, the mirroring stops for good and your text is used verbatim.

The derived label is also **truncated to 80 characters**, cut on a hyphen boundary where one lands past the halfway mark and with any trailing hyphen stripped. So a long title no longer produces an uncreatable Task — it produces a shortened label.

:::caution A label you type yourself is still capped at 80
The 80-character cap is enforced by the API on every label, not just the derived one. Auto-derivation stays inside it; a longer label you type (or paste from a template) is rejected and the Task is not created.
:::

:::warning The Task chip on `/new` does not pre-fill this form
Typing a prompt on `/new` and picking the **Task** chip sends your prompt to the AI chat and drops you on an **empty** `/tasks/new`. Nothing is carried into the fields. Type the title here, or use the chat conversation it just started.
:::

:::caution On a narrow window, the AI chat panel covers the form
Below 768px — phones and split-screen — the AI chat stops being a side panel and opens as a full-screen overlay on top of the page, backdrop and all. Close it (or widen the window) if **Create** looks unreachable.
:::

### Starting from a template

`/tasks/templates` lists pre-built Task shapes. **Use template** lands you on `/tasks/new?from=<slug>` with the title, description and the template's tags pre-filled into Labels (which counts as "touched", so the title no longer drives them). The form shows a notice whenever it was pre-filled from a URL — read the content before creating.

### Building a task tree from a workflow template

That catalog produces **one** Task. The other kind of template produces a whole tree.

`/tasks/new` opens on **Blank task**; the second radio, **From template**, swaps the form over to a _workflow_ template — a named, ordered list of steps that expands into a parent Task plus one sub-task per step, in a single transaction.

1. Go to `/tasks/new` and click **From template**. The template list loads on that first switch, so the blank path never pays for the round-trip.
2. Pick one in the **Workflow template** dropdown. Each option reads `<name> — <n> steps`.
3. Optionally set a **Branch name** (`feat/my-feature`, up to 200 characters) — it is stamped on the parent Task.
4. Fill **Feature name** and **Feature description** — the same two inputs the blank form calls Title and Description — and pick a **Work** if the tree should be filed under one.
5. **Create workflow** expands the tree and lands you on the parent Task's detail page.

Under the dropdown, **Will create a parent Task plus N sub-tasks** previews the steps in order and marks each one carrying an _approval_ gate.

What each step turns into:

| The step carries        | The created sub-task gets                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A **prompt**            | Your feature description, then an `## Agent prompt` heading holding the step's prompt — which is what the Agent actually reads |
| A **`dependsOn`** entry | A blocker row pointing at that step's sub-task, so this step cannot reach In progress or Done while the one it needs is open   |
| A bound **Agent**       | An Agent assignee row — the kind of assignment no other screen creates                                                         |
| **`requiresApproval`**  | An approver row for you, plus _require all approvers_, so the step cannot reach Done unapproved                                |

Parent and children are all created in **To do** (not Backlog), at **P2** unless the caller sends another priority, carrying the template's labels and the Work / Mission / Idea you chose on the form. The parent's description records `Instantiated from template: <name> (<slug>)`.

Your workflow templates live under **My workflows**, at the top of `/tasks/templates` and above the single-Task catalog. Each card lists the steps in order, flags the ones that require approval, names the agent template a step is bound to, and carries a delete button — deleting a template keeps every Task already created from it. The first time that list is ever read, the platform seeds one for you: **Compound Engineering Workflow** (`compound-engineering-workflow`), nine steps — _Write spec → Plan implementation → Plan review → Revise plan from review → Implement → AI review → Apply review fixes → Update wiki → Review & Deploy_, the last one deliberately a human step with no agent.

Authoring and editing workflow templates is API-only today:

| Endpoint                                   | What it does                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `GET /api/task-templates`                  | Your templates with their steps embedded. Seeds the default template on your first call.                              |
| `POST /api/task-templates`                 | Create one: `name`, optional `slug` / `description` / `labels`, and **1–30** `steps`.                                 |
| `PATCH /api/task-templates/:id`            | Update. A supplied `steps` array **replaces** the step list wholesale.                                                |
| `DELETE /api/task-templates/:id`           | Delete the template. Tasks already instantiated from it are untouched.                                                |
| `POST /api/task-templates/:id/instantiate` | The expansion above: `title`, plus optional `description`, `workId`, `missionId`, `ideaId`, `branchName`, `priority`. |

A step that depends on a position which does not exist, on itself, or on a cycle is rejected at write time — so a stored template is always one that can actually expand.

:::note Saved workflow _graphs_ are a separate, API-only feature
`/api/workflows` stores executable graphs — nodes, edges, `llm_decide` branches, `agent.delegate` steps — validated on every write so a saved graph is a runnable one. `POST /api/workflows/:id/run` answers **202** with a run id and does not wait (a large graph walks for far longer than any HTTP timeout); poll `GET /api/workflows/runs/:runId` for the trace, or `GET /api/workflows/:id/runs` for history. No dashboard screen reads or writes them yet, and Agents can run or check an inline graph through their `run_workflow_graph` / `validate_workflow_graph` tools. Graphs are not Task templates and do not create Tasks.
:::

### A template step can live in another repository

Instantiating a template normally files the parent Task and every sub-task against the same Work. A
step may instead name its **own Work** and its **own extra repositories**, so one template expresses
"write the spec in the platform, update the docs in the website, publish the announcement in the
marketing repo". A step that names neither inherits the tree's Work, which is what every template
written before this did.

Both are checked against you — the person instantiating — twice: when the template is saved, and again
when it is instantiated. A step naming a Work you do not own, or a repository connection that has since
been disabled, **refuses the whole instantiation** and names the step. It never quietly falls back to
the parent's Work: a sub-task silently re-homed onto another repository files work, and pushes
branches, in the wrong place.

Extra repositories on a step obey exactly the rules a Task's own extra repositories obey — the
connection must be yours and enabled, mount directories must be single safe names and unique, and a
Task mounts at most eight of them.

## Priorities

Five levels, `p0` (most urgent) through `p4`, defaulting to `p3`.

**Priority is a filter and a label — nothing more.** No list, board or queue is ordered by it: every Task list is sorted by **most recently updated, descending**, unconditionally, and the board columns keep that same order. Priority does not change execution order and gates nothing.

The five levels also do not read the same everywhere. What each surface renders:

| Where                                                         | What you see                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Cards, Table, Kanban cards, and Recent Tasks on the dashboard | `P0`–`P4` — the stored value, upper-cased by CSS                               |
| The **Priority** dropdown in the `/tasks` filter bar          | `P0`–`P4`                                                                      |
| The **Details** rail on a Task's detail page                  | **Urgent · High · Medium · Normal · Low**                                      |
| The **Add existing Task** picker on a scope's Tasks tab       | **URGENT · HIGH · MEDIUM · NORMAL · LOW** — the same words, upper-cased by CSS |
| The **Priority** picker on `/tasks/new`                       | `P0 — urgent`, `P1`, `P2`, `P3 — default`, `P4 — low`                          |

The colour is consistent even where the wording is not: P0 and P1 are both the danger tone (P0 louder), P2 is the warning tone, and P3 and P4 are deliberately neutral so only the urgent rows pull the eye.

## Scoping a Task to a Work, Mission or Idea

There are three ways a Task ends up under a scope:

- **At create time** — the **Work** picker on `/tasks/new`. Mission and Idea have no picker on the form; they are set only by the `?missionId=` / `?ideaId=` the Tasks tab on a Mission or Idea adds for you.
- **From the scope's Tasks tab** — **New Task** carries the scope through, and **Add existing** opens a picker of your other Tasks. The picker reads up to 200 of your most recently updated Tasks, drops cancelled ones and any already on this scope, and has its own search box.
- **On the Task detail page** — the **Work** row in the right rail is an editable picker. Changing it re-files the Task immediately.

Each per-row overflow menu on a scoped Tasks tab also offers a detach, behind a confirmation dialog. It clears just that one owner and leaves the others alone; the Task itself survives and returns to the global list.

:::caution A Task with sub-tasks cannot be re-filed
Changing the owners of a Task that has sub-tasks is refused: _"Task … has N sub-task(s); re-file or detach them before changing its owners so parent and child scopes cannot diverge."_ Move or detach the children first.
:::

:::note Mission and Idea associations are read-only after creation
The detail page shows the Mission or Idea a Task belongs to, but only Work is editable there. To change a Mission or Idea association from the UI, use **Add existing** on that Mission's or Idea's Tasks tab.
:::

## Sub-tasks

Any Task can be the parent of others. The **Sub-tasks** section on Task detail is the checklist of its children, headed by an `n/m` counter — children already in **Done** over the total number of children.

Each row carries the child's status icon and title (a link to its own detail page, struck through once it is done), one **Agent** chip per agent assignee, an **Approval** / **Approved** badge when the child has approvers — hover it for _"x of y approvers signed off"_ — and the child's status in words.

To add one, type a title in the box at the bottom of the section (200 characters, same cap as the create form) and press **Add**. The child is created with `parentTaskId` set and inherits the parent's **whole owner tuple** — Work, Mission, Idea, Team, Agent and Goal — because the API requires parent and child to agree on every owner, not merely on one of them:

> Parent Task scope (…) must match child Task scope (…).

Two structural rules protect the tree:

- **A parent with children cannot be re-filed.** Changing its owners is refused until you move or detach the children — the caution under [Scoping a Task](#scoping-a-task-to-a-work-mission-or-idea) is the same rule seen from the parent's side.
- **Chains deeper than 64 are refused** on create: _"Parent Task chain exceeds depth 64; refusing to add child for safety."_ Re-anchor the chain closer to its root instead.

The checklist reads `GET /api/tasks/:id/subtasks`, which returns `{ data, meta: { total, doneCount } }` — the children together with their agent assignees and approval state in one call, rather than a request per row. To create a child from the API, `POST /api/tasks` with `parentTaskId` plus the parent's owners. A whole tree at once is what [workflow templates](#building-a-task-tree-from-a-workflow-template) instantiate.

## The list, its views and its filters

`/tasks` loads **50 Tasks per page**, most recently updated first, with Previous / Next below the list once there is more than one page.

The filter bar at the top is a real form — set what you want and press **Apply** (or **Reset** to clear it):

| Filter       | Behaviour                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------- |
| **Search**   | Case-insensitive substring match against **title, slug and description**.                      |
| **Status**   | One status, or Any status.                                                                     |
| **Priority** | One priority, or Any priority.                                                                 |
| **Label**    | Matches a whole label, case-insensitively — `bug` finds a Task labelled `Bug`, but not `bugs`. |

Below the bar, a segmented control switches between three views of whatever the page loaded. The choice is **not remembered** — every reload starts on Cards.

| View       | What it shows                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| **Cards**  | A grid of cards: slug, priority badge, title, a two-line description, the status chip and up to three labels. |
| **Table**  | Slug · Title · Status · Priority · Updated.                                                                   |
| **Kanban** | One column per status, drag-and-drop, run controls and per-Task run / branch / PR / gate chips.               |

Cards and Table additionally get a row of **status pills** for quick client-side narrowing, and the count badge reads `shown / total`. Those pills disappear once you have picked a Status in the filter bar (the server already filtered) and are hidden in Kanban, where the columns are the status filter; in both of those cases the badge falls back to a plain count.

:::caution The board only holds the page you loaded
Kanban lays out the current page — at most 50 Tasks — not your whole backlog, and each column renders 15 cards before a **Show N more** button. Column counts are counts of what was loaded, not totals. Use the filter bar to bring the slice you care about onto the page.
:::

### Working on the board

Columns read **Backlog · Todo · In Progress · In Review · Blocked · Done · Cancelled**.

- **Drag a card** to another column to transition it. Columns that the state machine does not allow simply refuse the drop.
- **Move →** on a card lists the same legal destinations as a menu.
- **Run** dispatches the Task to an Agent (see below). With a card focused, pressing **`r`** does the same thing.
- **Run all** appears in the Backlog, Todo and In Progress column headers only, and only while that column holds at least one card. It runs at most **20** Tasks from the top of that column. Each one reports its own outcome — one failing never stops the others — and the column prints a `started/total` summary underneath its header.
- Cards carrying a branch, a pull request or a change count show a **± diff** affordance that opens a preview of the branch's changes.

## The Triggers tab

`/tasks` and `/tasks/triggers` are the two tabs of one surface. A **Trigger** is a standing rule that turns something happening outside Ever Works into work inside it: each one owns a signed HTTPS endpoint (or matches an ingested platform event), creates a Task from its own template on every verified delivery, assigns it to the Agent you nominated, and — unless you asked it to wait — starts the agent run immediately.

The tab lists every trigger you own: its **Mode** (`Task` or `Template`, fixed at creation), its target, an **Enabled** switch that pauses or resumes it in place, when it last fired, and its lifetime fire count. The row menu (**⋯**) holds **Fire now**, **Test fire**, **Edit**, **Rotate secret** and **Delete**, and each trigger has a detail page at `/tasks/triggers/:id` with its recent-fires log.

To create one:

1. Go to **Tasks → Triggers** (`/tasks/triggers`) and click **New Trigger**.
2. Name it, then pick the **Source** — _Webhook (signed URL)_ or _Platform event_.
3. Pick the **Mode**: _Task_ (you write the agent instructions) or _Template_ (the Task is built from a task-template slug).
4. Choose the Agent under **Assign agent**, decide whether the first Task starts automatically or waits in Backlog, and click **Create**.
5. For a webhook trigger, copy the **Webhook URL** and the **Signing secret** from the dialog — the secret is shown exactly once.

Signing a delivery, the replay window, payload contracts, title templates and the fire log are all covered in [Inbound Triggers](./inbound-triggers.md).

## Statuses and transitions

Seven statuses, with a strict lattice. Anything not in this table is refused.

| From            | Can move to                           |
| --------------- | ------------------------------------- |
| **Backlog**     | To do, Cancelled                      |
| **To do**       | In progress, Blocked, Cancelled       |
| **In progress** | In review, Blocked, Done, Cancelled   |
| **In review**   | In progress, Blocked, Done, Cancelled |
| **Blocked**     | To do, In progress, Cancelled         |
| **Done**        | In progress (re-open)                 |
| **Cancelled**   | — terminal, nothing leaves it         |

On the Task detail page every status is rendered as a button: the current one is highlighted, the legal destinations are clickable, and the rest are visibly disabled. That row is the honest picture of what you can do next.

Side effects worth knowing:

- Moving to **In progress** stamps the start time the first time it happens, and dispatches an Agent run (see [Running a Task](#running-a-task-with-an-agent)).
- Moving to **Blocked** stashes the status the Task came from. When the last blocking Task reaches Done or Cancelled, the platform moves the blocked Task back to that stashed status — or to **To do** if nothing was stashed.
- Moving to **Done** stamps a completion time.

:::caution A Task blocked out of In review does not come back on its own
The automatic restore is a normal transition, so it has to be legal from **Blocked** — and Blocked can only reach To do, In progress and Cancelled. A Task that was blocked while in **In review** therefore has _In review_ stashed, the restore is refused, and the Task stays in Blocked until you move it yourself.
:::

### What can refuse a transition

| Gate                 | When it fires                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Open blockers**    | Moving to **In progress** or **Done** while any blocking Task is still open. This is an integrity rule and cannot be overridden.                                                                                      |
| **Approvers**        | Moving to **Done** when the Task requires all approvers and not all of them have approved. A Task with no approvers configured passes freely.                                                                         |
| **Red quality gate** | An **Agent** moving a Task from In progress to In review while the latest run's gate is red or skipped and the Work requires passing acceptance checks. A person moving the Task themselves is never blocked by this. |

### Who can move a Task

Every Task endpoint matches on the Task's own **`userId`** — single reads go through an id-and-user lookup, and `task.userId = :userId` is the first predicate of the list query. Another account's Task is not visible, listable or transitionable; it reads as _not found_ rather than _forbidden_.

That column is who the Task **belongs to**, which is a different field from who raised it. A Task an Agent creates through its own tool is recorded as agent-created but still belongs to that Agent's owner, and is reachable only by them.

Agents move Tasks too, as part of a run, and that is the one case with an extra gate: the red-gate refusal above only applies when the mover is an Agent.

:::note No screen sends the `force` override
The API accepts `force: true` on a transition to bypass the approver gate and the agent red-gate refusal (never the blocker gate). No screen in the app sends it, so a blocked-by-approvers Task has to be resolved rather than forced.
:::

## Running a Task with an Agent

To run it on a computer you choose — in a checkout you choose, as a session you can watch — use **Fix with an agent on this computer** instead; see [Tasks and GitHub on your computers](./fleet-tasks-and-github.md).

There are two different paths that start a run, and they resolve the Agent differently.

### Run

**Run** — on a kanban card, or beside the title on Task detail — hands the Task to an Agent. The Agent is resolved in this order:

1. the Agent you pick explicitly in the picker,
2. an Agent **assignee** on the Task,
3. the Task's own **Agent** field,
4. the Work's **default Agent**, when the Work names one ([below](#the-works-default-agent)),
5. an Agent scoped to the Task's Work.

If exactly one candidate resolves, the run starts. If several do, or none, the picker opens and tells you which it is — each option is tagged **Assigned**, **Task agent** or **Work default**. With no candidate at all you get: _"No Agent is assigned to this Task and its Work has no default Agent."_

The Work's default Agent only applies to a Task that has no Agent of its own (steps 2 and 3). A Task that has one resolves exactly as it did before the default existed, also when its own Agent is the default itself (for example the first iteration of a [Goal](./goals.md#who-runs-a-brand-new-goal), which records the default as its Agent). Naming a default never makes such a Task ambiguous and never starts a different Agent for it. The picker still lists the default, tagged **Work default**, first among the Work's Agents.

### The Work's default Agent

A Work can name the Agent that runs its new Tasks when nobody picks one. Set it under **Work → Settings → Default Agent**, or with `PATCH /api/works/:id` and `{ "defaultAgentId": "<agent id>" }`; `null` clears it. Use it for an Agent that serves several Works: an Agent pinned to no single Work is never "an Agent scoped to the Task's Work", so before this setting such an Agent was only used when someone picked it.

Every path that starts a Task without a named Agent tries the default before its older rule:

- **Run** (step 4 above), including a [Mission](./missions.md#output) starting the Tasks it files;
- the [Mission](./missions.md#output) check that decides whether a Repository Work can take Tasks at all;
- a [Goal](./goals.md#who-runs-a-brand-new-goal)'s first iteration, when the Goal is scoped to the Work;
- a change requested on an [App Work](./app-works-evolve.md), before the Agent of its most recent Task (it must still be allowed to commit).

Only the Work's **owner** can set or clear it: a shared Work has one default, and it decides what the owner's Tasks, Missions and Goals start. Any other editor gets `403` with the code `workDefaultAgentOwnerOnly`, and the settings card is read-only for them. A save that sends the value already stored is accepted and changes nothing. The default only ever runs the owner's Tasks; a Task another member starts falls back to the Work's only Agent. Automated credentials (a fleet-run token, an integration key) cannot change it.

The setting only accepts an Agent the owner owns, that is not archived, in the same tenant and organization as the Work. A Work with no tenant or organization recorded accepts only a personal Agent (one that belongs to no organization). Any other id answers `404 Agent not found`, the same for an Agent of another organization as for one that does not exist. The default is checked again every time it is used, by every path including background ones: an Agent you archive, delete or move out of the Work's scope later is skipped, and the Work falls back to its only Agent until you pick another default.

An Agent that is still usable but loses a permission the Task needs is not skipped. For a Repository Work, a default that may no longer commit or open pull requests keeps resolving, so a Mission files nothing on that Work and its save warns `repoWorkAgentCannotOpenPullRequests` until you grant the permission or pick another default.

Moving a Task to **In progress** and recurring Tasks do not use it: both start only the Task's own assignees or Agent.

### Moving to In progress

Entering **In progress** — by drag, by the Move menu, or by the status buttons — dispatches on its own. It uses the Task's **Agent assignee rows** when it has any, and falls back to the **Task's own Agent** when it has none. A Task with neither dispatches nothing.

The right rail's **Agent** picker on Task detail writes that Task-level Agent, so assigning there is enough to make the move start a run.

:::caution The Work's default Agent is not part of this fan-out
**Run** will fall back to the Work's default Agent or a Work-scoped Agent; moving the Task to In progress will not. That is why the board opens the agent picker whenever you move a card into In Progress — by drag or from the card's **Move →** menu, both go through the same handler — unless the Task has an assignee row or its own Agent. A Work default alone would move the card and start nothing.
:::

:::note This path was silently broken until EW-054
The fan-out used to iterate assignee rows only and give up when there were none. Assignee rows can only be created through the API, so the ordinary flow — pick an Agent on the detail page, move the Task to In progress — moved the card and started nothing, with no error and no log. It now falls back to the Task's own Agent.
:::

Other things that happen around a run:

- **A run already in flight** for the same Task and Agent is a refusal, not a second run: _"A run is already in flight for this Agent."_ Steer or cancel the live run instead.
- If too many runs are already in flight, the run is accepted but **parked**, and it starts when a slot frees. Clicking **Run** reports _"Queued — waiting for capacity"_ in the run menu; a run parked by the move-to-In-progress fan-out says nothing about capacity — the card shows only a **Queued** chip.

### When a reviewer rejects the work

When a run's work has problems, record them on the Task. One finding per rejection reads best:

```http
POST /api/tasks/:id/reject
{ "feedback": "The retry path drops the auth header: add it back and cover it with a test.", "runNow": true }
```

| Field      | Required             | Meaning                                                                                                                                                         |
| ---------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feedback` | Yes                  | The finding, up to 8,000 characters.                                                                                                                            |
| `runId`    | No                   | The run whose output you are rejecting, when you know it.                                                                                                       |
| `runNow`   | No (default `false`) | Start the fix run right after recording, exactly as **Run** (`POST /api/tasks/:id/run`) would: the same Agent resolution, the same refusals, the same capacity. |

The answer is `201` with the recorded rejection: `id`, `taskId`, `source` and `createdAt`. With `runNow: true` it also carries `run` — `{ "ok": true, "run": { "runId", "agentId", "dispatched", "parked" } }`, or `{ "ok": false, "error": { "code", "message" } }` when the run could not start (`RUN_ALREADY_IN_FLIGHT`, or no single Agent to run it). The rejection is recorded either way, so do not send it again; start the run later with **Run**. A fleet-run credential cannot record a rejection, with or without `runNow`.

Changes requested on the pull request itself — by a repository collaborator or an allow-listed review bot — are recorded the same way by the review bridge; see [CI feedback and the fix loop](./ci-auto-resume.md#reviewer-rejections).

**The next run is a fix run.** The next run of the Task — **Run**, `runNow`, a move to In progress, a recurring re-run, on the platform or on one of your computers — carries a `# REVIEW FEEDBACK TO ADDRESS` section with the findings recorded since the Task's last finished run, oldest first. It tells the run to:

- fix exactly those findings, on top of the commits already on the Task's branch;
- start nothing new: the Task's own description is the work that is already done;
- explain in its final message any finding it believes is wrong, instead of changing code for it, and account for every finding.

The findings are data, not instructions: they sit between fence markers carrying a code their authors cannot know, and nothing inside them can change the run's rules, grant it permissions or send its push anywhere else.

**Same branch, same pull request.** A fix run checks out the Task's branch at its pushed head (on another computer too, and on the same one when someone pushed to the branch since), pushes to that branch, and the open pull request picks the commits up. No second pull request is opened, and the Task moves back to **In review**. Whether the pull request is still open is checked when the run finishes: one merged or closed while the run worked gets a new pull request for the new commits, as before.

**Each finding is fixed once.** A run carries the findings it was given. When it completes they are used up, and a later run is not told about them again. When it fails, is cancelled, or stops to ask you a question, they go back: the next run gets them, and so does the run your answer starts (as its first message, like any resumed run).

- A finding stays waiting until a run that was given it completes. Nothing else retires it — not its age, and not another run finishing in the meantime. (The one exception was a single step on the deploy that introduced fix runs: findings recorded on the Task itself before it were retired then, so they did not all come due at once; findings on a still-open pull request were kept.)
- A finding recorded on a pull request follows that pull request: once it is merged or closed, or the Task moves on to a new one, its findings are no longer given to runs. Findings recorded on the Task itself (`POST /api/tasks/:id/reject`) always are.
- One run carries at most **10** findings, each cut at 4 KiB and 24 KiB in all. The rest wait for the next run, and the run is told how many are waiting. On one of your computers, a Task whose description leaves too little room carries fewer, and the ones left out wait too.

:::note A resumed run
Resuming a parked run — its Inbox answer, or **Resume** — replays the pending findings as the first message of the resumed run.
:::

:::warning No screen assigns a person
The Task detail page has an **Agent** picker and nothing else. Reviewers, approvers, blockers, relations, and assignees of either kind (`user` or `agent`) exist in the data model and in the API, but no screen creates them. Add an assignee with `POST /api/tasks/:id/assignees`, passing `assigneeType` (`user` or `agent`) and `assigneeId`. Watchers exist as a table only — there is no endpoint for them either.
:::

## Acceptance checks (quality gates)

A Task can declare its own acceptance checks — commands that must exit `0` before an Agent's work on it counts as finished. Declare them in the collapsible **Acceptance checks** section on `/tasks/new`, or edit them later in the **Checks** section on Task detail.

Leave the section empty and the Task inherits the Work's `checkDefaults` untouched. **Max gate attempts** (_Inherit from Work_, or 1–5) caps how many times a red gate sends the Agent back to fix it **within a single run**. When the cap is reached that run stops retrying and finalizes with its gate still red; the Task's own status is not changed by the budget.

:::caution The check editor does not enforce the 20-check cap
The API rejects more than **20** acceptance checks on a Task, on both create and update. The editor has no such stop — it will keep adding rows, and the save fails when you submit. Keep the list under 20.
:::

The full model — how a Task's checks merge over the Work's defaults, what `off` / `warn` / `required` mean, and how to read a gate result — is in [Quality Gates](./quality-gates.md).

## Settled decisions this Task may re-open

Task detail carries one panel you never configure: an amber banner, between the status row and the description, listing the **accepted decisions** in the Work's Knowledge Base that this Task appears to re-litigate. It renders only when there is something to say — on the overwhelming majority of Tasks it is silent.

The check is deterministic: a term-overlap heuristic (`term-overlap/v1`, no model call, no embeddings) run over the Task's title and description against the `class: decision`, `status: accepted` documents in that Task's Work KB. Each hit is tagged **Strong match** or **Possible match**, shows the terms it shares with the decision and the decision's rationale, and links straight to the document so you can read the call before spending a run re-arguing it. The banner re-runs whenever you save the description.

:::note Advisory only — nothing is blocked
No Task action is gated, disabled or refused by this panel; it exists so you learn the question is already settled _before_ the work starts. If the call genuinely has changed, supersede the decision rather than working around it — see [Decisions & the Memory Review Queue](./memory-decisions.md).
:::

The same report is available at `GET /api/tasks/:id/decision-conflicts`, which answers `{ conflicts, scanned, heuristic }`; an empty `conflicts` array is the normal case.

## Editing a Task afterwards

The detail page can edit the **description** (inline, with Save/Cancel), the **Work**, the **Agent**, the **acceptance checks** and attempt budget, the **Task isolation** override, and the **recurring** schedule.

:::caution The detail page shows title, priority and labels read-only
No form on the Task detail page changes a Task's title, its priority or its labels once it exists. The API supports changing all three via `PATCH /api/tasks/:id`.
:::

Attachments require a Work: the upload control is disabled on a Task that is not filed under one, and the API refuses the attach.

## Scheduling a Task: Run once, Scheduled, Recurring

The **Schedule** panel in the Task detail right rail is a single control with three mutually exclusive modes:

| Mode          | What it means                                                                                                              | What it stores                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Run once**  | The default. No schedule at all — the Task runs when you or an Agent dispatch it.                                          | Nothing.                                                         |
| **Scheduled** | One-shot. **This** Task runs once, automatically, at an instant you pick. No clone is made.                                | `scheduledAt`, plus `scheduleClaimedAt` once the slot has fired. |
| **Recurring** | A template that spawns a fresh instance per occurrence — the panel described in [Recurring Tasks](#recurring-tasks) below. | `recurrenceRule` or `recurrenceCron`, plus the next occurrence.  |

Picking a mode only decides which panel is on screen; the modes are enforced as exclusive server-side, so the radio cannot arm two at once.

### Scheduled (one-shot)

1. Open the Task and find **Schedule** in the right rail.
2. Click **Scheduled**.
3. Pick a date and time under **Run at** — a local-time picker; the platform stores the instant.
4. Click **Schedule**. The panel then reads **Armed for** your time, and **Dispatched at** the moment the slot actually fired.
5. **Remove schedule** clears the slot and returns the Task to **Run once**. A Task still carrying a slot also says _"Still scheduled for …"_ under **Run once**, with the same clear button, so a forgotten schedule cannot hide behind the mode you are looking at.

A time that is not in the future is refused twice over — _"Pick a time in the future."_ in the picker, and `runAt must be in the future.` from the API. Re-saving a new time **moves** the existing slot rather than adding a second one, and clears the previous claim so the dispatcher picks up the new instant.

A dispatcher runs every minute, scans the Tasks whose `scheduledAt` is due, claims each slot exactly once — so two workers can never double-fire it — and dispatches the Task through the same gated path a board **Run** uses. Agent resolution matches the move-to-In-progress fan-out: the Task's **Agent assignee** rows when it has any, otherwise the Task's own **Agent**. With neither, nothing runs and you get a `task_run_no_agent` notification instead of a silent skip.

:::caution One-shot and recurring are mutually exclusive
Scheduling a one-shot run on a recurring template is refused — _"This Task is a recurring template — stop the recurrence before scheduling a one-shot run."_ The panel says so before you try. Demote the recurrence first.
:::

:::note A one-shot slot is not in Activity → Schedules
The **Schedules** view at `/activity` gathers _recurring_ Tasks (alongside agent heartbeats, Work schedules, Mission ticks and the rest). A one-shot `Scheduled` Task is not one of its sources, so the Task's own **Schedule** panel is the only place its armed time is shown.
:::

API: `POST /api/tasks/:id/schedule` with `{ "runAt": "<ISO datetime>" }`, and `DELETE /api/tasks/:id/schedule` to clear it. `PATCH /api/tasks/:id` also accepts `scheduledAt`, where the three states are distinct: absent leaves the schedule untouched, `null` clears it, and a string (re-)schedules.

## Recurring Tasks

:::note Where the recurring panel lives
It is the **Recurring** mode of the Schedule panel above — on a Task that does not repeat yet, click **Recurring** in the right rail to reveal it.
:::

The **Recurring schedule** panel in the detail page's right rail turns a Task into a template. **Promote to recurring** opens the picker: a frequency of Daily, Weekly, Monthly or a custom RRULE, an optional end date, and an optional maximum number of occurrences (1–9999). It shows the rule it will send as a preview, and refuses to save an invalid one — or one that yields no future occurrence.

The platform then spawns instances on that schedule, each pointing back at the template. **Demote to one-off** turns the template back into a plain Task, behind a browser confirmation; existing instances stay, and no new ones spawn.

### At most N open at a time

Every fire of a recurring template spawns a **new** instance with its own run, branch and pull request. Without a limit, a daily loop opens a pull request every day however many of yesterday's are still waiting for review. **At most open at a time** in the same panel caps that: with a limit of `3`, a scheduled fire while three earlier instances are still open is **skipped**.

- **Blank means no limit.** That is the default, and every template that existed before the setting fires exactly as it always did. On a template that is already recurring, the field saves on its own and leaves the cadence and the next fire untouched. A whole number from 1 to 100.
- **What counts as open.** An instance is open while any of these holds:
    - a run of it is queued or running, and that run started (or, never started, was queued) in the **last 7 days**. That includes a run waiting on your answer and a run held behind a paused Agent, the global stop switch or a fleet usage limit: the run sweeper never reaps those, so they stop counting a week after they started instead;
    - it is not Done or Cancelled, its pull request is open or a draft, it is still on the template's Work, and the PR-status sweep read the pull request in the **last 7 days**. While the sweep keeps confirming it, this has **no time limit**: an unreviewed pull request is exactly the backlog the limit is for, so merging or closing it (or cancelling the instance) is what frees the slot;
    - it is not Done or Cancelled, its pull request is open or a draft, and the instance was written in the **last 7 days**. Every PR-status sweep read also writes the instance, so this only ages out for an instance the sweep no longer reads: one taken out of its Work, an instance of a template with no Work, or one whose reads keep failing;
    - it is not Done or Cancelled, has no pull request yet (or one the PR-status sweep has not read), and was spawned in the **last 7 days**;
    - it is not Done or Cancelled, its pull request was **closed without merging**, and it changed in the **last 24 hours** (the same hold a Mission's open-Tasks cap uses).
- **What frees a slot.** Merging the pull request frees it at once, and so does moving the instance to Done or Cancelled. A pull request closed without merging frees it a day later. These end by themselves within a week, even if nobody touches them: a run that has been waiting or held for 7 days, an instance that failed without opening a pull request, and an open pull request the sweep no longer reads (an instance taken out of its Work, or reads that keep failing).
- **What does not end by itself.** An open pull request the platform keeps reading but can never see merged or closed holds its slot until someone **cancels the instance** or **forces Run now**. That covers an instance moved to another Work, or a pull request the git provider answers "not found" for (the repository was deleted, the app was removed, or access was lost). The daily `schedule_skipped` row names it.
- **What a skip does.** The slot passes: the next fire is computed as usual, but the occurrence count does not move, so a **Max occurrences** cap still gets every fire it promised. The template's activity gets a `schedule_skipped` row (_"Skipped: 3 instances still open (T-12, T-15, T-18); at most 3 at a time."_) on the first skip of a stall, then on the first skip of each UTC day the stall lasts, so a long stall shows up every day without a fast schedule writing a row per minute. **Activity → Schedules** shows **Skipped** with the time of the latest skip in the row's last-run column. That goes away when an instance is spawned again (by the schedule or by **Run now**, forced or not) or when the limit is cleared.
- **Run now** honours the limit too: at the limit it answers _"At most 3 instances of this schedule may be open at a time, and 3 instances are still open (…)"_ (`409 SCHEDULE_TOO_MANY_OPEN`, with the open instances in the body). From **Activity → Schedules** and from a computer's **Schedules** tab you are asked whether to run it anyway; through the API send `{ "force": true }` to `POST /api/tasks/:id/recurring/run-now` (any other body fields are ignored, as before). Forcing bypasses only this limit, never the refusal for a fire whose previous run is still queued or running.

Two dispatchers can never both slip under the limit: a scheduled fire under a limit counts, claims its slot and inserts the instance while holding the same per-template claim **Run now** holds. A tick that arrives while the claim is held leaves the slot due for the next minute, and then counts what the holder spawned; a **Run now** that arrives while a tick holds it is refused as already running.

API: `POST /api/tasks/:id/recurring` takes `recurrenceMaxOpenInstances` (a whole number 1–100, or `null` for no limit; left out, the template keeps its limit). A body consisting of `recurrenceMaxOpenInstances` alone updates just the limit of a Task that is already recurring; any other recurrence field without a cadence is still a 400. The Task read returns `recurrenceMaxOpenInstances` and `recurrenceSkippedAt`. Stopping the recurrence clears both.

## Starting unblocked Tasks automatically

A Task tree instantiated from a template is a graph: sub-tasks wait on each other through blockers.
Nothing used to walk that graph — when a blocker finished, the sub-task behind it sat in **To Do**
until somebody dragged it. The **task-graph fan-out** does that walk on the same per-minute tick as the
recurring and scheduled scans.

**It is off by default.** This is the only thing on the platform that starts work nobody clicked, so an
operator has to switch it on with `TASK_FANOUT_MAX_STARTS_PER_OWNER` (a positive number; `0` — the
default — means the driver starts nothing at all). Note the inversion: on the concurrency valves
`AGENT_MAX_CONCURRENT_RUNS_PER_WORK` / `_PER_ORG`, `0` means "no ceiling"; here it means "no starts".
`TASK_FANOUT_SCAN_LIMIT` (default `50`) bounds how many To Do Tasks one tick looks at.

When it is on, one tick starts a Task only when **all** of the following hold:

- it is in **To Do**, not hidden from the board, not a recurring template, and not a scheduled one-shot
  (those belong to the other two scans);
- it has **no open blocker** — a blocker counts as open until it is Done or Cancelled, exactly as the
  board's own blocker gate defines it;
- an agent is bound to it, by an assignee or on the Task itself. A Task with no agent is a human's
  Task and is never auto-started;
- it has **never been run**. "Still in To Do" is not the same as "never started": the board's **Run**
  button, the recurring scan and a Goal's iteration loop all start a run and leave the card in To Do.
  A Task that already has a run — even a finished one — is left alone, so the fan-out can never
  re-run somebody else's work or push a Goal past its own iteration ceiling. Re-running a Task after
  its run finished stays a human decision;
- it is not a Goal's iteration Task and not an instance of a recurring Task. Those belong to the Goal
  loop and the recurring scan respectively, each with its own ceiling;
- the owner has not reached the per-owner bound for this tick, and the run admission gates admit it.

Every start goes down the ordinary dispatch path, so the global stop flag, the per-Work and per-org
concurrency valves, the plan entitlement, the credits precheck and the agent's own budget all apply
unchanged. A refusal from any of them leaves the Task in **To Do** — it is a candidate again on the
next tick, never consumed. While the global stop flag is set the fan-out starts nothing at all.

## Deleting a Task

**Delete** on the detail page opens a confirmation dialog naming the Task's slug. Nothing happens on the first click; the deletion runs only when you confirm, and you are returned to `/tasks`.

## Related

- [Creating a Work](./creating-a-work.md) — the scope most Tasks are filed under.
- [Missions](./missions.md) and [Ideas](./ideas.md) — the other two things a Task can be associated with.
- [Agents](./agents.md) — what actually executes a Task.
- [Quality Gates](./quality-gates.md) — the acceptance checks a Task declares.
- [Task Isolation](./task-isolation.md) — the per-Task branch an agent run works on.
- [Merge Policy](./merge-policy.md) — what happens to that branch afterwards.
- [Inbound Triggers](./inbound-triggers.md) — the Triggers tab: rules that create a Task every time something outside the platform happens.
- [Decisions & the Memory Review Queue](./memory-decisions.md) — the accepted decisions the Task detail banner checks against.
- [Activity](./activity.md) — the Schedules view, where a recurring Task is listed alongside every other timer in your account.
- API reference: [Tasks API](../api/tasks.md).
