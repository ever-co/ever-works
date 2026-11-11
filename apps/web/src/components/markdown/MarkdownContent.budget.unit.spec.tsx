import { beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { MarkdownContent, MarkdownInline } from './MarkdownContent';
import { assessInlineMarkdown, assessMarkdown } from '@/lib/markdown/markdown-limits';

/**
 * PR #3137, review B1 and its closure check: no description may keep its page
 * busy. Every input either renders as Markdown in under {@link BUDGET_MS}
 * (jsdom, client render) or is refused by the pre-check and shown as plain
 * text — never something in between.
 *
 * The inputs are the reviewer's bypasses (pipe-less table rows, wide tables,
 * nesting after a quote marker, tabs, email autolinks, many small elements)
 * and, for every construct the pre-check counts, the largest text it accepts,
 * one step smaller, and one step larger. The sizes are found by asking the
 * pre-check itself, so the suite follows the budgets if they change.
 */

const BUDGET_MS = 500;
const GOAL_PAGE_BUDGET_MS = 1000;

type Generator = (n: number) => string;

const header = (cols: number) => 'a|'.repeat(cols - 1) + 'a\n' + '-|'.repeat(cols - 1) + '-\n';
const lines = (n: number, line: (k: number) => string) =>
    Array.from({ length: n }, (_, k) => line(k)).join('\n');

/** The largest `n` whose text the pre-check accepts (0 when none). */
function largestAccepted(generate: Generator, accepts: (md: string) => boolean): number {
    let low = 0;
    let high = 1;
    while (accepts(generate(high)) && high < 1 << 20) high *= 2;
    while (high - low > 1) {
        const middle = (low + high) >> 1;
        if (accepts(generate(middle))) low = middle;
        else high = middle;
    }
    return low;
}

function renderBlock(md: string): { ms: number; fallback: boolean } {
    const started = performance.now();
    const { container } = render(<MarkdownContent content={md} />);
    const ms = performance.now() - started;
    const fallback = container.querySelector('[data-markdown-fallback]') !== null;
    cleanup();
    return { ms, fallback };
}

beforeAll(() => {
    // The first render pays for loading the parser; time the inputs, not that.
    renderBlock(
        '# warm up\n\n- a **b** `c` [d](https://x.test)\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    );
    render(<MarkdownInline content="warm *up*" />);
    cleanup();
});

describe('the review bypasses: refused, or rendered within budget', () => {
    const BYPASSES: Array<[string, string]> = [
        ['8,000 pipe-less rows of a 2-column table', 'a|b\n-|-\n' + 'x\n'.repeat(8000)],
        ['1,000 pipe-less rows of a 2-column table', 'a|b\n-|-\n' + 'x\n'.repeat(1000)],
        ['a 500-column header and 400 pipe-less rows', header(500) + 'x\n'.repeat(400)],
        ['a 100-column header and 60 pipe-less rows', header(100) + 'x\n'.repeat(60)],
        [
            'a list nested by spaces after a quote marker',
            lines(250, (k) => '> ' + ' '.repeat(2 * k) + '- x'),
        ],
        [
            'a list nested by tabs after a quote marker',
            lines(500, (k) => '>' + '\t'.repeat(Math.floor(k / 2)) + (k % 2 ? '  ' : '') + '- x'),
        ],
        ['21,000 paragraphs', 'x\n\n'.repeat(21000)],
        ['16,000 headings', '# a\n'.repeat(16000)],
        ['16,000 hard line breaks', 'a  \n'.repeat(16000)],
        ['16,000 code spans', '`a` '.repeat(16000)],
        ['12,000 rules', '---\n\n'.repeat(12000)],
        ['9,000 email autolinks', 'a@b.co '.repeat(9000)],
        ['7,000 angle-bracket email autolinks', '<a@b.co> '.repeat(7000)],
        ['4,000 mailto autolinks', 'mailto:a@b.co '.repeat(4000)],
        ['8,000 "<a b=" openers', '<a b="'.repeat(8000)],
        ['16,000 "<!--" openers', '<!--'.repeat(16000)],
        ['the original 2,000 nested bullets', '- '.repeat(2000) + 'x'],
    ];

    it.each(BYPASSES)('%s', (_name, md) => {
        const { ms, fallback } = renderBlock(md);
        expect(ms).toBeLessThan(BUDGET_MS);
        expect(fallback).toBe(!assessMarkdown(md).render);
    });
});

const CONSTRUCTS: Array<[string, Generator]> = [
    [
        'prose paragraphs',
        (n) => 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n\n'.repeat(n),
    ],
    ['plain characters', (n) => 'a'.repeat(n)],
    ['paragraphs', (n) => 'x\n\n'.repeat(n)],
    ['headings', (n) => '# a\n'.repeat(n)],
    ['rules', (n) => '---\n\n'.repeat(n)],
    ['hard line breaks', (n) => 'a  \n'.repeat(n)],
    ['flat list items', (n) => '- x\n'.repeat(n)],
    ['ordered list items', (n) => '1. x\n'.repeat(n)],
    ['nested lists, 10 levels a line', (n) => ('- '.repeat(10) + 'x\n').repeat(n)],
    ['quotes 30 deep', (n) => lines(n, () => '> '.repeat(30) + 'x')],
    ['a quote with a list indented 30 deep', (n) => lines(n, () => '> ' + ' '.repeat(56) + '- x')],
    [
        'a tab-indented ladder after a quote',
        (n) => lines(n, (k) => '>' + '\t'.repeat(Math.floor(k / 2)) + (k % 2 ? '  ' : '') + '- x'),
    ],
    ['a space-indented ladder', (n) => lines(n, (k) => ' '.repeat(2 * Math.min(k, 30)) + '- x')],
    ['emphasis', (n) => '*a'.repeat(n)],
    ['nested emphasis', (n) => '*'.repeat(n) + 'a' + '*'.repeat(n)],
    ['code spans', (n) => '`a` '.repeat(n)],
    ['link openers', (n) => '[a]('.repeat(n)],
    ['nested links', (n) => '['.repeat(n) + 'a' + '](u)'.repeat(n)],
    ['nested images', (n) => '!['.repeat(n) + 'a' + '](u)'.repeat(n)],
    ['Markdown links', (n) => '[a](https://x.test) '.repeat(n)],
    ['URL autolinks', (n) => 'https://x.test '.repeat(n)],
    ['www autolinks', (n) => 'www.x.test '.repeat(n)],
    ['email autolinks', (n) => 'a@b.co '.repeat(n)],
    ['angle-bracket email autolinks', (n) => '<a@b.co> '.repeat(n)],
    ['mailto autolinks', (n) => 'mailto:a@b.co '.repeat(n)],
    ['raw HTML openers', (n) => '<a b="'.repeat(n)],
    ['pipe-less table rows, 2 columns', (n) => 'a|b\n-|-\n' + 'x\n'.repeat(n)],
    ['piped table rows, 2 columns', (n) => '| a | b |\n|---|---|\n' + '| x | y |\n'.repeat(n)],
    ['pipe-less table rows, 50 columns', (n) => header(50) + 'x\n'.repeat(n)],
    ['piped table rows, 50 columns', (n) => header(50) + ('b|'.repeat(49) + 'b\n').repeat(n)],
    ['table columns', (n) => header(n) + 'x\n'],
    ['entities', (n) => '&amp;'.repeat(n)],
    [
        'mixed constructs',
        (n) =>
            [
                '# a\n'.repeat(n),
                '- x\n'.repeat(n),
                '*a'.repeat(n),
                '\n\n' + 'a@b.co '.repeat(n),
                '\n\na|b\n-|-\n' + 'x\n'.repeat(n),
            ].join('\n'),
    ],
    [
        'structured sections',
        (n) =>
            (
                '## Section\n\nSome **bold** text with `code` and a [link](https://x.test).\n\n' +
                '- item one\n- item two\n  - nested\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n'
            ).repeat(n),
    ],
];

describe('each construct at, just under and just over its limit', () => {
    it.each(CONSTRUCTS)('%s', (_name, generate) => {
        const limit = largestAccepted(generate, (md) => assessMarkdown(md).render);
        expect(limit).toBeGreaterThan(0);

        for (const n of [limit - 1, limit].filter((value) => value > 0)) {
            const { ms, fallback } = renderBlock(generate(n));
            expect(fallback).toBe(false);
            expect(ms).toBeLessThan(BUDGET_MS);
        }

        const over = renderBlock(generate(limit + 1));
        expect(over.fallback).toBe(true);
        expect(over.ms).toBeLessThan(BUDGET_MS);
    });

    it('a real 10,000-character description renders as Markdown', () => {
        const md = (
            '## Section\n\nSome **bold** text with `code` and a [link](https://x.test).\n\n' +
            '- item one\n- item two\n  - nested\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n'
        )
            .repeat(80)
            .slice(0, 10000);
        const { ms, fallback } = renderBlock(md);
        expect(fallback).toBe(false);
        expect(ms).toBeLessThan(BUDGET_MS);
    });
});

const INLINE_CONSTRUCTS: Array<[string, Generator]> = [
    ['emphasis', (n) => '*a'.repeat(n)],
    ['nested emphasis', (n) => '*'.repeat(n) + 'a' + '*'.repeat(n)],
    ['code spans', (n) => '`a` '.repeat(n)],
    ['Markdown links', (n) => '[a](https://x.test) '.repeat(n)],
    ['email autolinks', (n) => 'a@b.co '.repeat(n)],
    ['link openers', (n) => '[a]('.repeat(n)],
    ['hard line breaks', (n) => 'a  \n'.repeat(n)],
    ['plain words', (n) => 'word '.repeat(n)],
    // The review's case: a wide pipe-less table written into a criterion.
    ['a wide table', (n) => (header(100) + 'x\n'.repeat(60)).slice(0, n)],
];

describe('a Goal page: 50 Definition-of-Done criteria at the inline limit', () => {
    it.each(INLINE_CONSTRUCTS)('%s', (_name, generate) => {
        const limit = largestAccepted(generate, (md) => assessInlineMarkdown(md).render);
        expect(limit).toBeGreaterThan(0);
        const criterion = generate(limit);

        const started = performance.now();
        const { container } = render(
            <ul>
                {Array.from({ length: 50 }, (_, i) => (
                    <li key={i}>
                        {/* memo() is per instance: each of the 50 parses its own text. */}
                        <MarkdownInline content={criterion} />
                    </li>
                ))}
            </ul>,
        );
        const ms = performance.now() - started;
        expect(container.querySelectorAll('[data-markdown-fallback]')).toHaveLength(0);
        expect(container.querySelector('table,ul ul,blockquote,pre,h1,h2,h3')).toBeNull();
        cleanup();
        expect(ms).toBeLessThan(GOAL_PAGE_BUDGET_MS);

        // One step over the limit: plain text, never parsed.
        const over = render(<MarkdownInline content={generate(limit + 1)} />);
        expect(over.container.querySelector('[data-markdown-fallback]')).not.toBeNull();
        cleanup();
    });
});
