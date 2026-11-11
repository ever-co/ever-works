/**
 * The text a pull request gets from the agent run that produced it.
 *
 * An agent run ends with a final message (the run summary the app shows). The
 * platform opens the pull request for the branch that run pushed, so the
 * summary is the best description of the change there is: what was wrong, what
 * changed, how it was verified, what could not be run. This module turns that
 * summary into a pull request TITLE and BODY.
 *
 * It is security-relevant. The summary is MODEL-AUTHORED text (and a model can
 * be steered by a repository file, an issue or a review comment it read), and
 * the platform posts it to the git provider under the OWNER's identity. Left
 * as written it could notify real people and teams (`@name`, `@org/team`),
 * close or cross-link issues (`fixes #12`, an issue URL), load a remote image
 * when someone opens the pull request (a channel that carries data out in the
 * URL), hide text from a human reviewer that a review bot still reads
 * (`<!-- … -->`), or switch CI off on the merge commit (`[skip ci]`). Every
 * function here is pure and dependency-free, so the platform (title and body),
 * the planner (the contract it teaches) and the node (the commit subject) share
 * one rule set.
 *
 * What the body sanitizer does, in order:
 *
 *  0. The input is BOUNDED, then CREDENTIALS are redacted
 *     ({@link redactRunSummarySecrets}: the platform's shared secret patterns,
 *     credentials in URLs, `Authorization` values, credential-named values).
 *  1. FENCED CODE BLOCKS are found with CommonMark's own rules and written back
 *     in a canonical form: a fence at column 0, longer than any backtick run
 *     inside it, always closed, with blank lines around it. Their content is
 *     kept byte-for-byte. Writing the fence ourselves is what makes "this is
 *     code" true for the provider's renderer as well as for this parser: an
 *     unterminated or oddly indented fence cannot leave the two disagreeing
 *     about where code ends.
 *  2. INLINE CODE is recognised only as a backtick run closed by a run of the
 *     same length in the same line and the same table cell, and every backtick
 *     run that is not closed that way is escaped. So a span can never pair
 *     across lines or cells in a way this parser did not see. Its content is
 *     kept byte-for-byte (`pnpm --filter @scope/pkg test` stays copyable).
 *  3. Everything else is PROSE and is neutralised without looking at context:
 *     invisible format characters removed, character references shown as
 *     written, HTML comments and tags removed and any other tag opener escaped,
 *     images reduced to their alternative text, a line that is only an
 *     attachment URL the provider would embed shown as code. Then, MATCHED ON
 *     THE TEXT WITH MARKDOWN ESCAPES DECODED (what a renderer reads) and
 *     applied to the text: every `@`, every `#<digit>` and `GH-<digit>`
 *     followed by a zero-width space, issue / pull request / discussion links
 *     to the provider broken unless they are the Task's own pull request,
 *     script-like link schemes broken.
 *  4. The whole result is capped, with code blocks cut at a line and closed,
 *     and, everywhere (a squash merge can copy a description into a commit
 *     message, where code is plain text): CI-skip directives neutralised,
 *     `BREAKING CHANGE` notes broken, and the reference after a closing
 *     keyword (`fixes #12`) broken.
 *
 * Known limits, stated rather than hidden: the provider rules target GitHub
 * (`#12`, `GH-12`, `github.com/…/issues|pull|discussions/…`); a mention or a
 * bare reference INSIDE code is left as written, because a renderer does not
 * act on code (a closing keyword's reference is broken there too, see 4).
 * Shell metacharacters in a title are kept: a title is text, and a tool that
 * pastes it into a shell unquoted is broken for any title.
 */

import { composeFleetTaskCommitMessage, neutralizeCiSkipDirectives } from '../fleet/fleet-commit-message.types.js';
import { redactSecrets } from '../secret/secret-patterns.js';

/** The marker a run's final message ends with to name its pull request. */
export const RUN_PULL_REQUEST_TITLE_MARKER = 'PR-TITLE:';

/** Longest title kept; a longer one is cut at a word boundary. */
export const RUN_PULL_REQUEST_TITLE_MAX_LENGTH = 72;

/**
 * A marker line longer than this is not a title at all (a paragraph that
 * happens to start with the marker), so nothing is taken from it.
 */
export const RUN_PULL_REQUEST_TITLE_MAX_LINE_LENGTH = 240;

/** Longest sanitized run summary a pull request body carries, in characters. */
export const RUN_PULL_REQUEST_BODY_MAX_LENGTH = 6000;

/** Appended when a summary was cut to {@link RUN_PULL_REQUEST_BODY_MAX_LENGTH}. */
export const RUN_PULL_REQUEST_BODY_TRUNCATED_NOTE = '_(summary shortened)_';

const ZWSP = '\u200b';

/** C0 / C1 control characters and DEL, except tab and line feed. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/** Every control character and line break: a title is one line. */
// eslint-disable-next-line no-control-regex
const ALL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
/** Invisible format characters: zero-width spaces and joiners, bidi controls, BOM, soft hyphen. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;
/** Bidirectional overrides and isolates: never legitimate in a pull request, code included. */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Half of a surrogate pair on its own: not a character, and not valid to send. */
const LONE_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** Line breaks other than `\n` a renderer may honour. */
const OTHER_LINE_BREAKS = /\r\n?|[\u0085\u2028\u2029\v\f]/g;

/**
 * The exact marker line: optional indentation (at most three spaces, so it is
 * never an indented code line), the marker, at least one space or tab, the
 * title. Case-sensitive. Emphasis or code characters around the marker are
 * tolerated because models add them; they are stripped with the rest of the
 * Markdown.
 */
const TITLE_LINE = /^ {0,3}[*_`]{0,3}PR-TITLE:[*_`]{0,3}[ \t]+(\S.*)$/;

/**
 * How much of the END of a summary {@link parseRunPullRequestTitle} reads: a
 * marker line longer than {@link RUN_PULL_REQUEST_TITLE_MAX_LINE_LENGTH} is
 * refused anyway, so a window a few times that size always holds a usable one.
 */
const TITLE_SCAN_WINDOW = RUN_PULL_REQUEST_TITLE_MAX_LINE_LENGTH * 4;

/** A Task slug fit to print in a title (`T-2286`): a plain token, nothing a provider acts on. */
const RUN_PULL_REQUEST_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export interface ParsedRunPullRequestTitle {
	/** The cleaned title, or `null` when the summary does not end with a usable marker line. */
	title: string | null;
	/** The summary without the marker line (unchanged when no title was taken). */
	summary: string;
}

/**
 * Read the pull request title a run named, and the summary without that line.
 *
 * Strict on purpose: only the LAST non-empty line counts, in the exact form
 * `PR-TITLE: <text>`. A summary that does not end that way has no title, and
 * the caller keeps the title it had. The marker line is removed from the
 * summary only when its title was accepted, so a line that turned out not to
 * be a title is never silently lost from the description.
 */
