/**
 * Markdown → one clean line of plain text.
 *
 * Record descriptions (Missions, Goals, Tasks, Teams, Works, Ideas, Agent
 * capabilities) are written in Markdown and rendered as Markdown on their
 * detail pages. Everywhere a description is shown in a small space — list
 * and kanban cards, pickers, browser titles, notifications — it must read as
 * a sentence, not leak `##`, `**`, `- [ ]` or `[label](url)` markup.
 *
 * `markdownToPlainText` strips the markup and joins the blocks into one line;
 * `markdownExcerpt` also caps the length on a grapheme and word boundary. Both
 * are pure, dependency-free and safe on the server and the client. The output
 * is plain TEXT for React to escape, never HTML: raw tags are dropped from it,
 * and nothing here makes a string safe to inject with `dangerouslySetInnerHTML`.
 *
 * Cost: these run on every render of list pages, over text nobody bounds (a
 * Task description has no length cap). So the input is cut to its first
 * {@link EXCERPT_INPUT_LIMIT} characters before anything else — one line from
 * the start never needs more — and every step after that is a single linear
 * pass: no regular expression with nested or overlapping quantifiers, links
 * and brackets matched once with a stack, never by searching forward from
 * each opener.
 */

/** Default cap for card excerpts; cards clamp visually to 2–3 lines anyway. */
export const DEFAULT_EXCERPT_LENGTH = 200;

/** Only this much of the start of a description is ever read. */
export const EXCERPT_INPUT_LIMIT = 4096;

// Private-use code points stand in for escaped characters and code spans
// while the rest of a line is scanned; any already in the input are dropped.
const ESCAPE_BASE = 0xf000; // escaped ASCII punctuation c → ESCAPE_BASE + c
const CODE_MARK = ''; // a code span → CODE_MARK + index character
const CODE_INDEX_BASE = 0xe100;
const MAX_CODE_SPANS = 0xf000 - CODE_INDEX_BASE;
const PRIVATE_USE = /[-]/g;

