/**
 * GitHub PR review loop (Wave 7, features g+h) — shared value types.
 *
 * Zero runtime behavior beyond constants: the service
 * (`pr-review.service.ts`) owns the flow, the API-side webhook bridge
 * and the `review_pull_request` chat tool both speak these shapes.
 */

/** Hard byte cap on the assembled diff text spliced into the prompt. */
export const PR_REVIEW_DIFF_MAX_BYTES = 48_000;

/** Maximum per-file comments a structured review may carry (v1 contract). */
export const PR_REVIEW_MAX_COMMENTS = 12;

/** Cap on the mention-instruction text forwarded into the prompt. */
export const PR_REVIEW_INSTRUCTION_MAX_CHARS = 4_000;

/** Cap on the PR body excerpt included in the prompt. */
export const PR_REVIEW_PR_BODY_MAX_CHARS = 2_000;

/**
 * Output-token budget of the review call. A reasoning model spends its hidden
 * reasoning from this same budget before it writes a word of the answer. With
 * no budget of its own the review got the provider default (4096 on
 * OpenRouter), and on 2026-11-11/12 the platform's default model
 * (`nvidia/nemotron-3.5-super-vl:free`) spent all of it reasoning on 47 of 67
 * reviews: empty reply, "The reviewer produced no readable output." posted.
 */
export const PR_REVIEW_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Model calls one review may make: the first, and one retry when it gave no
 * usable answer (no text, or text cut off at the output limit) or refused
 * the output budget as larger than the model allows.
 */
export const PR_REVIEW_MAX_ATTEMPTS = 2;

/**
 * Bound on the retry after an unusable reply: it is skipped when the first
 * reply took longer than this, and abandoned when it has not answered within
 * this long. The REST route and the chat tool wait for the review, so a slow
 * model must not make them wait for two full 16k-token answers.
 */
export const PR_REVIEW_RETRY_WINDOW_MS = 180_000;

/** One review request — from the webhook bridge, chat tool, or API. */
export interface PrReviewRequest {
    /** Platform user the review runs AS (facade auth + ingest owner). */
    userId: string;
    /** Repository owner login. */
    owner: string;
    /** Repository name. */
    repo: string;
    /** Pull request number. */
    prNumber: number;
    /**
     * Optional reviewer instruction — the mention loop passes the
     * `@ever-works` comment text here. UNTRUSTED external text: the
     * prompt marks it as data, and it is length-capped.
     */
    instruction?: string;
    /** Pre-resolved Work id (skips repo→Work matching when provided). */
    workId?: string;
    /** Git provider plugin id (default `github`). */
    providerId?: string;
    /**
     * How far the pull request's AUTHOR is trusted, when the caller knows
     * (security finding F2). The review is posted as a PUBLIC comment on the
     * pull request, so its prompt must not carry the owner's private context
     * when somebody outside the repository controls the title, body and diff
     * it is built from.
     *
     *  - `untrusted` — no knowledge-base context and no memory recall; the
     *    review is grounded in the diff alone. The webhook bridge sets this
     *    for an author who is not an OWNER, MEMBER or COLLABORATOR (or a pull
     *    request from a fork).
     *  - `trusted` — the PR title may seed the KB / memory query.
     *  - absent — callers that do not know (the chat tool, the REST
     *    endpoint): private context is still included unless the fetched
     *    pull request's head lives in ANOTHER repository, and the query is
     *    built from the Work and the instruction, never from PR text.
     */
    prAuthorTrust?: 'trusted' | 'untrusted';
    /**
     * Post a fixed one-line note on the pull request when the AI step gives
     * no review (a provider error, or no usable answer), so the person who
     * asked sees the request was heard. The webhook bridge sets it for an
     * `@ever-works` mention; the REST route and the chat tool read the
     * result instead. The note carries no model or provider text.
     */
    noteFailureOnPr?: boolean;
}

/** One structured per-file review note. */
export interface PrReviewFileComment {
    path: string;
    comment: string;
}

/** Parsed structured review (post-cap). */
export interface PrStructuredReview {
    summary: string;
    comments: PrReviewFileComment[];
}

/** Outcome of a review run. */
export interface PrReviewResult {
    /**
     * - `posted`  — review generated AND the summary comment landed on
     *               the PR.
     * - `failed`  — the loop could not complete (PR missing, AI error, no
     *               usable answer from the model — nothing is posted then —
     *               or comment post rejected). `error` says why; partial
     *               fields (summary) are still populated when available.
     */
    status: 'posted' | 'failed';
    owner: string;
    repo: string;
    prNumber: number;
    /** Matched Work id, when repo→Work resolution succeeded. */
    workId?: string;
    summary: string;
    comments: PrReviewFileComment[];
    /** Provider id of the posted summary comment, when posted. */
    commentId?: number;
    /** Web URL of the reviewed pull request. */
    prUrl?: string;
    /** Which context blocks made it into the prompt (observability). */
    context: {
        work: boolean;
        kb: boolean;
        memory: boolean;
        /**
         * Present (`true`) when the knowledge base and memory recall were
         * deliberately left out because the pull request's author is not
         * trusted — see {@link PrReviewRequest.prAuthorTrust}.
         */
        privateContextWithheld?: true;
    };
    error?: string;
}
