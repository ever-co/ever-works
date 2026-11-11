/**
 * What the Markdown renderer agrees to parse.
 *
 * The parser behind `MarkdownContent` (micromark → mdast → hast → React) is
 * recursive in the nesting depth of a document and costs time per node it
 * builds, super-linearly for some constructs. Measured for PR #3137 (jsdom
 * client render on the development machine):
 *
 *  - 2,000 nested list levels (`'- '.repeat(2000)`, 4 KB) overflow the call
 *    stack on the server and the client alike;
 *  - a GFM table keeps going over lines WITHOUT pipes and pads every row to
 *    the header's width, with a per-row sibling search: a 2.8 KB text with a
 *    500-column header and 400 pipe-less rows took 6.8 s, 8,000 pipe-less rows
 *    of a 2-column table 4.5 s;
 *  - a list nested by tabs after a `>` marker, 500 levels in 64 KB: 10.2 s;
 *  - 21,000 paragraphs, 16,000 headings, line breaks or code spans: 2.2–3.0 s;
 *  - 9,000 email autolinks: 1.5 s.
 *
 * Descriptions are written by agents as well as people, so no single text may
 * take its page down or keep it busy. `assessMarkdown` is one linear pass run
 * before parsing. It counts what the parser will build — each element once,
 * by its kind — and estimates the render cost from per-element costs measured
 * in jsdom ({@link ELEMENT_COST_MS}). A text whose estimate exceeds
 * {@link MAX_ESTIMATED_RENDER_MS}, or that breaks a hard cap
 * ({@link BLOCK_CAPS}, nesting, table width), is shown as escaped plain text
 * with a note instead (see `MarkdownContent`). Every input at a limit renders
 * well under 500 ms in jsdom — pinned by `MarkdownContent.budget.unit.spec.tsx`,
 * numbers in the PR #3137 body.
 *
 * Top-level code fences are not counted beyond their characters (their lines
 * become one text node); they are read strictly, so a line the parser does NOT
 * treat as code is never skipped.
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

/** Columns of one table (every row is padded to the header's width). */
export const MAX_TABLE_COLUMNS = 50;

export interface MarkdownCounts {
    /** Non-blank lines outside code fences. */
    lines: number;
    /** Blocks: paragraphs, headings, rules, list items, quotes, tables, fences. */
    blocks: number;
    /** List-item markers. */
    listItems: number;
    /** The sum of every line's nesting: the parser re-checks each open container per line. */
    nestingWork: number;
    /** Table cells as the parser builds them: rows × the header's column count. */
    tableCells: number;
    /** Rows of the longest table (the per-row cost grows with the row count). */
    tableRows: number;
    /** `*`, `_`, `~`: emphasis delimiters. */
    emphasis: number;
    /** Backtick runs: two make a code span. */
    codeTicks: number;
    /** `[`: link, image and footnote openers. */
    brackets: number;
    /** `![`: images. */
    images: number;
    /** `://`, `www.`, `mailto:` and `name@host`: links and autolinks. */
    links: number;
    /** `<`: raw HTML and autolink openers. */
    angles: number;
}

/** Hard caps for descriptions, whatever the estimate says. */
export const BLOCK_CAPS: MarkdownCounts = {
    lines: 2_000,
    blocks: 1_000,
    listItems: 500,
    nestingWork: 6_000,
    tableCells: 1_500,
    tableRows: 300,
    emphasis: 2_000,
    codeTicks: 1_000,
    brackets: 500,
    images: 100,
    links: 400,
    angles: 8_000,
};

/**
 * Measured render cost of one element in jsdom, in milliseconds (client
 * render, development machine). Each element is counted once, by its most
 * specific kind: a list-item line costs `listItem`, not also `line` and
 * `block`; a table row costs `tableRow` plus `tableCell` per column.
 */
export const ELEMENT_COST_MS = {
    character: 0.0025,
    line: 0.25,
    block: 0.3,
    listItem: 0.45,
    nesting: 0.012,
    tableRow: 0.4,
    tableCell: 0.15,
    emphasis: 0.12,
    codeTick: 0.06,
    bracket: 0.3,
    image: 0.4,
    link: 0.33,
    angle: 0.03,
} as const;

/** The estimate a description may reach. */
export const MAX_ESTIMATED_RENDER_MS = 450;

export type MarkdownLimitReason =
    | 'length'
    | 'nesting'
    | 'tableColumns'
    | 'estimatedCost'
    | keyof MarkdownCounts;

export type MarkdownAssessment =
    | { render: true; estimatedMs: number }
    | { render: false; reason: MarkdownLimitReason };

function isSpace(char: string | undefined): boolean {
    return char === ' ' || char === '\t';
}

function isDigit(char: string | undefined): boolean {
    return char !== undefined && char >= '0' && char <= '9';
}

