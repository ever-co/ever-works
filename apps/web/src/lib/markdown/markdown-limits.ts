/**
 * What the Markdown renderer agrees to parse.
 *
 * The parser behind `MarkdownContent` (micromark → mdast → hast → React) is
 * recursive in the nesting depth of a document and super-linear in some
 * constructs. Measured for PR #3137 (jsdom, server render; client renders take
 * up to about twice as long):
 *
 *  - 2,000 nested list levels (`'- '.repeat(2000)`, 4 KB) overflow the call
 *    stack on the server and the client alike; 1,000 levels take 2.2 s;
 *  - one GFM table of 2,000 rows takes 3.3 s, 5,000 cells 2 s (quadratic);
 *  - 500 nested images take 0.8 s (quadratic);
 *  - 10,000 list items in nested lines take 1.5 s;
 *  - 6,000 autolinks take 1.9 s;
 *  - 10,000 emphasis delimiters in one paragraph take 2 s.
 *
 * Descriptions are written by agents as well as people, so no single text may
 * take its detail page down — or keep it busy for seconds. `assessMarkdown` is
 * one linear pass over the text, run before parsing; anything over a budget is
 * shown as plain text instead (see `MarkdownContent`). Every budget sits far
 * above what a real description uses (a 10,000-character mixed document — the
 * Mission and Goal cap — parses in about 170 ms) and well below the points
 * above.
 *
 * The budgets count over the WHOLE text, outside top-level code fences: each
 * construct costs at least linear time, so whole-text budgets bound the total
 * (a per-paragraph budget would let sixteen 4 KB paragraphs each spend it).
 */

/** Characters. Mission and Goal descriptions cap at 10,000; Task ones are unbounded. */
export const MAX_MARKDOWN_LENGTH = 64 * 1024;

/**
 * Nesting of one line: container markers (`>`, `-`, `*`, `+`, `1.`) it opens
 * with, plus one level per two columns of indentation.
 */
export const MAX_MARKDOWN_NESTING = 32;

/** The sum of every line's nesting: the parser re-checks each open container per line. */
export const MAX_NESTING_WORK = 8_000;

/** List-item markers. */
export const MAX_LIST_ITEMS = 1_000;

/** `*`, `_` and `~` characters: emphasis delimiters. */
export const MAX_EMPHASIS_DELIMITERS = 2_000;

/** `[` characters: link, image and footnote openers. */
export const MAX_LINK_BRACKETS = 1_000;

/** `![` image openers. */
export const MAX_IMAGES = 100;

/** `|` characters: table cells. */
export const MAX_TABLE_PIPES = 1_000;

/** `://` and `www.`: links and autolinks. */
export const MAX_LINKS = 500;

export type MarkdownLimitReason =
    | 'length'
    | 'nesting'
    | 'listItems'
    | 'emphasis'
    | 'brackets'
    | 'images'
    | 'tables'
    | 'links';

export type MarkdownAssessment = { render: true } | { render: false; reason: MarkdownLimitReason };

function isSpace(char: string | undefined): boolean {
    return char === ' ' || char === '\t';
}

function isDigit(char: string | undefined): boolean {
    return char !== undefined && char >= '0' && char <= '9';
}

interface Fence {
    char: string;
    length: number;
}

/** A run of 3+ fence characters after at most `maxIndent` spaces, or null. */
function fenceRun(
    text: string,
    start: number,
    end: number,
    maxIndent: number,
): (Fence & { after: number }) | null {
    let i = start;
    while (i < end && text[i] === ' ' && i - start < maxIndent) i++;
    const char = text[i];
    if (char !== '`' && char !== '~') return null;
    let j = i;
    while (j < end && text[j] === char) j++;
    return j - i >= 3 ? { char, length: j - i, after: j } : null;
}

/**
 * A top-level fence opener, read STRICTLY (at most 3 spaces of indentation, no
 * backtick in a backtick fence's info string): skipping lines the parser does
 * not treat as code would let them through unchecked, so when in doubt a line
 * is not an opener. A fence inside a list or quote is simply not skipped.
 */
