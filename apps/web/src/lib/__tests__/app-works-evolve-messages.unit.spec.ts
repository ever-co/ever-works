import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';

/**
 * APW-08 T28 (ACC-08-30, strings half) — the evolve loop's web copy, complete in all 21 locale
 * bundles. Limited to the sub-trees this lane added:
 *
 *  - `dashboard.tasksPage.delivery` — the delivery chips, the Task page's Delivery section and
 *    the Delivery filter;
 *  - `dashboard.tasksPage.cost` — the Task page's Cost section;
 *  - `dashboard.activity.filters.types.appChange` — the `app_change` Activity badge.
 *
 * Lane L5 (T26 / T27 / T54) adds:
 *
 *  - `dashboard.tasksPage.deliveryPosts` — the keyed Task-thread posts (FR-43), rendered in the
 *    reader's locale; the agent's English `body` fallback is pinned to the same strings by
 *    `packages/agent/src/tasks-domain/__tests__/task-thread-posts.spec.ts`;
 *  - `dashboard.tasksPage.detail.systemAuthor` — the author of a `system` post;
 *  - `dashboard.workDetail.requestChange` — the chat change card's confirmation (spec §6.4);
 *  - `dashboard.aiChat.changeCard` — the chat change card's reply and chain;
 *  - the new `dashboard.tasksPage.delivery` leaves (Deploy now's hint, Create a fix Task), inside
 *    the sub-tree already listed.
 *
 * Lane L10 (T12 / T48, T27's `TaskRunContainmentNotice`) adds:
 *
 *  - `dashboard.tasksPage.cost.containment` — the containment notice, inside `cost` above;
 *  - `dashboard.tasksPage.appRules.containmentDowngrade` / `.allowOnThisMachine` — the S33 copy
 *    and its action (the rest of `.appRules` is T28's).
 *
 * `next-intl` falls back per LEAF, but an absent intermediate object collapses the whole subtree
 * into raw key paths, and none of `tsc`, the build or the English e2e lane notices. So:
 *
 *  1. every en leaf exists, non-empty, in every bundle;
 *  2. no leaf name contains a `.` (`t('a.b')` is a path, so a key named `a.b` is unreachable);
 *  3. every message is valid ICU in every locale (a broken brace renders the key path);
 *  4. every `{placeholder}` the English copy takes survives in each locale's copy.
 *
 * Every assertion is derived from `en.json`, the copy of record, not from a second list.
 */

const MESSAGES_DIR = resolve(process.cwd(), 'messages');

const SUBTREES = [
    'dashboard.tasksPage.delivery',
    'dashboard.tasksPage.cost',
    'dashboard.activity.filters.types.appChange',
    'dashboard.tasksPage.deliveryPosts',
    'dashboard.tasksPage.detail.systemAuthor',
    'dashboard.workDetail.requestChange',
    'dashboard.aiChat.changeCard',
    'dashboard.tasksPage.appRules.containmentDowngrade',
    'dashboard.tasksPage.appRules.allowOnThisMachine',
    // APW-08 P2 T37 — the Goal's Work (T33) and the Mission's Output (T36).
    'dashboard.goalNew.work',
    'dashboard.goalDetail.work',
    'dashboard.missionDetail.output',
    // APW-08 P3 T40 — the Build on an open-source app template's form.
    'dashboard.missionsPage.buildOnApp',
] as const;

type Tree = { [key: string]: string | Tree };

function locales(): string[] {
    return readdirSync(MESSAGES_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.replace('.json', ''))
        .sort();
}

function bundle(locale: string): Tree {
    return JSON.parse(readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8')) as Tree;
}

function at(root: unknown, path: string): unknown {
    return path
        .split('.')
        .reduce<unknown>(
            (node, key) =>
                node && typeof node === 'object'
                    ? (node as Record<string, unknown>)[key]
                    : undefined,
            root,
        );
}

/** Every leaf path under `path` (the path itself when it is a leaf). */
function leaves(root: unknown, path: string): string[] {
    const node = at(root, path);
    if (typeof node === 'string') return [path];
    if (!node || typeof node !== 'object') return [];
    return Object.keys(node).flatMap((key) => leaves(root, `${path}.${key}`));
}

/** Leaf NAMES under `path` (keys, not paths), to catch a key that itself holds a dot. */
function leafNames(node: unknown): string[] {
    if (!node || typeof node !== 'object') return [];
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
        typeof value === 'object' && value !== null ? [key, ...leafNames(value)] : [key],
    );
}

