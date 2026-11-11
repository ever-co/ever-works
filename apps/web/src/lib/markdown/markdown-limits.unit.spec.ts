import { describe, expect, it } from 'vitest';
import {
    BLOCK_CAPS,
    INLINE_CAPS,
    MAX_INLINE_MARKDOWN_LENGTH,
    MAX_MARKDOWN_LENGTH,
    MAX_MARKDOWN_NESTING,
    MAX_TABLE_COLUMNS,
    assessInlineMarkdown,
    assessMarkdown,
} from './markdown-limits';

const reason = (md: string) => {
    const verdict = assessMarkdown(md);
    return verdict.render ? 'render' : verdict.reason;
};
const inlineReason = (md: string) => {
    const verdict = assessInlineMarkdown(md);
    return verdict.render ? 'render' : verdict.reason;
};
const header = (cols: number) => 'a|'.repeat(cols - 1) + 'a\n' + '-|'.repeat(cols - 1) + '-\n';

describe('assessMarkdown — what it counts', () => {
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

    it('counts table rows WITHOUT pipes, padded to the header width', () => {
        // One row per line until a blank line, pipes or not.
        expect(reason('a|b\n-|-\n' + 'x\n'.repeat(BLOCK_CAPS.tableRows))).toBe('render');
        expect(reason('a|b\n-|-\n' + 'x\n'.repeat(BLOCK_CAPS.tableRows + 1))).toBe('tableRows');
        // 50 columns × 30 rows (with the header) = the cell cap; one more row is over it.
        expect(reason(header(50) + 'x\n'.repeat(29))).toBe('render');
        expect(reason(header(50) + 'x\n'.repeat(30))).toBe('tableCells');
        expect(reason(header(MAX_TABLE_COLUMNS + 1) + 'x')).toBe('tableColumns');
        // A blank line ends the table: two short tables are fine.
        const short = 'a|b\n-|-\n' + 'x\n'.repeat(200);
        expect(reason(short + '\n' + short)).toBe('render');
    });

    it('counts every autolink form as a link', () => {
        for (const unit of [
            'a@b.co ',
            '<a@b.co> ',
            'mailto:x ',
            'www.x.test ',
            'https://x.test ',
        ]) {
            expect(reason(unit.repeat(BLOCK_CAPS.links + 1))).toBe('links');
        }
    });

    it.each([
        ['lines', 'a  \n'.repeat(BLOCK_CAPS.lines + 1)],
        ['blocks', 'x\n\n'.repeat(BLOCK_CAPS.blocks + 1)],
        ['listItems', '- x\n'.repeat(BLOCK_CAPS.listItems + 1)],
        ['emphasis', '*a'.repeat(BLOCK_CAPS.emphasis + 1)],
        ['codeTicks', '`a` '.repeat(BLOCK_CAPS.codeTicks / 2 + 1)],
        ['brackets', '[a]('.repeat(BLOCK_CAPS.brackets + 1)],
        ['images', '![a](u) '.repeat(BLOCK_CAPS.images + 1)],
    ])('refuses a text over the %s cap', (expected, md) => {
        // Caps and the estimate can both apply; either refuses.
        expect(['estimatedCost', expected]).toContain(reason(md));
    });

    it('refuses a mix of constructs whose estimated cost is over the budget', () => {
        const mix = (n: number) =>
            [
                '# a\n'.repeat(n),
                '- x\n'.repeat(n),
                '*a'.repeat(n),
                '\n\n' + 'a@b.co '.repeat(n),
            ].join('\n');
        expect(reason(mix(100))).toBe('render');
        expect(reason(mix(400))).toBe('estimatedCost');
    });
});

describe('assessMarkdown — real descriptions', () => {
    it('renders a structured 10,000-character description', () => {
        const md = (
            '## Section\n\nSome **bold** text with `code` and a [link](https://x.test).\n\n' +
            '- item one\n- item two\n  - nested\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n'
        )
            .repeat(80)
            .slice(0, 10000);
        expect(reason(md)).toBe('render');
    });

    it('does not count what is inside a top-level code fence', () => {
        const code =
            '```py\n' +
            ('    '.repeat(20) + 'x = a_b * c_d ** 2  # [1] | y\n').repeat(200) +
            '```\n';
        expect(reason(code + '\nAfter the code.')).toBe('render');
    });

    it('never skips lines the parser does not treat as code', () => {
        expect(reason('```a`\n' + '- '.repeat(2000) + 'x')).toBe('nesting');
        expect(reason('    ```\n' + '- '.repeat(2000) + 'x')).toBe('nesting');
        expect(reason('```\n~~~\n```\n' + '- '.repeat(2000) + 'x')).toBe('nesting');
    });
});

describe('assessInlineMarkdown', () => {
    it('caps one field at its own length and small inline budgets', () => {
        expect(inlineReason('a'.repeat(MAX_INLINE_MARKDOWN_LENGTH))).toBe('render');
        expect(inlineReason('a'.repeat(MAX_INLINE_MARKDOWN_LENGTH + 1))).toBe('length');
        expect(['emphasis', 'estimatedCost']).toContain(
            inlineReason('*a'.repeat(INLINE_CAPS.emphasis + 1)),
        );
        expect(['links', 'estimatedCost']).toContain(
            inlineReason('a@b.co '.repeat(INLINE_CAPS.links + 1)),
        );
        expect(inlineReason('a\n'.repeat(INLINE_CAPS.lines + 1))).toBe('lines');
    });

    it('does not count block constructs, which the inline parser never builds', () => {
        expect(inlineReason('- '.repeat(200) + 'x')).toBe('render');
        expect(inlineReason((header(100) + 'x\n'.repeat(15)).slice(0, 900))).toBe('render');
    });
});
