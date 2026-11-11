import { describe, expect, it } from 'vitest';
import {
    BLOCK_TEXT_CAPS,
    INLINE_TEXT_CAPS,
    MAX_INLINE_MARKDOWN_LENGTH,
    MAX_MARKDOWN_LENGTH,
    MAX_MARKDOWN_NESTING,
    assessInlineMarkdownText,
    assessMarkdownText,
    normalizeLineEndings,
} from './markdown-limits';

const reason = (md: string) => {
    const verdict = assessMarkdownText(md);
    return verdict.render ? 'render' : verdict.reason;
};
const inlineReason = (md: string) => {
    const verdict = assessInlineMarkdownText(md);
    return verdict.render ? 'render' : verdict.reason;
};
const header = (cols: number) => 'a|'.repeat(cols - 1) + 'a\n' + '-|'.repeat(cols - 1) + '-\n';

/**
 * The text pre-check bounds what the PARSE costs or could break; what the
 * parser BUILDS is budgeted on the tree (markdown-tree-budget.unit.spec.ts).
 */
describe('assessMarkdownText', () => {
    it('refuses the original crash inputs, in a few milliseconds', () => {
        for (const md of [
            '- '.repeat(2000) + 'x',
            '1. '.repeat(2000) + 'x',
            '>'.repeat(4000) + ' x',
        ]) {
            const started = performance.now();
            expect(reason(md)).toBe('nesting');
            expect(performance.now() - started).toBeLessThan(50);
        }
    });

    it('caps the length', () => {
        expect(reason('a'.repeat(MAX_MARKDOWN_LENGTH))).toBe('render');
        expect(reason('a'.repeat(MAX_MARKDOWN_LENGTH + 1))).toBe('length');
    });

    it('counts nesting by markers, by indentation, after a quote marker, and with tabs expanded', () => {
        expect(reason('- '.repeat(MAX_MARKDOWN_NESTING) + 'x')).toBe('render');
        expect(reason('- '.repeat(MAX_MARKDOWN_NESTING + 1) + 'x')).toBe('nesting');
        expect(reason(' '.repeat(2 * MAX_MARKDOWN_NESTING) + '- x')).toBe('nesting');
        expect(reason('> ' + ' '.repeat(2 * MAX_MARKDOWN_NESTING) + '- x')).toBe('nesting');
        // 17 tabs after ">" are 66 columns: 33 levels.
        expect(reason('>' + '\t'.repeat(17) + '- x')).toBe('nesting');
    });

    it('bounds the table parse: every line after a delimiter-like row up to a blank line may be a row', () => {
        // The reviewer's bypasses end the table early "by eye"; the bound does not care.
        const rows = (first: string) =>
            header(50) + first + '\n' + 'x\n'.repeat(BLOCK_TEXT_CAPS.tableRows);
        for (const first of ['```x`', '#x', '-x', '>x', 'x'])
            expect(reason(rows(first))).toBe('tableRows');
        // Inside a quote or a list item too.
        expect(reason('> a|b\n> -|-\n' + '> x\n'.repeat(BLOCK_TEXT_CAPS.tableRows))).toBe(
            'tableRows',
        );
        expect(reason('- a|b\n  -|-\n' + '  x\n'.repeat(BLOCK_TEXT_CAPS.tableRows))).toBe(
            'tableRows',
        );
        // A blank line ends a table: short tables apart are fine.
        expect(reason(('a|b\n-|-\n' + 'x\n'.repeat(100) + '\n').repeat(5))).toBe('render');
        // Pipes on table lines.
        expect(reason(header(BLOCK_TEXT_CAPS.tablePipes / 2 + 10) + 'x')).toBe('tablePipes');
    });

    it.each([
        ['lines', 'x\n\n'.repeat(BLOCK_TEXT_CAPS.lines + 1)],
        ['emphasis', '*a'.repeat(BLOCK_TEXT_CAPS.emphasis + 1)],
        ['codeTicks', '`a` '.repeat(BLOCK_TEXT_CAPS.codeTicks / 2 + 1)],
        ['brackets', '[a]('.repeat(BLOCK_TEXT_CAPS.brackets + 1)],
        ['images', '![a](u) '.repeat(BLOCK_TEXT_CAPS.images + 1)],
        ['angles', '<a '.repeat(BLOCK_TEXT_CAPS.angles + 1)],
    ])('refuses a text over the %s cap', (expected, md) => {
        expect(reason(md)).toBe(expected);
    });

    it('never skips a code block: its lines are counted like any other (third closure check)', () => {
        // Inside a fence, deep indentation still counts as nesting.
        const code = '```py\n' + ('    '.repeat(20) + 'x = 1\n').repeat(10) + '```\n';
        expect(reason(code)).toBe('nesting');
        // A "fence" opened inside a list item hides nothing either.
        const hidden = (prefix: string) =>
            prefix + 'a|b\n-|-\n' + 'x|y\n'.repeat(BLOCK_TEXT_CAPS.tableRows);
        for (const prefix of [
            '- a\n   ```\n',
            '- a\n  ```\n',
            '- a\n ```\n',
            '- a\n   ~~~\n',
            '- a\n  - b\n     ```\n',
            '> a\n> ```\n',
            '```\n',
            '````\n```\n',
        ]) {
            expect(reason(hidden(prefix))).toBe('tableRows');
            expect(reason(prefix + '- '.repeat(MAX_MARKDOWN_NESTING + 1) + 'x')).toBe('nesting');
            expect(reason(prefix + '*a'.repeat(BLOCK_TEXT_CAPS.emphasis + 1))).toBe('emphasis');
        }
    });

    it('ends lines at "\\r" and "\\r\\n" as the parser does (fourth closure check)', () => {
        expect(reason('a|b\r-|-\r' + 'x|y\r'.repeat(BLOCK_TEXT_CAPS.tableRows))).toBe('tableRows');
        expect(reason('x\r' + '- '.repeat(MAX_MARKDOWN_NESTING + 1) + 'x')).toBe('nesting');
        expect(reason('x\r\n' + '- '.repeat(MAX_MARKDOWN_NESTING + 1) + 'x')).toBe('nesting');
        expect(normalizeLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
        // U+2028 / U+2029 are not line endings for the parser: left alone.
        expect(normalizeLineEndings('a\u2028b\u2029c')).toBe('a\u2028b\u2029c');
    });

    it('passes descriptions with large real code blocks', () => {
        const python = Array.from(
            { length: 150 },
            (_, k) =>
                `${'    '.repeat(k % 4)}result_${k} = compute(item_${k}, factor=2 * k)  # step [${k}]`,
        ).join('\n');
        const tsx = Array.from(
            { length: 120 },
            (_, k) =>
                `${'  '.repeat(k % 6)}<Item key={${k}} value={items[${k}]} onClick={() => select(${k})} />`,
        ).join('\n');
        const json = Array.from(
            { length: 400 },
            (_, k) => `${'  '.repeat(1 + (k % 8))}"key_${k}": [${k}, "<value_${k}>"],`,
        ).join('\n');
        expect(
            reason('## Plan\n\n```python\n' + python + '\n```\n\n```tsx\n' + tsx + '\n```\n'),
        ).toBe('render');
        expect(reason('```json\n' + json + '\n```\n')).toBe('render');
    });

    it('never skips lines the parser does not treat as code', () => {
        expect(reason('```a`\n' + '- '.repeat(2000) + 'x')).toBe('nesting');
        expect(reason('    ```\n' + '- '.repeat(2000) + 'x')).toBe('nesting');
        expect(reason('```\n~~~\n```\n' + '- '.repeat(2000) + 'x')).toBe('nesting');
    });

    it('passes a structured 10,000-character description', () => {
        const md = (
            '## Section\n\nSome **bold** text with `code` and a [link](https://x.test).\n\n' +
            '- item one\n- item two\n  - nested\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n'
        )
            .repeat(80)
            .slice(0, 10000);
        expect(reason(md)).toBe('render');
    });
});

describe('assessInlineMarkdownText', () => {
    it('caps one field at its own length and small inline budgets', () => {
        expect(inlineReason('a'.repeat(MAX_INLINE_MARKDOWN_LENGTH))).toBe('render');
        expect(inlineReason('a'.repeat(MAX_INLINE_MARKDOWN_LENGTH + 1))).toBe('length');
        expect(inlineReason('*a'.repeat(INLINE_TEXT_CAPS.emphasis + 1))).toBe('emphasis');
        expect(inlineReason('a\n'.repeat(INLINE_TEXT_CAPS.lines + 1))).toBe('lines');
    });

    it('does not count block constructs, which the inline parser never builds', () => {
        expect(inlineReason('- '.repeat(200) + 'x')).toBe('render');
        expect(inlineReason((header(100) + 'x\n'.repeat(15)).slice(0, 900))).toBe('render');
    });
});