function isAlnum(char: string | undefined): boolean {
    if (char === undefined) return false;
    const code = char.charCodeAt(0);
    return (
        (code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        code > 0x7f
    );
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

interface LinePrefix {
    depth: number;
    listItems: number;
    /** Index of the first character after the container prefix. */
    contentStart: number;
    /** The line opens with `>` or a list marker. */
    container: boolean;
}

/**
 * The container prefix of one line. Every whitespace column counts — before
 * the first marker and after any — except the one space each marker needs;
 * tabs advance to the next multiple of four, as the parser expands them.
 */
function linePrefix(text: string, start: number, end: number): LinePrefix {
    let column = 0;
    let whitespace = 0;
    let markers = 0;
    let listItems = 0;
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
            listItems++;
            column++;
            i++;
            continue;
        }
        if (isDigit(char)) {
            let j = i;
            while (j - i < 9 && isDigit(text[j])) j++;
            if ((text[j] === '.' || text[j] === ')') && (j + 1 >= end || isSpace(text[j + 1]))) {
                markers++;
                listItems++;
                column += j + 1 - i;
                i = j + 1;
                continue;
            }
        }
        const indentation = Math.max(0, whitespace - markers);
        return {
            depth: markers + Math.floor(indentation / 2),
            listItems,
            contentStart: i,
            container: markers > 0,
        };
    }
}

/** `| --- | :-: |`, `-|-`: only `|`, `:`, `-` and spaces, with a `-`. */
function isDelimiterRow(text: string, start: number, end: number): boolean {
    let dash = false;
    for (let i = start; i < end; i++) {
        const char = text[i];
        if (char === '-') dash = true;
        else if (char !== '|' && char !== ':' && !isSpace(char) && char !== '\r') return false;
    }
    return dash;
}

/** Cells a table row splits into (an upper bound: every `|` is counted). */
function rowCells(pipes: number, text: string, start: number, end: number): number {
    let first = start;
    while (first < end && isSpace(text[first])) first++;
    let last = end - 1;
    while (last >= first && (isSpace(text[last]) || text[last] === '\r')) last--;
    let cells = pipes + 1;
    if (text[first] === '|') cells--;
    if (last > first && text[last] === '|') cells--;
    return Math.max(1, cells);
}

function emptyCounts(): MarkdownCounts {
    return {
        lines: 0,
        blocks: 0,
        listItems: 0,
        nestingWork: 0,
        tableCells: 0,
        tableRows: 0,
        emphasis: 0,
        codeTicks: 0,
        brackets: 0,
        images: 0,
        links: 0,
        angles: 0,
    };
}

interface AssessOptions {
    caps: MarkdownCounts;
    maxLength: number;
    maxEstimatedMs: number;
    /** `false` for the inline parser, which builds no blocks, tables or fences. */
    blockConstructs: boolean;
}

