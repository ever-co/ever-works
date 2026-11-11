import { beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { MarkdownContent, MarkdownInline, assessMarkdownRender } from './MarkdownContent';

/** Text pre-check + parse + exact tree walk, as the component does (no HTML step). */
const acceptsBlock = (md: string) => assessMarkdownRender(md, 'block').render;
const acceptsInline = (md: string) => assessMarkdownRender(md, 'inline').render;

/**
 * PR #3137, review B1 and its closure check: no description may keep its page
 * busy. Every input either renders as Markdown in under {@link BUDGET_MS}
 * (jsdom, client render) or is refused by the pre-check and shown as plain
 * text — never something in between.
 *
 * The inputs are the reviewer's bypasses from both closure checks (pipe-less
 * table rows, wide tables, tables ended "by eye" by a line the parser keeps
 * as a row, tables inside quotes and list items, nesting after a quote
 * marker, tabs, email autolinks, many small elements) and, for every
 * construct, the largest text the renderer accepts, one step smaller, and one
 * step larger. The sizes are found by asking the renderer's own pre-check,
 * parse and tree walk, so the suite follows the budgets if they change.
 */

const BUDGET_MS = 500;
const GOAL_PAGE_BUDGET_MS = 1000;

type Generator = (n: number) => string;

const cols = (n: number) => 'a|'.repeat(n - 1) + 'a';
const delim = (n: number) => '-|'.repeat(n - 1) + '-';
const header = (n: number) => `${cols(n)}\n${delim(n)}\n`;
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

function renderOnce(md: string): { ms: number; fallback: boolean } {
    const started = performance.now();
    const { container } = render(<MarkdownContent content={md} />);
    const ms = performance.now() - started;
    const fallback = container.querySelector('[data-markdown-fallback]') !== null;
    cleanup();
    return { ms, fallback };
}

/**
 * The better of two renders: the bound must hold, but one garbage-collection
 * pause or a busy CI neighbour must not decide the run.
 */
function renderBlock(md: string): { ms: number; fallback: boolean } {
    const first = renderOnce(md);
    if (first.ms < BUDGET_MS) return first;
    const second = renderOnce(md);
    return second.ms < first.ms ? second : first;
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
        // Second closure check: the table goes on where a text guess ends it.
        [
            '50 columns, a "```x`" line, then 1,700 pipe-less rows',
            `${header(50)}\`\`\`x\`\n` + 'x\n'.repeat(1700),
        ],
        [
            '50 columns, a "#x" line, then 1,700 pipe-less rows',
            `${header(50)}#x\n` + 'x\n'.repeat(1700),
        ],
        [
            'a 500-column table inside a quote, 200 rows',
            `> ${cols(500)}\n> ${delim(500)}\n` + '> x\n'.repeat(200),
        ],
        [
            'a 50-column table inside a quote, 300 rows',
            `> ${cols(50)}\n> ${delim(50)}\n` + '> x\n'.repeat(300),
        ],
        ['1,000 headings', '# a\n'.repeat(1000)],
    ];

    it.each(BYPASSES)('%s', (_name, md) => {
        const { ms, fallback } = renderBlock(md);
        expect(ms).toBeLessThan(BUDGET_MS);
        expect(fallback).toBe(!acceptsBlock(md));
    });
});

/**
 * Third closure check: a fence the parser opens INSIDE a container (here after
 * `- a`) used to make the text pre-check stop counting until a closing fence
 * it never saw. The pre-check now counts every line; these are the reviewer's
 * seven payloads behind every kind of fence prefix.
 */
const FENCE_PREFIXES: Array<[string, string]> = [
    ['a list item, fence indented 3 spaces (the review)', '- a\n   ```\n'],
    ['a list item, fence indented 2 spaces', '- a\n  ```\n'],
    ['a list item, fence indented 1 space', '- a\n ```\n'],
    ['a list item, a ~~~ fence', '- a\n   ~~~\n'],
    ['a nested list item', '- a\n  - b\n     ```\n'],
    ['a quote', '> a\n> ```\n'],
    ['an unclosed top-level fence', '```\n'],
    ['a fence opened with more backticks than it is closed with', '````\n```\n'],
];

const tabbedQuoteList = (n: number) => {
    let s = '';
    for (let k = 0; k < n; k++)
        s += '>' + '\t'.repeat(Math.floor(k / 2)) + (k % 2 ? '  ' : '') + '- x\n';
    return s;
};

const FENCE_PAYLOADS: Array<[string, string]> = [
    ['8,000 piped table rows (16.7 s in the review)', 'a|b\n-|-\n' + 'x|y\n'.repeat(8000)],
    ['32 KB of "*a" (6.3 s)', '*a'.repeat(16000)],
    ['4,000 nested list levels (12.7 s)', '- '.repeat(4000) + 'x'],
    ['2,000 nested list levels (3.2 s)', '- '.repeat(2000) + 'x'],
    ['2,000 nested images (rendered in 9.8 s)', '!['.repeat(2000) + 'a' + '](b)'.repeat(2000)],
    ['1,000 nested images (2.1 s)', '!['.repeat(1000) + 'a' + '](b)'.repeat(1000)],
    ['a tab-nested list in a quote, 300 levels (2.8 s)', tabbedQuoteList(300)],
];