const ENTITIES: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
};
const ENTITY = /&(?:amp|lt|gt|quot|#39|apos|nbsp);/g;

const TERMINAL_PUNCTUATION = new Set(['.', '!', '?', ':', ';', '…']);
const TRAILING_TRIM = new Set([' ', '.', ',', ';', ':', '!', '?', '·', '—', '–', '-']);

function isSpace(char: string | undefined): boolean {
    return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function isWhitespace(char: string | undefined): boolean {
    return char === undefined || isSpace(char) || char === ' ';
}

function isAsciiPunctuation(char: string | undefined): boolean {
    if (char === undefined || char.length !== 1) return false;
    const code = char.charCodeAt(0);
    return (
        (code >= 0x21 && code <= 0x2f) ||
        (code >= 0x3a && code <= 0x40) ||
        (code >= 0x5b && code <= 0x60) ||
        (code >= 0x7b && code <= 0x7e)
    );
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
function isWordChar(char: string | undefined): boolean {
    return char !== undefined && WORD_CHAR.test(char);
}

function isAsciiLetter(char: string | undefined): boolean {
    if (char === undefined) return false;
    const code = char.charCodeAt(0);
    return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isDigit(char: string | undefined): boolean {
    return char !== undefined && char >= '0' && char <= '9';
}

/** `<!-- … -->` anywhere, across lines. Unclosed comments stay as text. */
function removeHtmlComments(source: string): string {
    let out = '';
    let from = 0;
    for (;;) {
        const start = source.indexOf('<!--', from);
        if (start < 0) break;
        const end = source.indexOf('-->', start + 4);
        if (end < 0) break;
        out += `${source.slice(from, start)} `;
        from = end + 3;
    }
    return out + source.slice(from);
}

// ─── Block level ──────────────────────────────────────────────────────────

interface Fence {
    char: '`' | '~';
    length: number;
}

function leadingIndent(line: string): number {
    let i = 0;
    while (i < line.length && isSpace(line[i])) i++;
    return i;
}

/** A code fence opener at any indentation (fences nest inside list items). */
function fenceOpen(line: string): Fence | null {
    const start = leadingIndent(line);
    const char = line[start];
    if (char !== '`' && char !== '~') return null;
    let end = start;
    while (line[end] === char) end++;
    const length = end - start;
    if (length < 3) return null;
    // A backtick fence's info string cannot contain a backtick: "```npm i``` first"
    // is inline code, not a fence.
    if (char === '`' && line.indexOf('`', end) >= 0) return null;
    return { char, length };
}

/** Closes only with the same character, at least as long, and nothing after it. */
function fenceCloses(line: string, fence: Fence): boolean {
    const start = leadingIndent(line);
    let end = start;
    while (line[end] === fence.char) end++;
    if (end - start < fence.length) return false;
    for (let i = end; i < line.length; i++) if (!isSpace(line[i])) return false;
    return true;
}

/** `---`, `***`, `___`, `- - -` rules and `===` / `---` setext underlines. */
function isRuleOrUnderline(line: string): boolean {
    let marker = '';
    let count = 0;
    for (const char of line) {
        if (isSpace(char)) continue;
        if (char !== '-' && char !== '*' && char !== '_' && char !== '=') return false;
        if (marker && char !== marker) return false;
        marker = char;
        count++;
    }
    return count >= 3;
}

const TABLE_DELIMITER_CELL = /^\s*:?-+:?\s*$/;

/** `| --- | :-: |` */
function isTableDelimiter(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
    return cells.length > 0 && cells.every((cell) => TABLE_DELIMITER_CELL.test(cell));
}

const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*\S/;

/**
 * Strip a line's container markers — any number of `>` and list markers
 * (`-`, `*`, `+`, `1.`, `1)`, with an optional task box) — and report whether
 * the line is a block that ends its own sentence (a list item, a heading, a
 * table row).
 */
function stripBlockMarkers(line: string): { text: string; endsSentence: boolean } {
    let i = 0;
    let listItem = false;
    for (;;) {
        while (i < line.length && isSpace(line[i])) i++;
        const char = line[i];
        if (char === '>') {
            i++;
            continue;
        }
        if (
            (char === '-' || char === '*' || char === '+') &&
            (i + 1 >= line.length || isSpace(line[i + 1]))
        ) {
            i++;
            listItem = true;
            continue;
        }
        if (isDigit(char)) {
            let j = i;
            while (j - i < 9 && isDigit(line[j])) j++;
            if (
                (line[j] === '.' || line[j] === ')') &&
                (j + 1 >= line.length || isSpace(line[j + 1]))
            ) {
                i = j + 1;
                listItem = true;
                continue;
            }
        }
        break;
    }
    if (
        listItem &&
        line[i] === '[' &&
        (line[i + 1] === ' ' || line[i + 1] === 'x' || line[i + 1] === 'X') &&
        line[i + 2] === ']'
    ) {
        i += 3;
    }
    let text = line.slice(i);

    // ATX heading: 1–6 `#` then a space or the end; drop an optional closing run.
    let hashes = 0;
    while (hashes < text.length && text[hashes] === '#') hashes++;
    if (hashes >= 1 && hashes <= 6 && (hashes === text.length || isSpace(text[hashes]))) {
        let end = text.length;
        while (end > hashes && isSpace(text[end - 1])) end--;
        let closing = end;
        while (closing > hashes && text[closing - 1] === '#') closing--;
        if (closing < end && (closing === hashes || isSpace(text[closing - 1]))) end = closing;
        return { text: text.slice(hashes, end), endsSentence: true };
    }

    const trimmed = text.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('|') && trimmed.endsWith('|')) {
        const cells = trimmed
            .slice(1, -1)
            .split('|')
            .map((cell) => cell.trim())
            .filter(Boolean);
        text = cells.join(' · ');
        return { text, endsSentence: true };
    }
    return { text, endsSentence: listItem };
}

// ─── Inline level ─────────────────────────────────────────────────────────

/** `\*` → a private-use stand-in, so an escaped character is never markup. */
function protectEscapes(line: string): string {
    let out = '';
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '\\' && isAsciiPunctuation(line[i + 1])) {
            out += String.fromCharCode(ESCAPE_BASE + line.charCodeAt(i + 1));
            i++;
        } else {
            out += char;
        }
    }
    return out;
}

function restoreEscapes(text: string, keepBackslash: boolean): string {
    let out = '';
    for (const char of text) {
        const code = char.charCodeAt(0);
        if (code >= ESCAPE_BASE && code < ESCAPE_BASE + 0x80) {
            const original = String.fromCharCode(code - ESCAPE_BASE);
            out += keepBackslash ? `\\${original}` : original;
        } else {
            out += char;
        }
    }
    return out;
}

/**
 * Replace code spans by a stand-in (their content must not be read as markup)
 * and return the contents. A run of N backticks closes at the next run of
 * exactly N; the next run of each length is precomputed, so this is linear.
 */
function protectCodeSpans(line: string, codes: string[]): string {
    const runs: Array<{ start: number; length: number }> = [];
    for (let i = 0; i < line.length; ) {
        if (line[i] !== '`') {
            i++;
            continue;
        }
        const start = i;
        while (line[i] === '`') i++;
        runs.push({ start, length: i - start });
    }
    if (runs.length < 2) return line;

    const nextSame = new Int32Array(runs.length).fill(-1);
    const lastByLength = new Map<number, number>();
    for (let r = runs.length - 1; r >= 0; r--) {
        nextSame[r] = lastByLength.get(runs[r].length) ?? -1;
        lastByLength.set(runs[r].length, r);
    }

    let out = '';
    let from = 0;
    for (let r = 0; r < runs.length; r++) {
        const close = nextSame[r];
        if (close < 0 || codes.length >= MAX_CODE_SPANS) continue;
        const open = runs[r];
        const contentStart = open.start + open.length;
        let content = line.slice(contentStart, runs[close].start);
        if (
            content.length >= 2 &&
            content.startsWith(' ') &&
            content.endsWith(' ') &&
            content.trim()
        ) {
            content = content.slice(1, -1);
        }
        out +=
            line.slice(from, open.start) +
            CODE_MARK +
            String.fromCharCode(CODE_INDEX_BASE + codes.length);
        codes.push(restoreEscapes(content, true));
        from = runs[close].start + runs[close].length;
        r = close;
    }
    return out + line.slice(from);
}

/** Index of the matching closer for every opener, by one pass with a stack. */
function matchPairs(text: string, open: string, close: string): Int32Array {
    const match = new Int32Array(text.length).fill(-1);
    const stack: number[] = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === open) stack.push(i);
        else if (text[i] === close && stack.length > 0) match[stack.pop() as number] = i;
    }
    return match;
}