export function parseRunPullRequestTitle(summary: string | null | undefined): ParsedRunPullRequestTitle {
	if (typeof summary !== 'string' || !summary) return { title: null, summary: '' };
	// Bounded before any pattern runs: only the last line can be the marker,
	// so only a window at the END of the text is read. A summary of any size
	// costs one native `trimEnd` and a fixed-size scan.
	const trimmed = summary.trimEnd();
	if (!trimmed) return { title: null, summary };
	const windowStart = Math.max(0, trimmed.length - TITLE_SCAN_WINDOW);
	const window = trimmed.slice(windowStart).replace(OTHER_LINE_BREAKS, '\n');
	const lineBreak = window.lastIndexOf('\n');
	// No line break inside the window: the last line is longer than any title line.
	if (lineBreak === -1 && windowStart > 0) return { title: null, summary };
	const line = window.slice(lineBreak + 1);
	if (line.length > RUN_PULL_REQUEST_TITLE_MAX_LINE_LENGTH) return { title: null, summary };
	const match = TITLE_LINE.exec(line);
	if (!match) return { title: null, summary };
	const title = sanitizeRunPullRequestTitle(match[1]);
	if (!title) return { title: null, summary };
	const head = `${trimmed.slice(0, windowStart)}${lineBreak === -1 ? '' : window.slice(0, lineBreak)}`;
	return { title, summary: head.trimEnd() };
}

/**
 * The pull request TITLE an agent run's summary names, as a conventional
 * commit: `fix: salary filter drops zero-minimum jobs [T-2286]`, or `null`
 * when the summary names none (the caller then keeps the title it had).
 *
 * The type is the one the run wrote (`PR-TITLE: docs(api): …`) when it is a
 * conventional-commit type, else read from the title's first words exactly
 * as a fleet commit subject is ({@link composeFleetTaskCommitMessage}), so the
 * pull request and the commit it carries say the same thing. The Task slug
 * follows in brackets, so a pull request list maps every entry to its Task
 * without opening it; a slug that is not a plain token is left out.
 */
export function composeRunPullRequestTitle(input: {
	summary: string | null | undefined;
	slug?: string | null;
}): string | null {
	const subject = runTitleSubject(input.summary);
	if (!subject) return null;
	const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
	return RUN_PULL_REQUEST_SLUG.test(slug) ? `${subject} [${slug}]` : subject;
}

/**
 * The conventional subject a run's `PR-TITLE:` line names, or `null`. An agent
 * never declares a breaking change on its own: a `!` it wrote after the type
 * (`feat!:`, `fix(api)!:`) is dropped, because release tooling reads it as a
 * major version bump.
 */
function runTitleSubject(summary: string | null | undefined): string | null {
	const { title } = parseRunPullRequestTitle(summary);
	if (!title) return null;
	const subject = composeFleetTaskCommitMessage({ title, slug: null });
	if (!subject || subject.includes('\n')) return null;
	// Once more on what is left: composing can still change case or join text
	// (review of #3145), and this is what the provider and `git` receive.
	return redactRunSummarySecrets(subject.replace(BREAKING_CHANGE_BANG, '$1:'));
}

/** `feat!:` / `fix(api)!:` — the conventional-commit breaking-change marker. */
const BREAKING_CHANGE_BANG = /^([a-z]+(?:\([^)\n]{1,40}\))?)!:/;

/**
 * The longest run summary any pull-request rule reads. Past it, only the head
 * (what a body can show) and the LAST line (where `PR-TITLE:` is) are kept,
 * so secret redaction and the private-text guard never run over the 256 KiB a
 * node may report.
 */
export const RUN_PULL_REQUEST_SUMMARY_MAX_INPUT_LENGTH = 32_000;

/**
 * A run summary bounded for the pull-request rules: unchanged up to
 * {@link RUN_PULL_REQUEST_SUMMARY_MAX_INPUT_LENGTH}; longer, its head (as much
 * as the body sanitizer ever reads) and its last line. Linear: one slice at
 * each end, no pattern over the whole text.
 */
export function boundRunPullRequestSummary(summary: string | null | undefined): string {
	if (typeof summary !== 'string') return '';
	if (summary.length <= RUN_PULL_REQUEST_SUMMARY_MAX_INPUT_LENGTH) return summary;
	const trimmed = summary.trimEnd();
	const windowStart = Math.max(0, trimmed.length - TITLE_SCAN_WINDOW);
	const window = trimmed.slice(windowStart).replace(OTHER_LINE_BREAKS, '\n');
	const lineBreak = window.lastIndexOf('\n');
	const lastLine = lineBreak === -1 ? '' : window.slice(lineBreak + 1);
	const head = sliceCodePoints(summary, RUN_PULL_REQUEST_BODY_MAX_LENGTH * 4);
	return lastLine ? `${head}\n\n${lastLine}` : head;
}

