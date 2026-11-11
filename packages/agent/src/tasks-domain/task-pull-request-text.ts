import {
    boundRunPullRequestSummary,
    composeRunPullRequestTitle,
    parseRunPullRequestTitle,
    redactRunSummarySecrets,
    sanitizeRunPullRequestBody,
} from '@ever-works/contracts';
import type { Task } from '../entities/task.entity';

/**
 * The title and body of the pull request the platform opens for a Task's
 * branch after an agent run.
 *
 * The run's final message (its summary) is the best description of the
 * change there is — what was wrong, what changed, how it was verified, what
 * could not be run — so it becomes the body, and its `PR-TITLE:` line the
 * title. It is MODEL-AUTHORED text posted under the owner's identity, so it
 * goes through the contracts' rules: credentials redacted
 * (`redactRunSummarySecrets`), then the sanitizer (`sanitizeRunPullRequestBody`:
 * mentions, closing keywords, cross-references, HTML, images and script
 * links neutralised; code kept; capped). It only ever arrives as the run's
 * `summary` — never the node's log tail, never its environment.
 *
 * Without a summary (a cloud run, an older node, a run that wrote none) the
 * title and body are EXACTLY what they were before this existed; a summary
 * without a usable `PR-TITLE:` line keeps today's title and still gets the
 * summary body. The fixed footer is the platform's own text and is never
 * sanitized: the Task slug, that an agent run opened it, the merge-policy
 * sentence and, when the gate was fully green, the quality-gate note.
 */
export interface TaskPullRequestTextInput {
    task: Pick<Task, 'slug' | 'title'>;
    /** The run's final message, as the node or the runtime reported it. */
    summary?: string | null;
    /** Set only when every acceptance check came back green. */
    gate?: { checksPassed: number } | null;
    /**
     * A NON-primary repository the Task spans (multi-repo slice C): its
     * pull request says which repository it is and links the primary.
     */
    mount?: { repositoryId: string; primaryPrUrl?: string | null } | null;
}

export interface TaskPullRequestText {
    title: string;
    body: string;
}

/** The merge-policy sentence every agent pull request carries, summary or not. */
export const TASK_PULL_REQUEST_MERGE_POLICY_SENTENCE =
    "Review before merging — merge policy is governed by the Work's merge-policy settings.";

export function composeTaskPullRequestText(input: TaskPullRequestTextInput): TaskPullRequestText {
    const { task, mount } = input;
    // Defence in depth (review of #3145, B1): the fleet reconciler already
    // bounds and redacts the summary before it gets here, but any other caller
    // (the cloud finalize, a future one) gets the same guarantee. Bounded
    // first, so the redaction never runs over more than the head and the
    // `PR-TITLE:` line; credentials out before the title or body is built.
    const summary =
        typeof input.summary === 'string' && input.summary
            ? redactRunSummarySecrets(boundRunPullRequestSummary(input.summary))
            : '';
    const runTitle = summary ? composeRunPullRequestTitle({ summary, slug: task.slug }) : null;
    // The PR-TITLE line is the title, not part of the description; the rest
    // of the summary is. Allowed links: the primary pull request, which the
    // footer cites anyway.
    const described = summary
        ? sanitizeRunPullRequestBody(parseRunPullRequestTitle(summary).summary, {
              allowedUrls: [mount?.primaryPrUrl],
          })
        : '';

    const legacyTitle = mount
        ? `Task ${task.slug}: ${task.title ?? 'agent run output'} (${mount.repositoryId})`
        : `Task ${task.slug}: ${task.title ?? 'agent run output'}`;
    const gateNote = !mount && input.gate ? quality(input.gate.checksPassed) : null;
    const title = runTitle ?? legacyTitle;

    if (!described) {
        return { title, body: legacyBody(input, gateNote) };
    }
    const footer = mount
        ? `Task \`${task.slug}\` · opened by an agent run in \`${mount.repositoryId}\`, one of the repositories the Task spans; the description above is the run's own summary.${
              mount.primaryPrUrl ? ` Part of ${mount.primaryPrUrl}.` : ''
          } ${TASK_PULL_REQUEST_MERGE_POLICY_SENTENCE}`
        : `Task \`${task.slug}\` · opened by an agent run; the description above is the run's own summary. ${TASK_PULL_REQUEST_MERGE_POLICY_SENTENCE}`;
    return {
        title,
        body: [described, '---', footer, gateNote].filter(Boolean).join('\n\n'),
    };
}

/** The body every agent pull request had before run summaries reached it — byte for byte. */
function legacyBody(input: TaskPullRequestTextInput, gateNote: string | null): string {
    const { task, mount } = input;
    if (mount) {
        const primaryNote = mount.primaryPrUrl ? ` Part of ${mount.primaryPrUrl}.` : '';
        return `Automated changes for Task \`${task.slug}\` (agent run) in \`${mount.repositoryId}\`, one of the repositories the Task spans.${primaryNote} ${TASK_PULL_REQUEST_MERGE_POLICY_SENTENCE}`;
    }
    return `Automated changes for Task \`${task.slug}\` (agent run). ${TASK_PULL_REQUEST_MERGE_POLICY_SENTENCE}${
        gateNote ? `\n\n${gateNote}` : ''
    }`;
}

function quality(checksPassed: number): string {
    return `Quality gate: all ${checksPassed} acceptance checks green.`;
}