const FENCE_CASES: Array<[string, string]> = FENCE_PREFIXES.flatMap(([where, prefix]) =>
    FENCE_PAYLOADS.map(([what, payload]): [string, string] => [
        `${what} behind ${where}`,
        (prefix + payload).slice(0, 32 * 1024),
    ]),
);

describe('a fence opened inside a container hides nothing from the pre-check', () => {
    it.each(FENCE_CASES)('%s', (_name, md) => {
        const { ms, fallback } = renderBlock(md);
        expect(ms).toBeLessThan(BUDGET_MS);
        expect(fallback).toBe(!acceptsBlock(md));
        // None of these may render as Markdown.
        expect(fallback).toBe(true);
    });

    it('a description with large real code blocks still renders as Markdown', () => {
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
        const prose = 'We migrate the export job to the new queue and keep the old one running. ';
        const md = `## Plan\n\n${prose.repeat(5)}\n\n\`\`\`python\n${python}\n\`\`\`\n\n${prose.repeat(3)}\n\n\`\`\`tsx\n${tsx}\n\`\`\`\n`;
        const { ms, fallback } = renderBlock(md);
        expect(fallback).toBe(false);
        expect(ms).toBeLessThan(BUDGET_MS);
    });
});

/** Lines that look like they end a table but that the parser keeps as rows. */
const ROW_LINES: Array<[string, string]> = [
    ['"```x`" (not a fence)', '```x`'],
    ['"#x" (not a heading)', '#x'],
    ['"-x" (not a list item)', '-x'],
    ['"1.x" (not a list item)', '1.x'],
    ['"***x" (not a rule)', '***x'],
    ['"[r]: x" (not a definition here)', '[r]: x'],
    ['"<b>x</b>" (inline HTML)', '<b>x</b>'],
    ['"    x" (indented)', '    x'],
    ['"|" (a lone pipe)', '|'],
    ['plain text', 'x'],
];

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
    [
        'a 50-column table inside a quote',
        (n) => `> ${cols(50)}\n> ${delim(50)}\n` + '> x\n'.repeat(n),
    ],
    [
        'a 50-column table inside a list item',
        (n) => `- ${cols(50)}\n  ${delim(50)}\n` + '  x\n'.repeat(n),
    ],
    [
        'a 50-column table in a quote in a list item',
        (n) => `- > ${cols(50)}\n  > ${delim(50)}\n` + '  > x\n'.repeat(n),
    ],
    [
        'uneven rows wider than the header',
        (n) => 'a|b\n-|-\n' + ('c|'.repeat(39) + 'c\n').repeat(n),
    ],
    ['uneven rows narrower than the header', (n) => header(40) + 'c|d\n'.repeat(n)],
    ['many small tables (5 × 5 each)', (n) => (header(5) + 'x|y\n'.repeat(4) + '\n').repeat(n)],
    ...ROW_LINES.map(([kind, line]): [string, Generator] => [
        `a 50-column table continued by ${kind} lines`,
        (n) => header(50) + `${line}\n`.repeat(n),
    ]),
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
        const limit = largestAccepted(generate, acceptsBlock);
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

    it('a full 10,000-character Mission description renders as Markdown', () => {
        // Sections of prose, lists, code and a table: the Mission/Goal maximum.
        const prose =
            'We grow weekly signups through the onboarding funnel, measured on the **activation** ' +
            'dashboard, and ship each change behind a flag so `pnpm test` stays green. ';
        const section = (k: number) =>
            `## Step ${k}\n\n${prose.repeat(2)}\n\n` +
            `- audit the [signup page](https://x.test/${k})\n- fix the *slowest* step\n- measure again\n\n` +
            (k % 4 === 0
                ? '| Metric | Target |\n| --- | ---: |\n| Signups | +20% |\n| Churn | -5% |\n\n'
                : '');
        let md = '';
        for (let k = 1; md.length < 10000; k++) md += section(k);
        md = md.slice(0, 10000);
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
        const limit = largestAccepted(generate, acceptsInline);
        expect(limit).toBeGreaterThan(0);
        const criterion = generate(limit);

        const renderPage = () => {
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
            return ms;
        };
        // The better of two pages, for the same reason as renderBlock.
        const first = renderPage();
        const ms = first < GOAL_PAGE_BUDGET_MS ? first : Math.min(first, renderPage());
        expect(ms).toBeLessThan(GOAL_PAGE_BUDGET_MS);

        // One step over the limit: plain text, never parsed.
        const over = render(<MarkdownInline content={generate(limit + 1)} />);
        expect(over.container.querySelector('[data-markdown-fallback]')).not.toBeNull();
        cleanup();
    });
});
