# Onboarding: generation console, quick start and loading transition

Three gaps a visitor hit after typing a prompt into the ever.works home page
(reported 2026-11-20 on app.ever.works, `/onboarding#type=directory-website`):

| What the visitor saw                      | Why                                                                                                                                                              | Now                                                                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only a "Generating…" button               | The label covered the synchronous `POST /api/works/quick-create` (create the Work and its repositories, then start the run). Nothing was read after it returned. | A live console: the Work being created, then the generation's step, progress, item count, warnings and pipeline log.                                                |
| An empty page after the request returned  | The step closed the wizard at once; `/onboarding` rendered nothing while `router.push('/')` loaded the dashboard (there is no `loading.tsx`).                    | The wizard stays open on the console. "Open your Work" (or the run finishing) goes to the Work's Generator tab, behind an "Opening …" loading state.                |
| "Step 11 of 11", steps 1–10 shown as done | The hand-off jumped to the last step on purpose (EW-617 G4). The home-page `type` chip was never read, so `#type=directory-website` stayed in the URL.           | A prompt-first quick start: Your idea → Generate → Open your Work, with the defaults named and "Customize setup" for the full wizard. `type` becomes the Work kind. |

## Where the console's data comes from

Nothing new on the API. The console polls the same source the Work page uses
(`WorkLayoutClient`): `getWorkForStatusRefresh` → `GET /api/works/:id`, field
`generateStatus` (`status`, `stepName`, `stepIndex`, `totalSteps`, `progress`,
`itemsProcessed`, `warnings`, `recentLogs`, `error`), every 3 s while it runs.
The quick-create request itself reports nothing until it returns, so the
console says what that request does and shows a clock.

- `apps/web/src/components/onboarding/generation-console.ts` — reducer and helpers (no I/O).
- `apps/web/src/components/onboarding/use-generation-console.ts` — polling and the clock.
- `apps/web/src/components/onboarding/GenerationConsole.tsx` — the view.
- `apps/web/src/components/onboarding/prompt-handoff.ts` — reads `#prompt`, `#corrId`, `#type`.

## Why a quick start rather than the full wizard

A visitor who typed a prompt on ever.works has already said what they want.
Walking them through eleven provider and profile steps first costs most of
that intent, and every step has a working default. Landing them on the last
step with the others marked as done (the old behaviour) was worse: it looked
like the wizard skipping itself, and its copy ("We saved your wizard choices")
was not true. So the hand-off gets its own short path, which names the defaults
it will use, and one click opens the normal wizard from step 1 with the prompt
and kind kept. Visitors without a prompt see the wizard exactly as before.

## Screenshots

Screenshots of each state and a short recording are attached to
[ever-co/ever-works#3274](https://github.com/ever-co/ever-works/pull/3274) rather
than committed, to keep binary media out of the repository's history.
