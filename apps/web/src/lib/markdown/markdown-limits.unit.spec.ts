import { describe, expect, it } from 'vitest';
import {
    MAX_EMPHASIS_DELIMITERS,
    MAX_IMAGES,
    MAX_LINKS,
    MAX_LINK_BRACKETS,
    MAX_LIST_ITEMS,
    MAX_MARKDOWN_LENGTH,
    MAX_MARKDOWN_NESTING,
    MAX_TABLE_PIPES,
    assessMarkdown,
} from './markdown-limits';

const reason = (md: string) => {
    const verdict = assessMarkdown(md);
    return verdict.render ? 'render' : verdict.reason;
};

describe('assessMarkdown — the inputs that crashed or stalled the parser', () => {
    it.each([
        ['2,000 nested bullets', '- '.repeat(2000) + 'x'],
        ['2,000 nested numbered items', '1. '.repeat(2000) + 'x'],
        ['4,000 nested quotes', '>'.repeat(4000) + ' x'],
        ['quotes with spaces', '> '.repeat(4000) + 'x'],
    ])('refuses %s, in a few milliseconds', (_name, md) => {
        const started = performance.now();
        expect(reason(md)).toBe('nesting');
        expect(performance.now() - started).toBeLessThan(50);
    });

    it('refuses more than 64 KB', () => {
        expect(reason('a'.repeat(MAX_MARKDOWN_LENGTH))).toBe('render');
        expect(reason('a'.repeat(MAX_MARKDOWN_LENGTH + 1))).toBe('length');
    });

    it('refuses deep nesting by indentation, not only by markers', () => {
        const lines = Array.from({ length: 40 }, (_, i) => ' '.repeat(2 * i) + '- x');
        expect(reason(lines.join('\n'))).toBe('nesting');
    });

    it('allows exactly the nesting limit', () => {
        expect(reason('- '.repeat(MAX_MARKDOWN_NESTING) + 'x')).toBe('render');
        expect(reason('- '.repeat(MAX_MARKDOWN_NESTING + 1) + 'x')).toBe('nesting');
    });

    it.each([
        ['listItems', '- x\n'.repeat(MAX_LIST_ITEMS + 1)],
        ['emphasis', '*a'.repeat(MAX_EMPHASIS_DELIMITERS + 1)],
        ['brackets', '[a]('.repeat(MAX_LINK_BRACKETS + 1)],
        ['images', '![a](u) '.repeat(MAX_IMAGES + 1)],
        ['tables', '| a |\n|---|\n' + '| x |\n'.repeat(MAX_TABLE_PIPES / 2)],
        ['links', 'see https://x.test '.repeat(MAX_LINKS + 1)],
    ])('refuses a text over the %s budget', (expected, md) => {
        expect(reason(md)).toBe(expected);
    });
});

describe('assessMarkdown — real descriptions', () => {
    it('renders a structured 10,000-character description', () => {
        const md = (
            '## Section\n\nSome **bold** text with `code` and a [link](https://x.test).\n\n' +
            '- item one\n- item two\n  - nested\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n'
        )
            .repeat(60)
            .slice(0, 10000);
        expect(reason(md)).toBe('render');
    });

    it('does not count what is inside a top-level code fence', () => {
        const code =
            '```py\n' + '    '.repeat(20) + 'x = a_b * c_d ** 2  # [1]\n'.repeat(500) + '```\n';
        expect(reason(code + '\nAfter the code.')).toBe('render');
    });

    it('never skips lines the parser does not treat as code', () => {
        // "```a`" is not a fence opener (a backtick in a backtick fence's info
        // string), so the deep list after it must still be counted.
        expect(reason('```a`\n' + '- '.repeat(2000) + 'x')).toBe('nesting');
        // Indented four spaces at the top level: indented code, not a fence.
        expect(reason('    ```\n' + '- '.repeat(2000) + 'x')).toBe('nesting');
        // A tilde line does not close a backtick fence.
        expect(reason('```\n~~~\n```\n' + '- '.repeat(2000) + 'x')).toBe('nesting');
    });
});