/** For each index, the next index (≥ it) whose character satisfies `test`. */
function nextIndexWhere(text: string, test: (char: string) => boolean): Int32Array {
    const next = new Int32Array(text.length + 1).fill(-1);
    for (let i = text.length - 1; i >= 0; i--) next[i] = test(text[i]) ? i : next[i + 1];
    return next;
}

/**
 * Links, images, footnote references, autolinks and raw HTML tags, in one
 * left-to-right pass. Labels stay (and are scanned like any text); the
 * `](destination)` / `][ref]` part, footnote references and tags are skipped
 * by jumping over them, so every character is visited a bounded number of times.
 */
function stripLinksAndTags(text: string): string {
    const bracketClose = matchPairs(text, '[', ']');
    const parenClose = matchPairs(text, '(', ')');
    const nextGt = nextIndexWhere(text, (char) => char === '>');
    const nextLt = nextIndexWhere(text, (char) => char === '<');
    const nextSpace = nextIndexWhere(text, (char) => isWhitespace(char));
    const jumpTo = new Int32Array(text.length).fill(-1);
    const before = (a: number, b: number) => a >= 0 && (b < 0 || a < b);

    const out: string[] = [];
    for (let i = 0; i < text.length; i++) {
        if (jumpTo[i] >= 0) {
            i = jumpTo[i];
            continue;
        }
        const char = text[i];

        if (char === '[' || (char === '!' && text[i + 1] === '[')) {
            const open = char === '!' ? i + 1 : i;
            const close = bracketClose[open];
            if (close >= 0) {
                if (char === '[' && text[open + 1] === '^') {
                    i = close; // footnote reference: drop it whole
                    continue;
                }
                const after = text[close + 1];
                const end =
                    after === '('
                        ? parenClose[close + 1]
                        : after === '['
                          ? bracketClose[close + 1]
                          : -1;
                if (end >= 0) {
                    jumpTo[close] = end; // drop "](destination)" / "][ref]"
                    i = open; // drop "[" (and "!"), keep the label
                    continue;
                }
            }
        }

        if (char === '<') {
            const gt = nextGt[i + 1] ?? -1;
            if (gt >= 0 && !before(nextLt[i + 1], gt)) {
                // <scheme:…> autolink: keep the URL, drop the brackets.
                let j = i + 1;
                while (
                    j < gt &&
                    j - i <= 33 &&
                    (isAsciiLetter(text[j]) || isDigit(text[j]) || '+.-'.includes(text[j]))
                )
                    j++;
                if (
                    j - i >= 3 &&
                    isAsciiLetter(text[i + 1]) &&
                    text[j] === ':' &&
                    !before(nextSpace[i + 1], gt)
                ) {
                    jumpTo[gt] = gt;
                    continue;
                }
                // <tag …> or </tag>: drop it, keep the text around it.
                const nameStart = text[i + 1] === '/' ? i + 2 : i + 1;
                if (isAsciiLetter(text[nameStart])) {
                    let k = nameStart;
                    while (
                        k < gt &&
                        (isAsciiLetter(text[k]) || isDigit(text[k]) || text[k] === '-')
                    )
                        k++;
                    if (k === gt || isWhitespace(text[k]) || text[k] === '/') {
                        out.push(' ');
                        i = gt;
                        continue;
                    }
                }
            }
        }

        out.push(char);
    }
    return out.join('');
}

