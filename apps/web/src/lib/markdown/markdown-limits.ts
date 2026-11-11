/**
 * The text pre-check: what the Markdown renderer agrees to PARSE.
 *
 * Everything the parser BUILDS — tables (padded cells), blocks, list items,
 * links, images, depth — is budgeted exactly on the parsed tree, before it is
 * turned into HTML (`markdown-tree-budget`). Guessing it from the text did not
 * work: a GFM table ends where the parser says so, inside a quote or a list
 * item too, and a 3.6 KB text whose table the guess ended early took 10.2 s
 * (PR #3137, second closure check).
 *
 * What stays here is what costs or breaks the parse itself, measured for
 * PR #3137 (jsdom):
 *
 *  - 2,000 nested list levels (`'- '.repeat(2000)`, 4 KB) overflow the call
 *    stack; a list nested by tabs after a `>` marker, 500 levels, 10.2 s;
 *  - emphasis delimiters, brackets (nested links resolve quadratically; 500
 *    nested images took 430 ms to parse) and raw-HTML openers scale
 *    super-linearly in the tokenizer;
 *  - and the size.
 *
 * One linear pass, no regular expressions, and NOTHING is skipped: every line
 * is counted, code blocks included. Skipping what looked like a top-level
 * code fence let a list item `- a` followed by a fence line indented three
 * spaces hide everything after it — the parser opens that fence inside the
 * list item and closes it on the next unindented line — so 8,000 table rows
 * behind it took 16.7 s to parse (PR #3137, third closure check). A real code
 * block is cheap to parse, so counting it too is safe.
 */

/** Characters. Mission and Goal descriptions cap at 10,000; Task ones are unbounded. */
export const MAX_MARKDOWN_LENGTH = 32 * 1024;

/**
 * Nesting of one line: the container markers (`>`, `-`, `*`, `+`, `1.`) it
 * opens with, plus one level per two columns of indentation anywhere in that
 * prefix — before a marker or after one, with tabs expanded to the next
 * multiple of four.
 */
export const MAX_MARKDOWN_NESTING = 32;

export interface MarkdownTextCounts {
    /** Non-blank lines (inline fields only: they render many to a page). */
    lines: number;
    /** The sum of every line's nesting: the parser re-checks each open container per line. */
    nestingWork: number;
    /** `*`, `_`, `~`: emphasis delimiters. */
    emphasis: number;
    /** Backtick runs: two make a code span. */
    codeTicks: number;
    /** `[`: link, image and footnote openers (nested ones resolve quadratically). */
    brackets: number;
    /** `![`: image openers (nested image labels are the costliest to resolve). */
    images: number;
    /** `<`: raw-HTML and autolink openers. */
    angles: number;
    /**
     * Lines that may be table rows: every non-blank line from a delimiter-like
     * row (only `|`, `:`, `-`, spaces, after the container prefix) to the next
     * blank line. The parser's table step is quadratic in rows (1,000 piped
     * rows: 0.7 s to parse), so this bounds the PARSE; it over-counts on
     * purpose. The exact cells are budgeted on the parsed tree.
     */
    tableRows: number;
    /** `|` on those lines: the table step's per-cell work. */
    tablePipes: number;
}

/** Text caps for descriptions. */
export const BLOCK_TEXT_CAPS: MarkdownTextCounts = {
    lines: 1_500,
    nestingWork: 4_000,
    emphasis: 1_000,
    codeTicks: 1_000,
    brackets: 500,
    images: 100,
    angles: 4_000,
    tableRows: 600,
    tablePipes: 3_000,
};

/** Characters of one inline field (a DoD criterion: the API allows 500). */
export const MAX_INLINE_MARKDOWN_LENGTH = 1_000;

/** Text caps for one inline field. */
export const INLINE_TEXT_CAPS: MarkdownTextCounts = {
    lines: 20,
    nestingWork: Number.POSITIVE_INFINITY,
    emphasis: 60,
    codeTicks: 40,
    brackets: 40,
    images: 10,
    angles: 200,
    tableRows: Number.POSITIVE_INFINITY,
    tablePipes: Number.POSITIVE_INFINITY,
};

export type MarkdownTextLimitReason = 'length' | 'nesting' | keyof MarkdownTextCounts;

export type MarkdownTextAssessment =
    | { render: true }
    | { render: false; reason: MarkdownTextLimitReason };

function isSpace(char: string | undefined): boolean {
    return char === ' ' || char === '\t';
}

function isDigit(char: string | undefined): boolean {
    return char !== undefined && char >= '0' && char <= '9';
}

/**
 * The nesting of one line's container prefix. Every whitespace column counts —
 * before the first marker and after any — except the one space each marker
 * needs; tabs advance to the next multiple of four, as the parser expands them.
 */
