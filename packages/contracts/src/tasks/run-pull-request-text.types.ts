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
 *     images reduced to their alternative text, every `@` and every `#<digit>`
 *     followed by a zero-width space, issue / pull request / discussion links
 *     to the provider broken unless they are the Task's own pull request,
 *     script-like link schemes broken.
 *  4. The whole result is capped, with code blocks cut at a line and closed,
 *     and CI-skip directives are neutralised everywhere (a squash merge can
 *     copy a description into a commit message, where they are read as text).
 *
 * Known limits, stated rather than hidden: the provider rules target GitHub
 * (`#12`, `GH-12`, `github.com/…/issues|pull|discussions/…`); a mention or a
 * closing keyword INSIDE code is left as written, because a renderer does not
 * act on code — a repository that squash-merges with the description as the
 * commit message reads that code as plain text.
 */

import { composeFleetTaskCommitMessage, neutralizeCiSkipDirectives } from '../fleet/fleet-commit-message.types.js';

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
	const lines = summary.replace(OTHER_LINE_BREAKS, '\n').split('\n');
	let last = lines.length - 1;
	while (last >= 0 && lines[last]!.trim() === '') last -= 1;
	if (last < 0) return { title: null, summary };
	const line = lines[last]!;
	if (line.length > RUN_PULL_REQUEST_TITLE_MAX_LINE_LENGTH) return { title: null, summary };
	const match = TITLE_LINE.exec(line);
	if (!match) return { title: null, summary };
	const title = sanitizeRunPullRequestTitle(match[1]);
	if (!title) return { title: null, summary };
	return { title, summary: lines.slice(0, last).join('\n').trimEnd() };
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
	if (parsed.title) return cutAtWord(parsed.title, limit);
	// Bounded before any pattern runs: a first sentence is never past this.
	const lines = sliceCodePoints(summary, 4000).replace(OTHER_LINE_BREAKS, '\n').split('\n');
	let fallback: string | null = null;
	for (const raw of lines) {
		const line = raw.trim();
		// A rule, a fence or a heading names a section; it does not say what changed.
		if (!line || /^(?:[-=*_~`]{3,}|#{1,6}(?:\s|$))/.test(line)) continue;
		const text = sliceCodePoints(line.replace(/^(?:[-*+]|\d{1,3}[.)])[ \t]+/, ''), 400);
		const sentence = /^(.{1,400}?[.!?])(?:\s|$)/.exec(text);
		const cleaned = cleanTitleText(sentence ? sentence[1]! : text);
		if (!isUsableTitle(cleaned)) continue;
		// A bare label (`Summary:`, `Done.`) is kept only if nothing better follows.
		if (cleaned.split(' ').length >= 3) return cutAtWord(cleaned, limit);
		fallback ??= cleaned;
	}
	return fallback ? cutAtWord(fallback, limit) : null;
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
	const bounded = sliceCodePoints(summary, maxLength * 4)
		.replace(OTHER_LINE_BREAKS, '\n')
		.replace(CONTROL_CHARACTERS, '')
		.replace(BIDI_CONTROLS, '')
		.replace(LONE_SURROGATES, '');
	const blocks = splitFencedBlocks(bounded).map((block): ProseBlock | CodeBlock =>
		block.kind === 'code' ? block : { kind: 'prose', text: sanitizeProse(block.text, allowed) }
	);
	return neutralizeCiSkipDirectives(fitBlocks(blocks, maxLength)).trim();
}

/**
 * The commit message a run commits with when it named its change: the planned
 * message with its subject replaced by a conventional commit built from the
 * run's `PR-TITLE:` line. The body and every trailer of the planned message
 * are kept byte-for-byte. Unchanged when the summary names no title.
 */
export function applyRunPullRequestTitleToCommitMessage(message: string, summary: string | null | undefined): string {
	if (typeof message !== 'string' || !message) return message;
	const { title } = parseRunPullRequestTitle(summary);
	if (!title) return message;
	const subject = composeFleetTaskCommitMessage({ title, slug: null });
	if (!subject || subject.includes('\n')) return message;
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

/** Plain single-line text, with everything a title or a commit subject would act on removed. */
function cleanTitleText(value: string): string {
	let text = value.replace(ALL_CONTROL_CHARACTERS, ' ').replace(FORMAT_CHARACTERS, '').replace(LONE_SURROGATES, '');
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
	return text
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^[*_~ ]+/, '')
		.replace(/[*_~ ]+$/, '');
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

function sanitizeProse(text: string, allowed: ReadonlySet<string>): string {
	return text
		.split('\n')
		.map((line) => sanitizeProseLine(line, allowed))
		.join('\n');
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
		let close = -1;
		let scan = end;
		while (scan < piece.length) {
			if (piece[scan] !== '`') {
				scan += 1;
				continue;
			}
			let runEnd = scan;
			while (runEnd < piece.length && piece[runEnd] === '`') runEnd += 1;
			if (runEnd - scan === length) {
				close = scan;
				break;
			}
			scan = runEnd;
		}
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

/** Text outside every code span: neutralised without looking at what surrounds it. */
function sanitizeProseText(value: string, allowed: ReadonlySet<string>): string {
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
	text = text.replace(SCRIPT_SCHEME, `$1$2${ZWSP}:`);
	text = text.replace(
		PROVIDER_REFERENCE_PATH,
		(
			match,
			prefix: string | undefined,
			scheme: string | undefined,
			repository: string | undefined,
			kind: string,
			number: string
		) => {
			if (repository && allowed.has(`${repository}/${kind}/${number}`.toLowerCase())) return match;
			// The scheme is broken too, so what is left is plain text and not a
			// link to an address that no longer exists.
			const head = prefix && scheme ? `${scheme.replace('://', `:${ZWSP}//`)}${prefix.slice(scheme.length)}` : '';
			return `${head || prefix || ''}/${kind}/${ZWSP}${number}`;
		}
	);
	// Every `@`, whatever follows it: Markdown removed later (an escape, an
	// empty emphasis) must not be able to put a name back next to it.
	text = text.replace(/[@\uff20\ufe6b]/g, (at) => `${at}${ZWSP}`);
	text = text.replace(/[#\uff03\ufe5f](?=\\?[0-9])/g, (hash) => `${hash}${ZWSP}`);
	text = text.replace(/\bGH-(?=[0-9])/gi, (match) => `${match}${ZWSP}`);
	return text;
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