/** `\X` where X is ASCII punctuation: what CommonMark reads as the literal X. */
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/g;
/** `scheme://userinfo@` — credentials written into a URL. Bounded on both sides. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{1,15}:\/\/)([^\s/?#@]{1,256})@/gi;
/** An `Authorization` header or setting with its value. */
const AUTHORIZATION_VALUE =
	/\b(authorization[ \t]*[:=][ \t]*["']?(?:(?:basic|bearer|token|digest)[ \t]+)?)[A-Za-z0-9._~+/=-]{8,}/gi;
/** `NAME=value` / `name: value`, the name bounded so a long word costs nothing. */
const NAMED_VALUE = /\b([A-Za-z][A-Za-z0-9_.-]{0,63})([ \t]*[:=][ \t]*["']?)([^\s"'`]{8,})/g;
/** Names whose value is a credential: `GITHUB_TOKEN`, `aws_secret_access_key`, `db.password` … */
const SECRET_NAME = /(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)$/i;

/**
 * Credentials taken out of a run summary before any of it is posted to the
 * provider (pull request title, body, commit subject) or read back into a
 * prompt. A summary is model-authored, and a model that ran with a token in
 * its environment can print it ("tested with `GITHUB_TOKEN=ghp_…`").
 *
 *  - every shape the platform's shared scanner knows (`redactSecrets`: GitHub,
 *    GitLab, Slack, npm, Hugging Face, Google, Stripe, AWS access-key ids,
 *    `sk-…` (OpenAI, Anthropic), `Bearer …`, JWTs, PEM private keys);
 *  - the same shapes split by Markdown escapes (`ghp\_…` renders as `ghp_…`);
 *  - credentials in a URL (`https://user:pass@host`, `https://<token>@host`);
 *  - an `Authorization` value of any scheme (`Basic …` included);
 *  - the value of anything NAMED like a credential (`AWS_SECRET_ACCESS_KEY=…`,
 *    `password: …`) when it looks like one: at least 8 characters, with a
 *    digit or at least 20 long, so `token: string` and `api_key: process.env.X`
 *    stay readable.
 *
 * Callers bound the input first ({@link boundRunPullRequestSummary}); every
 * pattern here is linear on it.
 */
export function redactRunSummarySecrets(text: string | null | undefined): string {
	if (typeof text !== 'string' || !text) return '';
	// No pattern below matches fewer characters; tiny pieces (a word between
	// two code spans) cost nothing.
	if (text.length < 8) return text;
	let out = redactSecrets(text).cleaned;
	// A secret split by Markdown is the secret once RENDERED: by escapes
	// (`ghp\_…`), or by emphasis or a code span in the middle (`ghp_A1**b2**C3`
	// reads `ghp_A1b2C3`). Each view is tried in turn, and only when it reveals
	// one is it used: that Markdown is lost then, which is acceptable for text
	// that was hiding a credential behind it.
	const decoded = out.replace(MARKDOWN_ESCAPE, '$1');
	for (const view of [decoded, decoded.replace(RENDERED_AWAY, '')]) {
		if (view === out) continue;
		const again = redactSecrets(view);
		if (again.redactions > 0) {
			out = again.cleaned;
			break;
		}
	}
	out = out.replace(URL_USERINFO, (match, scheme: string, userinfo: string) =>
		userinfo.includes(':') || userinfo.length >= 16 ? `${scheme}[redacted secret]@` : match
	);
	out = out.replace(AUTHORIZATION_VALUE, '$1[redacted secret]');
	out = out.replace(NAMED_VALUE, (match, name: string, separator: string, value: string) => {
		// Punctuation that ends a statement is not part of the value
		// (`api_key: process.env.API_KEY,`); punctuation inside it is.
		const trimmed = value.replace(/[,;)]+$/, '');
		return SECRET_NAME.test(name) &&
			!trimmed.startsWith('[redacted') &&
			trimmed.length >= 8 &&
			(/\d/.test(trimmed) || trimmed.length >= 20)
			? `${name}${separator}[redacted secret]${value.slice(trimmed.length)}`
			: match;
	});
	return out;
}

/** Markdown a renderer shows as nothing between two halves of a word: emphasis and code-span marks. */
const RENDERED_AWAY = /[*~`]/g;

/** A private-use stand-in for the zero-width spaces this module inserts (see below). */
const ZWSP_STAND_IN = '';

/**
 * {@link redactRunSummarySecrets} for text this module has ALREADY neutralised.
 * The shared scanner's evasion fallback answers the whole text normalised, with
 * every zero-width space removed — which would put back each `@mention` and
 * `#12` the rules broke. So the zero-width spaces are swapped for a private-use
 * character (which neither NFKC nor the format-character strip touches) for
 * the scan, and swapped back. A token can only have been split by one of them
 * inside code, where the first, full pass over the raw text already saw it.
 */
function redactNeutralizedText(text: string): string {
	if (text.length < 8) return text;
	if (!text.includes(ZWSP)) return redactRunSummarySecrets(text);
	return redactRunSummarySecrets(text.split(ZWSP).join(ZWSP_STAND_IN)).split(ZWSP_STAND_IN).join(ZWSP);
}

/** Fewest consecutive words of private planning text that count as a quote. */
export const RUN_SUMMARY_PRIVATE_QUOTE_MIN_WORDS = 8;
const QUOTE_WORD = /[\p{L}\p{N}]+/gu;
/** How much of one private source is read, and how many word runs are kept. */
const PRIVATE_SOURCE_MAX_CHARS = 20_000;
const PRIVATE_RUNS_MAX = 100_000;

/**
 * A run summary without the sentences that quote private planning text.
 *
 * A fleet run is told WHY its Task exists (`# RUN CONTEXT`: the Mission and
 * Goal descriptions and the Goal's Definition of Done, written by the members
 * of an organisation), and its summary becomes a pull request description,
 * which is often public. The prompt asks the model not to quote that context;
 * this is the mechanical half: any sentence (or, for a quote that crosses a
 * sentence or a line, every sentence it touches) containing a run of
 * {@link RUN_SUMMARY_PRIVATE_QUOTE_MIN_WORDS} or more consecutive words of any
 * source, compared case-insensitively on letters and digits only, is dropped.
 * A line left empty is dropped with its line break. Bounded: each source is
 * read up to 20,000 characters; callers bound the summary.
 */
export function dropQuotedPrivateText(
	summary: string | null | undefined,
	privateTexts: ReadonlyArray<string | null | undefined> | null | undefined,
	options: { minWords?: number } = {}
): { text: string; dropped: number } {
	if (typeof summary !== 'string' || !summary) return { text: '', dropped: 0 };
	const size = clampInt(options.minWords, 4, 64, RUN_SUMMARY_PRIVATE_QUOTE_MIN_WORDS);
	const runs = new Set<string>();
	for (const source of privateTexts ?? []) {
		if (typeof source !== 'string' || !source) continue;
		const words = sliceCodePoints(source, PRIVATE_SOURCE_MAX_CHARS).toLowerCase().match(QUOTE_WORD) ?? [];
		for (let index = 0; index + size <= words.length && runs.size < PRIVATE_RUNS_MAX; index += 1) {
			runs.add(words.slice(index, index + size).join(' '));
		}
	}
	if (runs.size === 0) return { text: summary, dropped: 0 };

	const text = summary.replace(OTHER_LINE_BREAKS, '\n');
	const words: Array<{ word: string; start: number; end: number }> = [];
	for (const match of text.matchAll(QUOTE_WORD)) {
		words.push({ word: match[0].toLowerCase(), start: match.index!, end: match.index! + match[0].length });
	}
	const quoted: Array<[number, number]> = [];
	for (let index = 0; index + size <= words.length; index += 1) {
		const key = words
			.slice(index, index + size)
			.map((entry) => entry.word)
			.join(' ');
		if (runs.has(key)) quoted.push([words[index]!.start, words[index + size - 1]!.end]);
	}
	if (quoted.length === 0) return { text: summary, dropped: 0 };

	// Sentences and lines, in order; a segment keeps its trailing separator.
	const segments: Array<{ start: number; end: number; drop: boolean }> = [];
	let segmentStart = 0;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]!;
		if (char === '\n') {
			segments.push({ start: segmentStart, end: index + 1, drop: false });
			segmentStart = index + 1;
		} else if ((char === '.' || char === '!' || char === '?') && /[ \t]/.test(text[index + 1] ?? '')) {
			let end = index + 1;
			while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end += 1;
			segments.push({ start: segmentStart, end, drop: false });
			segmentStart = end;
			index = end - 1;
		}
	}
	if (segmentStart < text.length) segments.push({ start: segmentStart, end: text.length, drop: false });

	// Both lists are ordered (quotes span the same number of words), so one forward pass marks them.
	let first = 0;
	for (const [start, end] of quoted) {
		while (first < segments.length && segments[first]!.end <= start) first += 1;
		for (let index = first; index < segments.length && segments[index]!.start < end; index += 1) {
			segments[index]!.drop = true;
		}
	}
	let out = '';
	let dropped = 0;
	for (const segment of segments) {
		if (!segment.drop) {
			out += text.slice(segment.start, segment.end);
			continue;
		}
		dropped += 1;
		// Keep the line break of a line that still has something on it.
		if (text[segment.end - 1] === '\n' && out !== '' && !out.endsWith('\n')) out = `${out.trimEnd()}\n`;
	}
	return { text: out, dropped };
}

/**
 * One line of plain text fit for a pull request title AND a commit subject, or
 * `null` when nothing usable is left.
 *
 * A title is not rendered as Markdown, but it is still read by the provider:
 * `#12` is cross-linked, and the same text becomes a commit subject, where
 * `fixes #12` closes an issue on merge and `[skip ci]` switches CI off. A
 * commit subject is also read in terminals, so nothing invisible is added
 * here: the characters that would act are REMOVED, not padded.
 *
 *  - control and invisible format characters;
 *  - HTML comments and tags;
 *  - Markdown images, links (the text is kept), emphasis, code and heading marks;
 *  - `@` in front of a name (`@octocat` becomes `octocat`);
 *  - `#` in front of a number (`#12` becomes `12`, `owner/repo#12` becomes
 *    `owner/repo 12`) and the `GH-12` spelling of the same reference;
 *  - the scheme of a URL (so no link, and no issue URL a keyword could act on);
 *  - CI-skip directives (`[skip ci]` becomes `(skip ci)`).
 *
 * Longer than {@link RUN_PULL_REQUEST_TITLE_MAX_LENGTH} is cut at a word
 * boundary. A result with no letter or digit, or shorter than three
 * characters, is not a title.
 */
export function sanitizeRunPullRequestTitle(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	if (value.length > RUN_PULL_REQUEST_TITLE_MAX_LINE_LENGTH) return null;
	const text = cleanTitleText(value);
	return isUsableTitle(text) ? cutAtWord(text, RUN_PULL_REQUEST_TITLE_MAX_LENGTH) : null;
}

/**
 * One line that says what a run changed, for a LIST of runs (the planner's
 * "work in flight" section): the title the run named when it named one, else
 * the first sentence of its summary, cleaned the way a title is and cut to
 * `maxLength`. `null` when the summary says nothing usable.
 */
export function summarizeRunChangeInOneLine(summary: string | null | undefined, maxLength = 160): string | null {
	if (typeof summary !== 'string' || !summary.trim()) return null;
	const limit = clampInt(maxLength, 16, 1000, 160);
	const parsed = parseRunPullRequestTitle(summary);
	// Redacted on what is returned (the cleaned text), before the cut, so the
	// line read back into the next run's prompt never carries a credential that
	// a deletion pass rejoined (review of #3145).
	if (parsed.title) return cutAtWord(redactRunSummarySecrets(parsed.title), limit);
	// Bounded before any pattern runs: a first sentence is never past this.
	const lines = sliceCodePoints(summary, 4000).replace(OTHER_LINE_BREAKS, '\n').split('\n');
	let fallback: string | null = null;
	for (const raw of lines) {
		const line = raw.trim();
		// Too short to ever be a usable line (cleaning never adds text but a
		// redaction placeholder, and a credential is longer than this).
		if (line.length < 3) continue;
		// A rule, a fence or a heading names a section; it does not say what changed.
		if (/^(?:[-=*_~`]{3,}|#{1,6}(?:\s|$))/.test(line)) continue;
		const text = sliceCodePoints(line.replace(/^(?:[-*+]|\d{1,3}[.)])[ \t]+/, ''), 400);
		const sentence = /^(.{1,400}?[.!?])(?:\s|$)/.exec(text);
		const cleaned = cleanTitleText(sentence ? sentence[1]! : text);
		if (!isUsableTitle(cleaned)) continue;
		// A bare label (`Summary:`, `Done.`) is kept only if nothing better follows.
		if (cleaned.split(' ').length >= 3) return cutAtWord(redactRunSummarySecrets(cleaned), limit);
		fallback ??= cleaned;
	}
	return fallback ? cutAtWord(redactRunSummarySecrets(fallback), limit) : null;
}

export interface SanitizeRunPullRequestBodyOptions {
	/** Cap on the result, in characters. Default {@link RUN_PULL_REQUEST_BODY_MAX_LENGTH}. */
	maxLength?: number;
	/**
	 * Pull request URLs that may stay live links: the Task's OWN pull requests
	 * (a multi-repository Task's primary one, seen from another repository).
	 * Every other issue, pull request or discussion link to the provider is
	 * broken.
	 */
	allowedUrls?: ReadonlyArray<string | null | undefined>;
}

/**
 * A run summary made safe to post as (part of) a pull request description.
 * See the module comment for the rules. Never throws; a non-string is `''`.
 */
export function sanitizeRunPullRequestBody(
	summary: string | null | undefined,
	options: SanitizeRunPullRequestBodyOptions = {}
): string {
	if (typeof summary !== 'string' || !summary) return '';
	const maxLength = clampInt(options.maxLength, 200, 60_000, RUN_PULL_REQUEST_BODY_MAX_LENGTH);
	const allowed = new Set<string>();
	for (const url of options.allowedUrls ?? []) {
		const key = providerReferenceKey(typeof url === 'string' ? url : '');
		if (key) allowed.add(key);
	}
	// Bounded before any pattern runs: nothing past this can survive the cap,
	// and one very long line must not become the cost of the whole pass.
	// Credentials go first, before anything else could split or hide one.
	const bounded = redactRunSummarySecrets(
		sliceCodePoints(summary, maxLength * 4)
			.replace(OTHER_LINE_BREAKS, '\n')
			.replace(CONTROL_CHARACTERS, '')
			.replace(BIDI_CONTROLS, '')
			.replace(LONE_SURROGATES, '')
	);
	// Sanitized only until the result is certainly past the cap: what follows
	// would be cut by `fitBlocks` anyway. Counted in UTF-16 units, so the stop
	// is past `2 * maxLength` units, which is past `maxLength` characters, and
	// the cut (and its note) still happens exactly as if everything were read.
	const budget = maxLength * 2 + 2;
	const blocks: Array<ProseBlock | CodeBlock> = [];
	let produced = 0;
	for (const block of splitFencedBlocks(bounded)) {
		if (produced > budget) break;
		if (block.kind === 'code') {
			const lines = block.lines.map(neutralizeForCommitMessage);
			blocks.push({ ...block, lines });
			for (const line of lines) produced += line.length + 1;
			continue;
		}
		// Redacted AGAIN after the passes that delete characters (format
		// characters, comments, tags, images): `ghp_A1<!-- -->B2…` is the token
		// once the comment is gone (review of #3145). Before the cap, so a
		// redaction cannot push the result past it.
		const text = redactNeutralizedText(
			neutralizeForCommitMessage(sanitizeProse(block.text, allowed, budget - produced))
		);
		blocks.push({ kind: 'prose', text });
		produced += text.length + 2;
	}
	// CI-skip directives last, over everything: that rule never lengthens the
	// text, so it cannot push the result past the cap `fitBlocks` applied.
	// And once more on the FINAL text, everything included, as the last step.
	return redactNeutralizedText(neutralizeCiSkipDirectives(fitBlocks(blocks, maxLength))).trim();
}

/**
 * The rules that hold in CODE too, applied per block BEFORE the cap (they add
 * zero-width spaces): a squash merge can copy the description into the commit
 * message, where code is plain text that the provider's closing keywords and
 * release tooling read. Both rules are line-local.
 */
function neutralizeForCommitMessage(text: string): string {
	return neutralizeClosingKeywordReferences(neutralizeBreakingChangeNotes(text));
}

/** `BREAKING CHANGE:` / `BREAKING-CHANGE:` — the footer that makes release tooling cut a major version. */
const BREAKING_CHANGE_NOTE = /\bBREAKING(?=[ \t_-]{1,4}CHANGES?\b)/gi;

/**
 * An agent never declares a breaking change on its own: the word `BREAKING`
 * before `CHANGE` gets a zero-width space, so no conventional-commit parser
 * reads a `BREAKING CHANGE` note from text a squash merge copied. A reader
 * sees the same words.
 */
function neutralizeBreakingChangeNotes(text: string): string {
	return text.replace(BREAKING_CHANGE_NOTE, (word) => `${word}${ZWSP}`);
}

/**
 * A closing keyword and the reference right after it (`fixes #12`,
 * `Closes: owner/repo#3`, `resolves GH-4`, `fixed https://github.com/o/r/issues/5`):
 * the provider closes that issue when a commit carrying the text lands. In
 * prose every reference is already broken; this reaches the ones in CODE,
 * which a squash merge turns into plain commit-message text. Every quantifier
 * is bounded, so the scan is linear.
 */
const CLOSING_KEYWORD_REFERENCE =
	/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)([ \t]{0,8}:?[ \t]{0,8})((?:[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})?[#＃]|GH-|(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/(?:issues|pulls?)\/)(?=[0-9])/gi;

function neutralizeClosingKeywordReferences(text: string): string {
	return text.replace(CLOSING_KEYWORD_REFERENCE, `$1$2$3${ZWSP}`);
}

/**
 * The commit message a run commits with when it named its change: the planned
 * message with its subject replaced by a conventional commit built from the
 * run's `PR-TITLE:` line. The body and every trailer of the planned message
 * are kept byte-for-byte. Unchanged when the summary names no title.
 */
export function applyRunPullRequestTitleToCommitMessage(message: string, summary: string | null | undefined): string {
	if (typeof message !== 'string' || !message) return message;
	// The same title the pull request gets: credentials redacted, breaking-change
	// marker dropped, nothing a provider or CI acts on.
	const subject = runTitleSubject(boundRunPullRequestSummary(summary));
	if (!subject) return message;
	const newline = message.indexOf('\n');
	return newline === -1 ? subject : `${subject}${message.slice(newline)}`;
}

// ─── titles ─────────────────────────────────────────────────────────────

/** A tag-shaped run: `<name …>` or `</name>`. Whether it is HTML is decided by the name. */
const TAG_SHAPE = /<\/?([A-Za-z][A-Za-z0-9-]{0,24})(?=[\s/>])[^<>]{0,2000}>/g;
/**
 * Element names a renderer knows. A tag with one of these names is REMOVED (its
 * inner text stays); any other tag-shaped text (`Promise<void>`, `<T>`,
 * `<MyComponent>`) is not HTML and is kept as the text it is.
 */
const HTML_ELEMENT_NAMES = new Set(
	(
		'a abbr address applet area article aside audio b base bdi bdo big blockquote body br button canvas caption ' +
		'center cite code col colgroup data datalist dd del details dfn dialog dir div dl dt em embed fieldset ' +
		'figcaption figure font footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe ' +
		'image img input ins kbd label legend li link main map mark marquee math menu meta meter nav noscript ' +
		'object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section ' +
		'select slot small source span strike strong style sub summary sup svg table tbody td template textarea ' +
		'tfoot th thead time title tr track tt u ul var video wbr xmp'
	).split(' ')
);

function stripHtmlTags(text: string): string {
	return text.replace(TAG_SHAPE, (match, name: string) => (HTML_ELEMENT_NAMES.has(name.toLowerCase()) ? '' : match));
}
const MARKDOWN_IMAGE = /!\[([^\]\n]{0,300})\]\([^()\n]{0,2000}(?:\([^()\n]{0,500}\)[^()\n]{0,500})?\)/g;
const MARKDOWN_LINK = /\[([^\]\n]{0,300})\]\([^()\n]{0,2000}(?:\([^()\n]{0,500}\)[^()\n]{0,500})?\)/g;

/**
 * Chat-template control markers some models treat as turn delimiters
 * (`<|im_start|>`, `[INST]`, `<<SYS>>`). A one-line summary is read back into
 * the NEXT run's prompt (`# WORK IN FLIGHT`), so it carries none.
 */
const CHAT_TEMPLATE_MARKER = /\[\/?INST\]|<<\/?SYS>>|<\|[^|<>\n]{0,40}\|>/gi;

function stripChatTemplateMarkers(text: string): string {
	let current = text;
	for (let pass = 0; pass < 8; pass += 1) {
		const next = current.replace(CHAT_TEMPLATE_MARKER, '');
		if (next === current) break;
		current = next;
	}
	// Still nested after eight passes: no opener or closer is left whole.
	return current.replace(/<\||\|>/g, '').replace(/\[\/?INST\]/gi, '');
}

/** Plain single-line text, with everything a title or a commit subject would act on removed. */
function cleanTitleText(value: string): string {
	let text = value.replace(ALL_CONTROL_CHARACTERS, ' ').replace(FORMAT_CHARACTERS, '').replace(LONE_SURROGATES, '');
	// A title is plain text: `GH\-12` and `issues\/12` mean `GH-12` and
	// `issues/12`, so the rules below see what a reader sees.
	text = text.replace(MARKDOWN_ESCAPE, '$1');
	text = redactRunSummarySecrets(stripChatTemplateMarkers(text));
	text = stripHtmlTags(stripHtmlComments(text));
	text = text.replace(MARKDOWN_IMAGE, '$1').replace(MARKDOWN_LINK, '$1');
	text = stripEmphasis(text.replace(/`+/g, ''));
	text = text.replace(/^[ \t]*#{1,6}[ \t]+/, '');
	text = text.replace(/[a-z][a-z0-9+.-]{1,15}:\/\//gi, '');
	text = text.replace(/[@\uff20\ufe6b]+(?=[\p{L}\p{N}_-])/gu, '');
	text = text.replace(/([\p{L}\p{N}])[#\uff03\ufe5f](?=\d)/gu, '$1 ').replace(/[#\uff03\ufe5f](?=\d)/g, '');
	text = text.replace(/\bGH-(?=\d)/gi, 'GH ');
	text = text.replace(/\/(issues|pulls?|discussions)\/(?=\d)/gi, '/$1 ');
	text = neutralizeCiSkipDirectives(text);
	// Wrapper characters left over from a marker written as `**PR-TITLE: …**`.
	text = text
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^[*_~ ]+/, '')
		.replace(/[*_~ ]+$/, '');
	// Once more, LAST: every pass above deletes characters (comments, tags,
	// images, backticks, emphasis, `@`, `#`, schemes), and a token split by any
	// of them is whole again here (`ghp_A1<!-- -->b2…`, `ghp_A1`b2…`).
	return redactRunSummarySecrets(text);
}

function isUsableTitle(text: string): boolean {
	return codePointLength(text) >= 3 && /[\p{L}\p{N}]/u.test(text);
}

function stripEmphasis(text: string): string {
	return text
		.replace(/(\*\*|__|~~)(?=\S)([^*_~]{1,300}?)\1/g, '$2')
		.replace(/\*(?=\S)([^*]{1,300}?)\*/g, '$1')
		.replace(/(?<![\p{L}\p{N}])_(?=\S)([^_]{1,300}?)_(?![\p{L}\p{N}])/gu, '$1');
}

// ─── fenced code blocks ─────────────────────────────────────────────────

interface ProseBlock {
	kind: 'prose';
	text: string;
}

interface CodeBlock {
	kind: 'code';
	/** The language word of the info string, when it is a plain one. */
	language: string;
	lines: string[];
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const FENCE_LANGUAGE = /^[A-Za-z0-9_+#.-]{1,32}$/;

/**
 * Split into prose and fenced code by CommonMark's rules: an opening fence is
 * three or more backticks or tildes indented at most three spaces (a backtick
 * fence's info string may not contain a backtick); it closes at a fence of the
 * same character, at least as long, with nothing after it; left unclosed it
 * runs to the end of the text.
 */
function splitFencedBlocks(text: string): Array<ProseBlock | CodeBlock> {
	const blocks: Array<ProseBlock | CodeBlock> = [];
	let prose: string[] = [];
	let code: CodeBlock | null = null;
	let fence: { char: string; length: number } | null = null;
	const flushProse = (): void => {
		if (prose.length > 0) blocks.push({ kind: 'prose', text: prose.join('\n') });
		prose = [];
	};
	for (const line of text.split('\n')) {
		if (code && fence) {
			const close = FENCE_CLOSE.exec(line);
			if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) {
				blocks.push(code);
				code = null;
				fence = null;
			} else {
				code.lines.push(line);
			}
			continue;
		}
		const open = FENCE_OPEN.exec(line);
		if (open && (open[1]![0] === '~' || !open[2]!.includes('`'))) {
			flushProse();
			const word = open[2]!.trim().split(/\s+/)[0] ?? '';
			code = { kind: 'code', language: FENCE_LANGUAGE.test(word) ? word : '', lines: [] };
			fence = { char: open[1]![0]!, length: open[1]!.length };
			continue;
		}
		prose.push(line);
	}
	if (code) blocks.push(code);
	flushProse();
	return blocks;
}

function longestBacktickRun(line: string): number {
	let longest = 0;
	for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	return longest;
}

/** A code block in canonical form: a fence longer than any backtick run inside it. */
function renderCodeBlock(block: CodeBlock): string {
	let longest = 0;
	for (const line of block.lines) longest = Math.max(longest, longestBacktickRun(line));
	const fence = '`'.repeat(Math.max(3, longest + 1));
	return [`${fence}${block.language}`, ...block.lines, fence].join('\n');
}

// ─── prose ──────────────────────────────────────────────────────────────

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
/** A character reference: named, decimal or hexadecimal. */
const CHARACTER_REFERENCE = /&(?=(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});)/g;
/** An autolink in angle brackets, kept as its bare URL. */
const ANGLE_AUTOLINK = /<(https?:\/\/[^\s<>]{1,2000})>/g;
/** Link schemes a renderer may execute or resolve locally. */
const SCRIPT_SCHEME = /\b(javascript|vbscript|data|file|blob)([ \t]*):/gi;
/**
 * A path to an issue, pull request or discussion: it files a cross-reference
 * on the target, and after a closing keyword it closes it. The provider links
 * the PATH on its own, not only the full URL (`/issues/12` and
 * `owner/repo/issues/12` are references inside that repository; measured
 * against the provider's renderer), so the number is what gets separated.
 * Group 1 is the full-URL prefix when there is one: scheme, host, repository.
 */
const PROVIDER_REFERENCE_PATH =
	/((https?:\/\/)?(?:www\.)?(github\.com\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}))?\/(issues|pull|pulls|discussions)\/([0-9]{1,10})/gi;

/**
 * A line that is only a provider attachment URL (`github.com/user-attachments/…`,
 * `user-images.githubusercontent.com/…`), optionally as a list item or a quote:
 * the provider EMBEDS it (an image or a video player), so it is shown as code.
 */
const ATTACHMENT_LINE =
	/^([ \t]{0,3}(?:[-*+>][ \t]{1,4})?)<?((?:https?:\/\/)?(?:github\.com\/user-attachments\/|(?:private-)?user-images\.githubusercontent\.com\/)[^\s<>`]{1,2000})>?[ \t]*$/i;

/** Line by line, stopping once more than `budget` UTF-16 units have been written. */
function sanitizeProse(text: string, allowed: ReadonlySet<string>, budget: number): string {
	const out: string[] = [];
	let written = 0;
	for (const line of text.split('\n')) {
		if (written > budget) break;
		const attachment = ATTACHMENT_LINE.exec(line);
		const sanitized = attachment ? `${attachment[1]}\`${attachment[2]}\`` : sanitizeProseLine(line, allowed);
		out.push(sanitized);
		written += sanitized.length + 1;
	}
	return out.join('\n');
}

/**
 * One prose line. Table cells are parsed apart before inline code is, so a
 * span is only trusted inside one cell: the line is split on unescaped pipes
 * and each piece is scanned on its own. That is also right when the line is
 * not a table row: a span closed inside its piece is closed the same way when
 * the whole line is read at once, and every run that is not is escaped.
 */
function sanitizeProseLine(line: string, allowed: ReadonlySet<string>): string {
	return splitOnUnescapedPipes(line)
		.map((piece) =>
			piece === '|'
				? piece
				: splitInlineCode(piece)
						.map((segment) => (segment.code ? segment.text : sanitizeProseText(segment.text, allowed)))
						.join('')
		)
		.join('');
}

function splitOnUnescapedPipes(line: string): string[] {
	if (!line.includes('|')) return [line];
	const pieces: string[] = [];
	let current = '';
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index]!;
		if (char === '\\' && index + 1 < line.length) {
			current += char + line[index + 1]!;
			index += 1;
		} else if (char === '|') {
			pieces.push(current, '|');
			current = '';
		} else {
			current += char;
		}
	}
	pieces.push(current);
	return pieces;
}

/**
 * Inline code by the CommonMark rule, restricted to ONE piece of one line: a
 * run of N backticks opens a span that the next run of exactly N closes. A
 * backslash escapes the punctuation after it outside a span (and nothing
 * inside one). A run with no closer in the piece is written escaped, so it is
 * literal text for every reader and can never pair with a run further on.
 */
function splitInlineCode(piece: string): Array<{ code: boolean; text: string }> {
	const segments: Array<{ code: boolean; text: string }> = [];
	if (!piece.includes('`')) return piece ? [{ code: false, text: piece }] : segments;
	const closers = indexBacktickRuns(piece);
	let text = '';
	let index = 0;
	while (index < piece.length) {
		const char = piece[index]!;
		if (char === '\\' && index + 1 < piece.length && ASCII_PUNCTUATION.test(piece[index + 1]!)) {
			text += char + piece[index + 1]!;
			index += 2;
			continue;
		}
		if (char !== '`') {
			text += char;
			index += 1;
			continue;
		}
		let end = index;
		while (end < piece.length && piece[end] === '`') end += 1;
		const length = end - index;
		// The next maximal run of exactly `length` backticks starting at or
		// after `end` closes the span. `end` only grows, so each length's
		// cursor only moves forward: one pass over the piece in total, where
		// scanning ahead from every unclosed opener was O(n^1.5) on a ladder
		// of runs of every length (` `` ``` …).
		const close = closers.next(length, end);
		if (close === -1) {
			text += '\\`'.repeat(length);
			index = end;
			continue;
		}
		if (text) segments.push({ code: false, text });
		text = '';
		segments.push({ code: true, text: piece.slice(index, close + length) });
		index = close + length;
	}
	if (text) segments.push({ code: false, text });
	return segments;
}

/**
 * Every maximal backtick run of a piece, by length, with a forward-only
 * cursor per length: `next(length, from)` answers the start of the first run
 * of exactly `length` that starts at or after `from`, or `-1`.
 */
function indexBacktickRuns(piece: string): { next(length: number, from: number): number } {
	const starts = new Map<number, number[]>();
	for (let index = 0; index < piece.length; ) {
		if (piece[index] !== '`') {
			index += 1;
			continue;
		}
		let end = index;
		while (end < piece.length && piece[end] === '`') end += 1;
		const length = end - index;
		const list = starts.get(length);
		if (list) list.push(index);
		else starts.set(length, [index]);
		index = end;
	}
	const cursors = new Map<number, number>();
	return {
		next(length: number, from: number): number {
			const list = starts.get(length);
			if (!list) return -1;
			let cursor = cursors.get(length) ?? 0;
			while (cursor < list.length && list[cursor]! < from) cursor += 1;
			cursors.set(length, cursor);
			return cursor < list.length ? list[cursor]! : -1;
		}
	};
}

/**
 * The characters any rule of {@link sanitizeProseText} starts from. Text
 * without one of them has nothing to neutralise, so it skips the fourteen
 * passes: on a wall of short segments (`| \` | \` …`, a line per character)
 * those passes, not the text, were the cost.
 */
const PROSE_TRIGGER = /[&<!:/@#\-＠﹫＃﹟\p{Cf}]/u;

/** Text outside every code span: neutralised without looking at what surrounds it. */
function sanitizeProseText(value: string, allowed: ReadonlySet<string>): string {
	if (!PROSE_TRIGGER.test(value)) return value;
	let text = value.replace(FORMAT_CHARACTERS, '');
	// Shown as written: a reference is decoded AFTER the Markdown is parsed, so
	// `&#64;name` would otherwise become a live mention this pass never saw.
	text = text.replace(CHARACTER_REFERENCE, '&amp;');
	text = stripHtmlComments(text);
	text = text.replace(ANGLE_AUTOLINK, '$1');
	text = stripHtmlTags(text);
	// What is left is not an HTML element (`Promise<void>`), or is a tag or a
	// comment split across code spans or lines that never matched above. Its
	// opener is escaped, so it is shown as text and can be neither.
	text = text.replace(/<(?=[A-Za-z/!?])/g, '&lt;');
	text = text.replace(MARKDOWN_IMAGE, '$1').replace(/!\[/g, '[');
	return neutralizeOnDecodedView(text, allowed);
}

/**
 * The text as a CommonMark renderer reads it: a backslash before ASCII
 * punctuation is dropped (`GH\-12` is `GH-12`, `issues\/12` is `issues/12`,
 * `javascript\:` is `javascript:` in a link destination). `start[i]` is where
 * decoded character `i` begins in `text` — its backslash when it was escaped —
 * and `start[decoded.length]` is `text.length`. One pass, linear.
 */
function decodeMarkdownEscapes(text: string): { decoded: string; start: number[] } {
	const start: number[] = [];
	let decoded = '';
	for (let index = 0; index < text.length; ) {
		start.push(index);
		if (text[index] === '\\' && index + 1 < text.length && ASCII_PUNCTUATION.test(text[index + 1]!)) {
			decoded += text[index + 1];
			index += 2;
		} else {
			decoded += text[index];
			index += 1;
		}
	}
	start.push(text.length);
	return { decoded, start };
}

/**
 * The reference, scheme and mention rules, MATCHED on the decoded view and
 * APPLIED to the text: every match marks where a zero-width space goes, and
 * that point is mapped back through `start` (before the backslash of an
 * escaped character, so an escape can neither hide a match nor survive as a
 * stray backslash). Matching the escaped text directly let `GH\-12`,
 * `issues\/12` and `javascript\:` through, since each pattern would need its
 * own `\\?` at every punctuation mark.
 *
 *  - a script-like scheme (`javascript:`, `vbscript:`, `data:`, `file:`,
 *    `blob:`): broken before its colon;
 *  - an issue / pull request / discussion path, bare or in a full URL (the
 *    provider links the PATH on its own): broken before its number, and a
 *    full URL's scheme broken too, so no dead link is left — unless it is one
 *    of the Task's own pull requests (`allowed`);
 *  - every `@` (full-width forms included), whatever follows it;
 *  - `#` before a digit, and `GH-` before a digit.
 */
function neutralizeOnDecodedView(text: string, allowed: ReadonlySet<string>): string {
	const { decoded, start } = decodeMarkdownEscapes(text);
	const cuts = new Set<number>();
	const before = (decodedIndex: number): void => {
		cuts.add(start[decodedIndex]!);
	};
	for (const match of decoded.matchAll(SCRIPT_SCHEME)) before(match.index! + match[0].length - 1);
	for (const match of decoded.matchAll(PROVIDER_REFERENCE_PATH)) {
		const [whole, prefix, scheme, repository, kind, number] = match as unknown as [
			string,
			string | undefined,
			string | undefined,
			string | undefined,
			string,
			string
		];
		if (repository && allowed.has(`${repository}/${kind}/${number}`.toLowerCase())) continue;
		before(match.index! + whole.length - number.length);
		if (prefix && scheme) before(match.index! + scheme.indexOf(':') + 1);
	}
	for (const match of decoded.matchAll(/[@\uff20\ufe6b]/g)) before(match.index! + 1);
	for (const match of decoded.matchAll(/[#\uff03\ufe5f](?=\\?[0-9])/g)) before(match.index! + 1);
	for (const match of decoded.matchAll(/\bGH-(?=[0-9])/gi)) before(match.index! + 3);
	if (cuts.size === 0) return text;
	let out = '';
	let from = 0;
	for (const cut of [...cuts].sort((left, right) => left - right)) {
		out += `${text.slice(from, cut)}${ZWSP}`;
		from = cut;
	}
	return out + text.slice(from);
}

/** `github.com/owner/repo/pull/12`, lower-cased, for the allow-list comparison. */
function providerReferenceKey(url: string): string | null {
	const match = new RegExp(`^(?:${PROVIDER_REFERENCE_PATH.source})`, 'i').exec(url.trim());
	if (!match || !match[3]) return null;
	return `${match[3]}/${match[4]!}/${match[5]!}`.toLowerCase();
}

/** Remove `<!-- … -->`. Scanned with `indexOf`, so a long unclosed opener costs nothing. */
function stripHtmlComments(text: string): string {
	let result = '';
	let from = 0;
	for (;;) {
		const open = text.indexOf('<!--', from);
		if (open === -1) return result + text.slice(from);
		const close = text.indexOf('-->', open + 4);
		if (close === -1) return result + text.slice(from);
		result += text.slice(from, open);
		from = close + 3;
	}
}

// ─── capping ────────────────────────────────────────────────────────────

/**
 * Join the blocks inside `maxLength` characters. Prose is cut at a line or a
 * word; a code block is cut at a line and ALWAYS closed, so what follows the
 * summary (the platform's footer) can never be swallowed into code.
 */
function fitBlocks(blocks: Array<ProseBlock | CodeBlock>, maxLength: number): string {
	const rendered = blocks
		.map((block) => ({
			block,
			text: block.kind === 'code' ? renderCodeBlock(block) : block.text.replace(/^\n+|\n+$/g, '')
		}))
		.filter((entry) => entry.text.trim() !== '');
	const whole = rendered.map((entry) => entry.text).join('\n\n');
	if (codePointLength(whole) <= maxLength) return whole;

	const note = `\n\n${RUN_PULL_REQUEST_BODY_TRUNCATED_NOTE}`;
	const budget = maxLength - codePointLength(note);
	const parts: string[] = [];
	let used = 0;
	for (const { block, text } of rendered) {
		const separator = parts.length > 0 ? 2 : 0;
		const size = codePointLength(text);
		if (used + separator + size <= budget) {
			parts.push(text);
			used += separator + size;
			continue;
		}
		const room = budget - used - separator;
		if (block.kind === 'code') {
			const kept = fitCodeLines(block, room);
			if (kept.length > 0) parts.push(renderCodeBlock({ ...block, lines: kept }));
		} else if (room > 40) {
			parts.push(cutProse(text, room));
		}
		break;
	}
	return `${parts.join('\n\n')}${note}`;
}

/** The leading lines of a code block that fit `room` once it is fenced again. */
function fitCodeLines(block: CodeBlock, room: number): string[] {
	const kept: string[] = [];
	let longest = 0;
	let content = 0;
	for (const line of block.lines) {
		const nextLongest = Math.max(longest, longestBacktickRun(line));
		const nextContent = content + codePointLength(line) + 1;
		const fence = Math.max(3, nextLongest + 1);
		// Opening fence + language + line break, the lines, the closing fence.
		if (fence * 2 + block.language.length + 1 + nextContent > room) break;
		kept.push(line);
		longest = nextLongest;
		content = nextContent;
	}
	return kept;
}

function cutProse(text: string, maxLength: number): string {
	const head = sliceCodePoints(text, Math.max(0, maxLength - 1));
	const lineBreak = head.lastIndexOf('\n');
	const space = head.lastIndexOf(' ');
	const cut = lineBreak > head.length * 0.6 ? lineBreak : space > head.length * 0.6 ? space : head.length;
	return `${text.slice(0, retreatOutOfCodeSpan(text, cut)).trimEnd()}…`;
}

/**
 * A cut must not land inside an inline code span: the half left behind would
 * no longer be code, and its content was kept as written BECAUSE it was code.
 * When `cut` falls inside a span of its line, the cut moves to that span's
 * start. `text` is already sanitized, so every run in it is closed or escaped
 * and scanning the line again reproduces the same spans.
 */
function retreatOutOfCodeSpan(text: string, cut: number): number {
	const lineStart = cut > 0 ? text.lastIndexOf('\n', cut - 1) + 1 : 0;
	const lineEnd = text.indexOf('\n', lineStart);
	let offset = lineStart;
	for (const piece of splitOnUnescapedPipes(text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd))) {
		if (piece === '|') {
			offset += 1;
			continue;
		}
		for (const segment of splitInlineCode(piece)) {
			const end = offset + segment.text.length;
			if (segment.code && cut > offset && cut < end) return offset;
			offset = end;
		}
	}
	return cut;
}

function cutAtWord(text: string, maxLength: number): string {
	const points = Array.from(text);
	if (points.length <= maxLength) return text;
	const head = points.slice(0, Math.max(1, maxLength - 1)).join('');
	const space = head.lastIndexOf(' ');
	return `${(space > maxLength * 0.5 ? head.slice(0, space) : head).trimEnd()}…`;
}

function codePointLength(value: string): number {
	let count = 0;
	for (const _point of value) count += 1;
	return count;
}

function sliceCodePoints(value: string, max: number): string {
	if (value.length <= max) return value;
	return Array.from(value.slice(0, max * 2))
		.slice(0, max)
		.join('');
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}