function fenceOpens(text: string, start: number, end: number): Fence | null {
    const run = fenceRun(text, start, end, 3);
    if (!run) return null;
    if (run.char === '`' && text.slice(run.after, end).includes('`')) return null;
    return { char: run.char, length: run.length };
}

/** A closer, read LENIENTLY (any indentation): ending a fence early only means checking more. */
function fenceCloses(text: string, start: number, end: number, fence: Fence): boolean {
    const run = fenceRun(text, start, end, Number.POSITIVE_INFINITY);
    if (!run || run.char !== fence.char || run.length < fence.length) return false;
    for (let i = run.after; i < end; i++) {
        if (!isSpace(text[i]) && text[i] !== '\r') return false;
    }
    return true;
}

/** Nesting of one line (see {@link MAX_MARKDOWN_NESTING}) and its list markers. */
function lineNesting(
    text: string,
    start: number,
    end: number,
): { depth: number; listItems: number } {
    // Leading indentation only: the spaces after a marker belong to that marker.
    let columns = 0;
    let i = start;
    while (i < end && isSpace(text[i])) {
        columns += text[i] === '\t' ? 4 : 1;
        i++;
    }
    let markers = 0;
    let listItems = 0;
    for (;;) {
        while (i < end && isSpace(text[i])) i++;
        const char = text[i];
        if (char === '>') {
            markers++;
            i++;
            continue;
        }
        if (
            (char === '-' || char === '*' || char === '+') &&
            (i + 1 >= end || isSpace(text[i + 1]))
        ) {
            markers++;
            listItems++;
            i++;
            continue;
        }
        if (isDigit(char)) {
            let j = i;
            while (j - i < 9 && isDigit(text[j])) j++;
            if ((text[j] === '.' || text[j] === ')') && (j + 1 >= end || isSpace(text[j + 1]))) {
                markers++;
                listItems++;
                i = j + 1;
                continue;
            }
        }
        return { depth: markers + Math.floor(columns / 2), listItems };
    }
}

/** One linear pass: may this text go through the Markdown parser? */
export function assessMarkdown(content: string): MarkdownAssessment {
    if (content.length > MAX_MARKDOWN_LENGTH) return { render: false, reason: 'length' };

    let nestingWork = 0;
    let listItems = 0;
    let images = 0;
    let pipes = 0;
    let links = 0;
    let emphasis = 0;
    let brackets = 0;
    let fence: Fence | null = null;

    for (let lineStart = 0; lineStart <= content.length; ) {
        let lineEnd = content.indexOf('\n', lineStart);
        if (lineEnd < 0) lineEnd = content.length;

        if (fence) {
            if (fenceCloses(content, lineStart, lineEnd, fence)) fence = null;
        } else if (!(fence = fenceOpens(content, lineStart, lineEnd))) {
            const line = lineNesting(content, lineStart, lineEnd);
            if (line.depth > MAX_MARKDOWN_NESTING) return { render: false, reason: 'nesting' };
            nestingWork += line.depth;
            listItems += line.listItems;
            if (nestingWork > MAX_NESTING_WORK) return { render: false, reason: 'nesting' };
            if (listItems > MAX_LIST_ITEMS) return { render: false, reason: 'listItems' };

            for (let i = lineStart; i < lineEnd; i++) {
                const char = content[i];
                if (char === '*' || char === '_' || char === '~') emphasis++;
                else if (char === '[') {
                    brackets++;
                    if (content[i - 1] === '!') images++;
                } else if (char === '|') pipes++;
                else if (char === ':' && content[i + 1] === '/' && content[i + 2] === '/') links++;
                else if (char === 'w' && content.startsWith('ww.', i + 1)) links++;
            }
            if (emphasis > MAX_EMPHASIS_DELIMITERS) return { render: false, reason: 'emphasis' };
            if (brackets > MAX_LINK_BRACKETS) return { render: false, reason: 'brackets' };
            if (images > MAX_IMAGES) return { render: false, reason: 'images' };
            if (pipes > MAX_TABLE_PIPES) return { render: false, reason: 'tables' };
            if (links > MAX_LINKS) return { render: false, reason: 'links' };
        }
        lineStart = lineEnd + 1;
    }
    return { render: true };
}