function lineNesting(
    text: string,
    start: number,
    end: number,
): { depth: number; contentStart: number } {
    let column = 0;
    let whitespace = 0;
    let markers = 0;
    let i = start;
    for (;;) {
        while (i < end && isSpace(text[i])) {
            const width = text[i] === '\t' ? 4 - (column % 4) : 1;
            column += width;
            whitespace += width;
            i++;
        }
        const char = text[i];
        if (char === '>') {
            markers++;
            column++;
            i++;
            continue;
        }
        if (
            (char === '-' || char === '*' || char === '+') &&
            (i + 1 >= end || isSpace(text[i + 1]))
        ) {
            markers++;
            column++;
            i++;
            continue;
        }
        if (isDigit(char)) {
            let j = i;
            while (j - i < 9 && isDigit(text[j])) j++;
            if ((text[j] === '.' || text[j] === ')') && (j + 1 >= end || isSpace(text[j + 1]))) {
                markers++;
                column += j + 1 - i;
                i = j + 1;
                continue;
            }
        }
        return {
            depth: markers + Math.floor(Math.max(0, whitespace - markers) / 2),
            contentStart: i,
        };
    }
}

/** Only `|`, `:`, `-` and spaces, with a `-`: a possible table delimiter row. */
function isDelimiterLike(text: string, start: number, end: number): boolean {
    let dash = false;
    for (let i = start; i < end; i++) {
        const char = text[i];
        if (char === '-') dash = true;
        else if (char !== '|' && char !== ':' && !isSpace(char) && char !== '\r') return false;
    }
    return dash;
}

interface TextOptions {
    caps: MarkdownTextCounts;
    maxLength: number;
    /** `false` for the inline parser, which builds no containers or tables. */
    blockConstructs: boolean;
}

function assessText(
    content: string,
    { caps, maxLength, blockConstructs }: TextOptions,
): MarkdownTextAssessment {
    if (content.length > maxLength) return { render: false, reason: 'length' };

    const counts: MarkdownTextCounts = {
        lines: 0,
        nestingWork: 0,
        emphasis: 0,
        codeTicks: 0,
        brackets: 0,
        images: 0,
        angles: 0,
        tableRows: 0,
        tablePipes: 0,
    };
    // The only state: whether the line may be a table row. It only ever ADDS
    // to the counts, and it ends where the parser ends a table — at a blank
    // (whitespace-only) line; a bare ">" is not blank here, so inside a quote
    // it over-counts. Nothing suspends counting: every line of the text is
    // counted, code blocks included (PR #3137, third closure check: skipping
    // a "fence" the parser opened inside a list item hid the rest of the text).
    let inTable = false;
    let previousBlank = true;
    let previousPipes = 0;

    for (let lineStart = 0; lineStart <= content.length; ) {
        let lineEnd = content.indexOf('\n', lineStart);
        if (lineEnd < 0) lineEnd = content.length;

        let blank = true;
        let pipes = 0;
        for (let i = lineStart; i < lineEnd; i++) {
            const char = content[i];
            if (blank && !isSpace(char) && char !== '\r') blank = false;
            if (char === '|') pipes++;
            if (char === '*' || char === '_' || char === '~') counts.emphasis++;
            else if (char === '`') {
                if (content[i - 1] !== '`') counts.codeTicks++;
            } else if (char === '[') {
                counts.brackets++;
                if (content[i - 1] === '!') counts.images++;
            } else if (char === '<') counts.angles++;
        }
        if (blank) {
            inTable = false;
        } else {
            counts.lines++;
            if (blockConstructs) {
                const { depth, contentStart } = lineNesting(content, lineStart, lineEnd);
                if (depth > MAX_MARKDOWN_NESTING) return { render: false, reason: 'nesting' };
                counts.nestingWork += depth;
                if (inTable) {
                    counts.tableRows++;
                    counts.tablePipes += pipes;
                } else if (
                    !previousBlank &&
                    (pipes > 0 || previousPipes > 0) &&
                    isDelimiterLike(content, contentStart, lineEnd)
                ) {
                    inTable = true;
                    counts.tableRows += 2; // the header and the delimiter row
                    counts.tablePipes += pipes + previousPipes;
                }
            }
        }
        previousBlank = blank;
        previousPipes = pipes;
        for (const key of Object.keys(caps) as Array<keyof MarkdownTextCounts>) {
            if (counts[key] > caps[key]) return { render: false, reason: key };
        }
        lineStart = lineEnd + 1;
    }
    return { render: true };
}

/** One linear pass: may this description go through the (block) Markdown parser? */
export function assessMarkdownText(content: string): MarkdownTextAssessment {
    return assessText(content, {
        caps: BLOCK_TEXT_CAPS,
        maxLength: MAX_MARKDOWN_LENGTH,
        blockConstructs: true,
    });
}

/**
 * The same pass for one inline field. Block constructs are switched off in the
 * inline parser, so nesting and potential table rows are not counted; every
 * line and character still is.
 */
export function assessInlineMarkdownText(content: string): MarkdownTextAssessment {
    return assessText(content, {
        caps: INLINE_TEXT_CAPS,
        maxLength: MAX_INLINE_MARKDOWN_LENGTH,
        blockConstructs: false,
    });
}
