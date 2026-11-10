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
 * `markdownExcerpt` also caps the length on a word boundary. Both are pure,
 * dependency-free and safe on the server and the client. The output is plain
 * TEXT for React to escape, never HTML: raw tags are dropped from it, and
 * nothing here makes a string safe to inject with `dangerouslySetInnerHTML`.
 */

/** Default cap for card excerpts; cards clamp visually to 2–3 lines anyway. */
export const DEFAULT_EXCERPT_LENGTH = 200;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*\S+/;
/** `---`, `***`, `___` rules and `===` / `---` setext underlines. */
const RULE_OR_UNDERLINE = /^\s{0,3}([-*_=])(?:\s*\1){2,}\s*$/;
/** GFM table delimiter row: `| --- | :-: |`. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/;
const ATX_HEADING = /^\s{0,3}#{1,6}(?:\s+|$)/;
const ATX_CLOSING = /\s+#+\s*$/;
const BLOCKQUOTE = /^\s*(?:>\s?)+/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TERMINAL_PUNCTUATION = /[.!?:;…]$/;

const ENTITIES: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
};

function stripInline(text: string): string {
    return (
        text
            // Autolinks keep their URL — before the tag strip, which would eat them.
            .replace(/<((?:https?|mailto):[^>\s]+)>/gi, '$1')
            // Raw HTML: comments and tags go, their text content stays.
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
            // Images keep their alt text, links their label.
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
            // Footnote references.
            .replace(/\[\^[^\]]+\]/g, '')
            // Inline code keeps its content.
            .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, '$2')
            // Bold, italic, strikethrough. `snake_case` and `2 * 3` survive:
            // a marker only counts next to a non-space on its inner side.
            .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
            .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1$2')
            .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2')
            .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
            // Backslash escapes.
            .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
            .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    );
}

/**
 * Strip a line's block marker and report whether the line was a block that
 * ends its own sentence (a heading, a list item, a table row).
 */
function stripBlockMarker(line: string): { text: string; endsSentence: boolean } {
    if (ATX_HEADING.test(line)) {
        return { text: line.replace(ATX_HEADING, '').replace(ATX_CLOSING, ''), endsSentence: true };
    }
    const unquoted = line.replace(BLOCKQUOTE, '');
    if (LIST_ITEM.test(unquoted)) {
        return { text: unquoted.replace(LIST_ITEM, ''), endsSentence: true };
    }
    if (TABLE_ROW.test(unquoted)) {
        const cells = unquoted
            .trim()
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((cell) => cell.trim())
            .filter(Boolean);
        return { text: cells.join(' · '), endsSentence: true };
    }
    return { text: unquoted, endsSentence: false };
}

function endSentence(fragment: string): string {
    return TERMINAL_PUNCTUATION.test(fragment) ? fragment : `${fragment}.`;
}

/**
 * The whole of a Markdown string as one line of plain text: markup removed,
 * headings / list items / table rows / paragraphs each ending a sentence,
 * whitespace collapsed. Fenced code keeps its content without the fences.
 */
export function markdownToPlainText(markdown: string | null | undefined): string {
    if (typeof markdown !== 'string' || markdown.trim().length === 0) return '';

    const fragments: string[] = [];
    let inFence = false;
    const terminateLast = () => {
        const last = fragments.length - 1;
        if (last >= 0) fragments[last] = endSentence(fragments[last]);
    };

    for (const rawLine of markdown.replace(/\r\n?/g, '\n').split('\n')) {
        if (FENCE.test(rawLine)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) {
            const code = rawLine.trim();
            if (code) fragments.push(code);
            continue;
        }
        if (rawLine.trim() === '') {
            // A blank line closes a paragraph.
            terminateLast();
            continue;
        }
        if (REFERENCE_DEFINITION.test(rawLine)) continue;
        if (RULE_OR_UNDERLINE.test(rawLine) || TABLE_DELIMITER.test(rawLine)) {
            terminateLast();
            continue;
        }

        const { text, endsSentence } = stripBlockMarker(rawLine);
        const plain = stripInline(text).replace(/\s+/g, ' ').trim();
        if (!plain) continue;
        if (endsSentence) terminateLast();
        fragments.push(endsSentence ? endSentence(plain) : plain);
    }

    return fragments.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * A one-line excerpt of a Markdown string, at most `maxLength` characters
 * (code points, so an emoji is never cut in half) including the trailing
 * ellipsis. Cuts on a word boundary when one is reasonably close.
 */
export function markdownExcerpt(
    markdown: string | null | undefined,
    maxLength: number = DEFAULT_EXCERPT_LENGTH,
): string {
    const text = markdownToPlainText(markdown);
    const limit = Math.max(1, Math.floor(maxLength));
    const chars = Array.from(text);
    if (chars.length <= limit) return text;

    const slice = chars.slice(0, Math.max(1, limit - 1)).join('');
    const lastSpace = slice.lastIndexOf(' ');
    const cut = lastSpace >= slice.length * 0.6 ? slice.slice(0, lastSpace) : slice;
    return `${cut.replace(/[\s.,;:!?·—–-]+$/u, '')}…`;
}