function placeholders(message: string): string[] {
    return [...message.matchAll(/\{\s*([A-Za-z0-9_]+)\s*[,}]/g)].map((match) => match[1]).sort();
}

const en = bundle('en');
const enLeaves = SUBTREES.flatMap((path) => leaves(en, path));

describe('APW-08 evolve copy (T28)', () => {
    it('the sub-trees exist in en.json and are not vacuous', () => {
        expect(locales()).toHaveLength(21);
        expect(locales()).toContain('en');
        expect(enLeaves.length).toBeGreaterThanOrEqual(72);
        expect(enLeaves).toContain('dashboard.tasksPage.delivery.chipLive');
        expect(enLeaves).toContain('dashboard.tasksPage.delivery.closeConfirm');
        expect(enLeaves).toContain('dashboard.tasksPage.cost.unknown');
        expect(enLeaves).toContain('dashboard.activity.filters.types.appChange');
    });

    it('carries lane L5 copy: thread posts, Deploy now, Create a fix Task, the chat change card', () => {
        expect(enLeaves.length).toBeGreaterThanOrEqual(125);
        for (const path of [
            'dashboard.tasksPage.deliveryPosts.merged',
            'dashboard.tasksPage.deliveryPosts.buildStarted',
            'dashboard.tasksPage.deliveryPosts.buildSucceeded',
            'dashboard.tasksPage.deliveryPosts.buildFailed',
            'dashboard.tasksPage.deliveryPosts.deploying',
            'dashboard.tasksPage.deliveryPosts.live',
            'dashboard.tasksPage.deliveryPosts.deployFailed',
            'dashboard.tasksPage.deliveryPosts.followUpOpened',
            'dashboard.tasksPage.deliveryPosts.closedWithoutDeploy',
            'dashboard.tasksPage.delivery.deployNow',
            'dashboard.tasksPage.delivery.deployNowHint',
            'dashboard.tasksPage.delivery.createFixTask',
            'dashboard.tasksPage.delivery.createFixTaskConfirm',
            'dashboard.tasksPage.delivery.errors.fixTaskUnavailable',
            'dashboard.tasksPage.detail.systemAuthor',
            'dashboard.workDetail.requestChange.title',
            'dashboard.workDetail.requestChange.body',
            'dashboard.workDetail.requestChange.start',
            'dashboard.aiChat.changeCard.started',
            'dashboard.aiChat.changeCard.pollingStopped',
        ]) {
            expect(enLeaves).toContain(path);
        }
        // Spec §6.4's copy, verbatim.
        const en = bundle('en');
        expect(at(en, 'dashboard.workDetail.requestChange.title')).toBe(
            'Start a change on {work}?',
        );
        expect(at(en, 'dashboard.workDetail.requestChange.body')).toBe(
            '{agent} will work on it. An agent run will start; runs are billed to your workspace.',
        );
        expect(at(en, 'dashboard.tasksPage.deliveryPosts.live')).toBe('Live at {url}.');
    });

    it('carries the APW-08 P2 copy: the Goal’s Work and the Mission’s Output (T37)', () => {
        for (const path of [
            'dashboard.goalNew.work.label',
            'dashboard.goalDetail.work.lockedWhileRunning',
            'dashboard.missionDetail.output.tasksPerTick',
            'dashboard.missionDetail.output.openCap',
            'dashboard.missionDetail.output.noAppWork',
            'dashboard.missionDetail.output.repoIsolationOff',
            'dashboard.missionDetail.output.tasksOnWorks',
        ]) {
            expect(enLeaves).toContain(path);
        }
        const en = bundle('en');
        // Plan §6 copy, widened from "App Works" to "App or Repository Works" when a Mission's
        // Task output started filing on Repository Works too.
        expect(at(en, 'dashboard.missionDetail.output.tasks')).toBe(
            'Tasks on attached App or Repository Works',
        );
        expect(at(en, 'dashboard.missionDetail.output.noAppWork')).toBe(
            'Attach an App or Repository Work as Improves or Operates to file Tasks on it.',
        );
        expect(at(en, 'dashboard.missionDetail.output.nothingToFile')).toBe(
            'No attached App or Repository Work to file Tasks on.',
        );
        expect(at(en, 'dashboard.missionDetail.output.appliesTo')).toBe(
            'Applies to Works attached as Improves or Operates.',
        );
    });

    // A Mission's Task output files on Repository Works too: every sentence that named "App
    // Works" for this feature now names both kinds, in all 21 bundles, and the notice for a
    // Repository Work whose Task isolation is off is a real translation.
    it('names App AND Repository Works for the Mission’s Task output in all 21 bundles', () => {
        const paths = [
            'dashboard.missionDetail.output.tasks',
            'dashboard.missionDetail.output.noAppWork',
            'dashboard.missionDetail.output.nothingToFile',
            'dashboard.missionDetail.toasts.runNow.tasks-filed',
            'dashboard.missionDetail.toasts.runNow.no-tasks',
            'dashboard.missionDetail.toasts.runNow.spawned-and-tasks-filed',
            'dashboard.feed.narration.missionNothingToFile',
        ];
        const en = bundle('en');
        const problems: string[] = [];
        for (const locale of locales()) {
            const json = bundle(locale);
            for (const path of paths) {
                const value = at(json, path);
                if (typeof value !== 'string' || value.trim().length === 0) {
                    problems.push(`${locale}: ${path} missing`);
                    continue;
                }
                // "Repository" stays a product term next to "App" everywhere but Arabic, which
                // translates both ("مستودع" is its word for the Repository kind).
                if (!/Repository|مستودع/.test(value)) {
                    problems.push(`${locale}: ${path} still names App Works only`);
                }
            }
            const notice = at(json, 'dashboard.missionDetail.output.repoIsolationOff');
            if (typeof notice !== 'string' || !notice.includes('Task isolation')) {
                // The setting is labelled "Task isolation" in every bundle, so the notice names it
                // the way the settings page shows it.
                problems.push(
                    `${locale}: repoIsolationOff does not name the Task isolation setting`,
                );
            } else if (
                locale !== 'en' &&
                notice === at(en, 'dashboard.missionDetail.output.repoIsolationOff')
            ) {
                problems.push(`${locale}: repoIsolationOff is the English sentence`);
            }
            // The two notices only the API can raise (the Agent, the merge policy): present, a
            // real translation, and naming the Repository Work kind the way the bundle does.
            for (const key of ['repoAgentCannotOpenPullRequests', 'repoAllowsAgentMerge']) {
                const path = `dashboard.missionDetail.output.${key}`;
                const value = at(json, path);
                if (typeof value !== 'string' || value.trim().length === 0) {
                    problems.push(`${locale}: ${key} missing`);
                } else if (locale !== 'en' && value === at(en, path)) {
                    problems.push(`${locale}: ${key} is the English sentence`);
                } else if (!/Repository|مستودع/.test(value)) {
                    problems.push(`${locale}: ${key} does not name the Repository Work`);
                }
            }
        }
        expect(problems).toEqual([]);
    });

    it('carries the APW-08 P3 copy: the Build on an open-source app template form (T40)', () => {
        const en = bundle('en');
        // Plan §6 copy, verbatim.
        const plan: Record<string, string> = {
            product: 'Product',
            business: 'Business',
            appWork: 'App Work',
            summary: 'Every Monday 08:00 UTC · up to {count} Tasks a week · {amount} per run',
            backlogNote: 'New Tasks wait in Backlog for your approval.',
            suggestedGoals: 'Suggested Goals (created as drafts):',
            rules: 'Recommended app rules: schema changes merged by a person, {lines}-line PRs',
            proposeRules: 'Propose these rules',
            create: 'Create Mission',
        };
        for (const [key, copy] of Object.entries(plan)) {
            expect(at(en, `dashboard.missionsPage.buildOnApp.${key}`)).toBe(copy);
        }
        for (const path of [
            'dashboard.missionsPage.buildOnApp.appWorkPlaceholder',
            'dashboard.missionsPage.buildOnApp.noAppWorks',
            'dashboard.missionsPage.buildOnApp.rulesProposed',
            'dashboard.missionsPage.buildOnApp.rulesFailed',
        ]) {
            expect(enLeaves).toContain(path);
        }
        // Real translations, not English copies: the sentences differ from English everywhere.
        const copied: string[] = [];
        for (const locale of locales().filter((name) => name !== 'en')) {
            const json = bundle(locale);
            for (const key of ['backlogNote', 'suggestedGoals', 'proposeRules', 'rulesFailed']) {
                const path = `dashboard.missionsPage.buildOnApp.${key}`;
                if (at(json, path) === at(en, path)) copied.push(`${locale}: ${path}`);
            }
        }
        expect(copied).toEqual([]);
    });

    // Review of #3061 — two leaves outside the sub-trees above: the Activity feed's line for a
    // tick that had nothing to file, and the Run-now toast for a `both` Mission that did both.
    it('carries the review-of-#3061 leaves in all 21 bundles, placeholders and tags intact', () => {
        const paths = [
            'dashboard.feed.narration.missionNothingToFile',
            'dashboard.missionDetail.toasts.runNow.spawned-and-tasks-filed',
        ];
        const problems: string[] = [];
        for (const locale of locales()) {
            const json = bundle(locale);
            for (const path of paths) {
                const value = at(json, path);
                const english = at(en, path) as string;
                if (typeof value !== 'string' || value.trim().length === 0) {
                    problems.push(`${locale}: ${path} missing`);
                    continue;
                }
                if (placeholders(value).join(',') !== placeholders(english).join(',')) {
                    problems.push(`${locale}: ${path} placeholders differ`);
                }
                if (english.includes('<b>') && !(value.includes('<b>') && value.includes('</b>'))) {
                    problems.push(`${locale}: ${path} lost its <b> tag`);
                }
            }
        }
        expect(problems).toEqual([]);
    });

    it('every leaf exists, non-empty, in all 21 bundles', () => {
        const missing: string[] = [];
        for (const locale of locales()) {
            const json = bundle(locale);
            for (const path of enLeaves) {
                const value = at(json, path);
                if (typeof value !== 'string' || value.trim().length === 0)
                    missing.push(`${locale}: ${path}`);
            }
        }
        expect(missing).toEqual([]);
    });

    it('no key in the sub-trees contains a literal dot, and leaf names are camelCase', () => {
        for (const locale of locales()) {
            const json = bundle(locale);
            for (const path of SUBTREES) {
                const node = at(json, path);
                for (const name of leafNames(node)) {
                    expect(name, `${locale}: ${path} › ${name}`).not.toContain('.');
                    expect(name, `${locale}: ${path} › ${name}`).toMatch(/^[a-z][A-Za-z0-9]*$/);
                }
            }
        }
    });

    it('every message is valid ICU and keeps its English placeholders, in every locale', () => {
        const problems: string[] = [];
        for (const locale of locales()) {
            const json = bundle(locale);
            const t = createTranslator({
                locale,
                messages: json as never,
                onError: (error) => problems.push(`${locale}: ${error.message}`),
            });
            for (const path of enLeaves) {
                const message = at(json, path) as string;
                const english = at(en, path) as string;
                if (placeholders(message).join(',') !== placeholders(english).join(',')) {
                    problems.push(
                        `${locale}: ${path} placeholders ${placeholders(message)} ≠ ${placeholders(english)}`,
                    );
                }
                const values = Object.fromEntries(placeholders(english).map((name) => [name, '1']));
                t(path as never, values as never);
            }
        }
        expect(problems).toEqual([]);
    });
});