function assess(content: string, options: AssessOptions): MarkdownAssessment {
    const { caps, maxLength, maxEstimatedMs, blockConstructs } = options;
    if (content.length > maxLength) return { render: false, reason: 'length' };

    const W = ELEMENT_COST_MS;
    const counts = emptyCounts();
    // Cost of the structure (lines, blocks, items, rows, cells, nesting); the
    // inline elements are priced from their counts at each check.
    let structureMs = content.length * W.character;
    let fence: Fence | null = null;
    let previousBlank = true;
    let previousPipes = 0;
    let previousStart = 0;
    let previousEnd = 0;
    let tableColumns = 0; // > 0 while inside a table
    let tableRows = 0;

    for (let lineStart = 0; lineStart <= content.length; ) {
        let lineEnd = content.indexOf('\n', lineStart);
        if (lineEnd < 0) lineEnd = content.length;

        if (fence) {
            if (fenceCloses(content, lineStart, lineEnd, fence)) fence = null;
            lineStart = lineEnd + 1;
            continue;
        }
        if (blockConstructs && (fence = fenceOpens(content, lineStart, lineEnd))) {
            counts.blocks++;
            structureMs += W.block;
            tableColumns = 0;
            previousBlank = false;
            previousPipes = 0;
            lineStart = lineEnd + 1;
            continue;
        }

        let blank = true;
        let pipes = 0;
        for (let i = lineStart; i < lineEnd; i++) {
            const char = content[i];
            if (blank && !isSpace(char) && char !== '\r') blank = false;
            if (char === '*' || char === '_' || char === '~') counts.emphasis++;
            else if (char === '`') {
                if (content[i - 1] !== '`') counts.codeTicks++;
            } else if (char === '[') {
                counts.brackets++;
                if (content[i - 1] === '!') counts.images++;
            } else if (char === '|') pipes++;
            else if (char === '<') counts.angles++;
            else if (char === ':' && content[i + 1] === '/' && content[i + 2] === '/')
                counts.links++;
            else if (char === 'w' && content.startsWith('ww.', i + 1)) counts.links++;
            else if (char === 'm' && content.startsWith('ailto:', i + 1)) counts.links++;
            else if (char === '@' && isAlnum(content[i - 1]) && isAlnum(content[i + 1]))
                counts.links++;
        }

        if (blank) {
            previousBlank = true;
            previousPipes = 0;
            tableColumns = 0;
            lineStart = lineEnd + 1;
            continue;
        }

        counts.lines++;
        if (!blockConstructs) {
            structureMs += W.line;
        } else {
            const prefix = linePrefix(content, lineStart, lineEnd);
            if (prefix.depth > MAX_MARKDOWN_NESTING) return { render: false, reason: 'nesting' };
            counts.nestingWork += prefix.depth;
            counts.listItems += prefix.listItems;
            structureMs += prefix.depth * W.nesting;

            // GFM tables: a header row, a delimiter row, then EVERY following
            // line up to a blank line or another block is a row — with or
            // without a pipe — padded to the header's width.
            const heading = content[prefix.contentStart] === '#';
            if (
                tableColumns > 0 &&
                (prefix.container || heading || fenceRun(content, prefix.contentStart, lineEnd, 3))
            ) {
                tableColumns = 0;
            }
            if (tableColumns > 0) {
                tableRows++;
                counts.tableRows = Math.max(counts.tableRows, tableRows);
                counts.tableCells += tableColumns;
                structureMs += W.tableRow + tableColumns * W.tableCell;
            } else if (
                !previousBlank &&
                (pipes > 0 || previousPipes > 0) &&
                isDelimiterRow(content, lineStart, lineEnd)
            ) {
                const header = rowCells(previousPipes, content, previousStart, previousEnd);
                tableColumns = Math.max(header, rowCells(pipes, content, lineStart, lineEnd));
                if (tableColumns > MAX_TABLE_COLUMNS)
                    return { render: false, reason: 'tableColumns' };
                tableRows = 0;
                counts.blocks++;
                counts.tableCells += tableColumns; // the header row
                structureMs += W.tableRow + tableColumns * W.tableCell;
            } else if (prefix.listItems > 0) {
                counts.blocks += prefix.listItems;
                structureMs += prefix.listItems * W.listItem;
            } else if (previousBlank || prefix.container || heading) {
                counts.blocks++;
                structureMs += W.block;
            } else {
                structureMs += W.line;
            }
        }

        for (const key of Object.keys(caps) as Array<keyof MarkdownCounts>) {
            if (counts[key] > caps[key]) return { render: false, reason: key };
        }
        const estimatedMs =
            structureMs +
            counts.emphasis * W.emphasis +
            counts.codeTicks * W.codeTick +
            counts.brackets * W.bracket +
            counts.images * W.image +
            counts.links * W.link +
            counts.angles * W.angle;
        if (estimatedMs > maxEstimatedMs) return { render: false, reason: 'estimatedCost' };

        previousBlank = false;
        previousPipes = pipes;
        previousStart = lineStart;
        previousEnd = lineEnd;
        lineStart = lineEnd + 1;
    }

    const estimatedMs =
        structureMs +
        counts.emphasis * W.emphasis +
        counts.codeTicks * W.codeTick +
        counts.brackets * W.bracket +
        counts.images * W.image +
        counts.links * W.link +
        counts.angles * W.angle;
    return { render: true, estimatedMs };
}

/** One linear pass: may this description go through the (block) Markdown parser? */
export function assessMarkdown(content: string): MarkdownAssessment {
    return assess(content, {
        caps: BLOCK_CAPS,
        maxLength: MAX_MARKDOWN_LENGTH,
        maxEstimatedMs: MAX_ESTIMATED_RENDER_MS,
        blockConstructs: true,
    });
}

/** Characters of one inline field (a DoD criterion: the API allows 500). */
export const MAX_INLINE_MARKDOWN_LENGTH = 1_000;

/**
 * Inline fields render many to a page (a Goal has up to 50 criteria), so each
 * may reach only a small estimate: 50 at the limit stay well under a second.
 */
export const MAX_INLINE_ESTIMATED_RENDER_MS = 12;

/** Hard caps for one inline field. */
export const INLINE_CAPS: MarkdownCounts = {
    lines: 20,
    blocks: Number.POSITIVE_INFINITY,
    listItems: Number.POSITIVE_INFINITY,
    nestingWork: Number.POSITIVE_INFINITY,
    tableCells: Number.POSITIVE_INFINITY,
    tableRows: Number.POSITIVE_INFINITY,
    emphasis: 100,
    codeTicks: 40,
    brackets: 40,
    images: 10,
    links: 20,
    angles: 200,
};

/**
 * The same pass for one inline field. Block constructs are switched off in the
 * inline parser, so nesting, tables and fences cost nothing there and are not
 * counted.
 */
export function assessInlineMarkdown(content: string): MarkdownAssessment {
    return assess(content, {
        caps: INLINE_CAPS,
        maxLength: MAX_INLINE_MARKDOWN_LENGTH,
        maxEstimatedMs: MAX_INLINE_ESTIMATED_RENDER_MS,
        blockConstructs: false,
    });
}