/**
 * Remove emphasis delimiters (`*`, `_`, `~`) that pair up; leave unpaired ones
 * as text (`2 * 3`, `5* rating`, `snake_case`). A closer only ever looks at the
 * most recent opener of its own character, so the pass is linear.
 */
function stripEmphasis(text: string): string {
    interface Run {
        start: number;
        end: number;
        char: string;
        remove: boolean;
    }
    const runs: Run[] = [];
    const stacks: Record<string, Run[]> = { '*': [], _: [], '~': [] };
    for (let i = 0; i < text.length; ) {
        const char = text[i];
        if (char !== '*' && char !== '_' && char !== '~') {
            i++;
            continue;
        }
        const start = i;
        while (text[i] === char) i++;
        const run: Run = { start, end: i, char, remove: false };
        runs.push(run);
        if (char === '~' && run.end - run.start > 2) continue; // GFM strikethrough is ~ or ~~
        const prev = text[start - 1];
        const next = text[i];
        let canOpen = !isWhitespace(next);
        let canClose = !isWhitespace(prev);
        if (char === '_') {
            canOpen = canOpen && !isWordChar(prev);
            canClose = canClose && !isWordChar(next);
        }
        const stack = stacks[char];
        if (canClose && stack.length > 0) {
            const opener = stack.pop() as Run;
            opener.remove = true;
            run.remove = true;
        } else if (canOpen) {
            stack.push(run);
        }
    }
    if (!runs.some((run) => run.remove)) return text;
    let out = '';
    let from = 0;
    for (const run of runs) {
        if (!run.remove) continue;
        out += text.slice(from, run.start);
        from = run.end;
    }
    return out + text.slice(from);
}

function restoreCodeSpans(text: string, codes: string[]): string {
    if (codes.length === 0) return text;
    let out = '';
    for (let i = 0; i < text.length; i++) {
        if (text[i] === CODE_MARK && i + 1 < text.length) {
            out += codes[text.charCodeAt(i + 1) - CODE_INDEX_BASE] ?? '';
            i++;
        } else {
            out += text[i];
        }
    }
    return out;
}

function stripInline(line: string): string {
    const codes: string[] = [];
    let text = protectEscapes(line);
    text = protectCodeSpans(text, codes);
    text = stripLinksAndTags(text);
    text = stripEmphasis(text);
    text = restoreCodeSpans(text, codes);
    text = restoreEscapes(text, false);
    return text.replace(ENTITY, (entity) => ENTITIES[entity] ?? entity);
}

function collapseWhitespace(text: string): string {
    let out = '';
    let pendingSpace = false;
    for (const char of text) {
        if (isWhitespace(char)) {
            pendingSpace = out.length > 0;
            continue;
        }
        if (pendingSpace) out += ' ';
        pendingSpace = false;
        out += char;
    }
    return out;
}

function endSentence(fragment: string): string {
    return TERMINAL_PUNCTUATION.has(fragment[fragment.length - 1]) ? fragment : `${fragment}.`;
}

/**
 * The start of a Markdown string as one line of plain text: markup removed,
 * headings / list items / table rows / paragraphs each ending a sentence,
 * whitespace collapsed. Fenced code keeps its content without the fences.
 * Reads at most `inputLimit` characters (default {@link EXCERPT_INPUT_LIMIT}).
 */
export function markdownToPlainText(
    markdown: string | null | undefined,
    inputLimit: number = EXCERPT_INPUT_LIMIT,
): string {
    if (typeof markdown !== 'string' || markdown.length === 0) return '';
    let source = markdown.length > inputLimit ? markdown.slice(0, inputLimit) : markdown;
    // A cut between the halves of a surrogate pair leaves a lone high surrogate.
    const lastCode = source.charCodeAt(source.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) source = source.slice(0, -1);
    source = removeHtmlComments(source.replace(PRIVATE_USE, ''));
    if (source.trim().length === 0) return '';

    const fragments: string[] = [];
    let fence: Fence | null = null;
    const terminateLast = () => {
        const last = fragments.length - 1;
        if (last >= 0) fragments[last] = endSentence(fragments[last]);
    };

    for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
        if (fence) {
            if (fenceCloses(rawLine, fence)) {
                fence = null;
                continue;
            }
            const code = collapseWhitespace(rawLine);
            if (code) fragments.push(code);
            continue;
        }
        const opened = fenceOpen(rawLine);
        if (opened) {
            fence = opened;
            terminateLast();
            continue;
        }
        if (rawLine.trim() === '') {
            // A blank line closes a paragraph.
            terminateLast();
            continue;
        }
        if (REFERENCE_DEFINITION.test(rawLine)) continue;
        if (isRuleOrUnderline(rawLine) || isTableDelimiter(rawLine)) {
            terminateLast();
            continue;
        }

        const { text, endsSentence } = stripBlockMarkers(rawLine);
        const plain = collapseWhitespace(stripInline(text));
        if (!plain) continue;
        if (endsSentence) terminateLast();
        fragments.push(endsSentence ? endSentence(plain) : plain);
    }

    return collapseWhitespace(fragments.join(' '));
}

// ─── Truncation ───────────────────────────────────────────────────────────

interface GraphemeSegmenter {
    segment(text: string): Iterable<{ segment: string }>;
}
type SegmenterConstructor = new (
    locales?: string,
    options?: { granularity: 'grapheme' },
) => GraphemeSegmenter;

let cachedSegmenter: GraphemeSegmenter | null | undefined;

function nativeSegmenter(): GraphemeSegmenter | null {
    if (cachedSegmenter === undefined) {
        const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
        cachedSegmenter =
            typeof Segmenter === 'function'
                ? new Segmenter(undefined, { granularity: 'grapheme' })
                : null;
    }
    return cachedSegmenter;
}

const COMBINING_MARK = /\p{M}/u;

/**
 * Grapheme clusters without `Intl.Segmenter`: keeps combining marks,
 * variation selectors, skin-tone modifiers, zero-width-joiner sequences and
 * flag (regional-indicator) pairs with the character they belong to.
 */
export function graphemesFallback(text: string): string[] {
    const clusters: string[] = [];
    let previous = -1;
    let regionalInCluster = 0;
    for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        const regional = code >= 0x1f1e6 && code <= 0x1f1ff;
        const joins =
            clusters.length > 0 &&
            (COMBINING_MARK.test(char) ||
                code === 0x200d ||
                code === 0xfe0e ||
                code === 0xfe0f ||
                (code >= 0x1f3fb && code <= 0x1f3ff) ||
                previous === 0x200d ||
                (regional && regionalInCluster === 1));
        if (joins) clusters[clusters.length - 1] += char;
        else clusters.push(char);
        regionalInCluster = regional ? (joins ? regionalInCluster + 1 : 1) : 0;
        previous = code;
    }
    return clusters;
}

/** User-perceived characters: `Intl.Segmenter` where the engine has it. */
export function graphemes(text: string): string[] {
    const native = nativeSegmenter();
    return native
        ? Array.from(native.segment(text), (part) => part.segment)
        : graphemesFallback(text);
}

/**
 * A one-line excerpt of a Markdown string, at most `maxLength` user-perceived
 * characters (graphemes: an emoji family, a flag or an accented letter is
 * never cut in half) including the trailing ellipsis. Cuts on a word boundary
 * when one is reasonably close.
 */
export function markdownExcerpt(
    markdown: string | null | undefined,
    maxLength: number = DEFAULT_EXCERPT_LENGTH,
): string {
    const limit = Math.max(1, Math.floor(maxLength));
    const text = markdownToPlainText(markdown, Math.max(EXCERPT_INPUT_LIMIT, limit * 8));
    if (text.length <= limit) return text;
    const clusters = graphemes(text);
    if (clusters.length <= limit) return text;
    if (limit === 1) return '…';

    const kept = clusters.slice(0, limit - 1);
    let cut = kept.length;
    for (let k = kept.length - 1; k >= kept.length * 0.6; k--) {
        if (kept[k] === ' ') {
            cut = k;
            break;
        }
    }
    while (cut > 0 && TRAILING_TRIM.has(kept[cut - 1])) cut--;
    return `${kept.slice(0, cut).join('')}…`;
}
