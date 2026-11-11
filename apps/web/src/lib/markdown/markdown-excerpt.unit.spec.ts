import { describe, expect, it } from 'vitest';
import {
    DEFAULT_EXCERPT_LENGTH,
    EXCERPT_INPUT_LIMIT,
    graphemes,
    graphemesFallback,
    markdownExcerpt,
    markdownToPlainText,
} from './markdown-excerpt';
import { expectLinearTime } from '@/lib/__tests__/time-budget';

const MISSION = `## Goal

Grow **weekly signups** by 20% through the _onboarding_ funnel.

### Steps
1. Audit the \`/signup\` flow
2. Ship [the new pricing page](https://example.com/pricing)
- [ ] Measure conversion
- [x] Set up tracking

| Metric | Target |
| --- | ---: |
| Signups | +20% |

> Keep the free tier.

---

\`\`\`ts
const x = 1;
\`\`\`
`;

describe('markdownToPlainText', () => {
    it('answers an empty string for nothing', () => {
        expect(markdownToPlainText(undefined)).toBe('');
        expect(markdownToPlainText(null)).toBe('');
        expect(markdownToPlainText('   \n\n ')).toBe('');
    });

    it('strips headings, emphasis, lists, task boxes, links, code, tables, quotes and rules', () => {
        const text = markdownToPlainText(MISSION);
        expect(text).toBe(
            'Goal. Grow weekly signups by 20% through the onboarding funnel. Steps. ' +
                'Audit the /signup flow. Ship the new pricing page. Measure conversion. ' +
                'Set up tracking. Metric · Target. Signups · +20%. Keep the free tier. const x = 1;',
        );
        for (const leaked of ['##', '**', '](', '`', '- [', '| ---', '>', '---']) {
            expect(text).not.toContain(leaked);
        }
    });

    it('keeps one line: no newlines, collapsed whitespace', () => {
        const text = markdownToPlainText('one\n\n\ntwo   three\r\nfour');
        expect(text).toBe('one. two three four');
        expect(text).not.toMatch(/\s{2,}|\n/);
    });

    it('keeps the text of raw HTML but not its tags', () => {
        expect(markdownToPlainText('Hi <script>alert(1)</script> <b>there</b>')).toBe(
            'Hi alert(1) there',
        );
        expect(markdownToPlainText('<img src=x onerror="alert(1)">Done')).toBe('Done');
    });

    it('keeps image alt text, autolinks and ordinary underscores / asterisks', () => {
        expect(markdownToPlainText('![diagram](https://x.test/a.png) see <https://x.test>')).toBe(
            'diagram see https://x.test',
        );
        expect(markdownToPlainText('rename snake_case_name and compute 2 * 3 * 4')).toBe(
            'rename snake_case_name and compute 2 * 3 * 4',
        );
    });

    it('decodes the common HTML entities as text', () => {
        expect(markdownToPlainText('Tom &amp; Jerry &lt;3')).toBe('Tom & Jerry <3');
    });
});

describe('markdownExcerpt', () => {
    it('returns short text unchanged', () => {
        expect(markdownExcerpt('**Ship** it')).toBe('Ship it');
    });

    it('caps at the default length on a word boundary with an ellipsis', () => {
        const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
        const excerpt = markdownExcerpt(long);
        expect(Array.from(excerpt).length).toBeLessThanOrEqual(DEFAULT_EXCERPT_LENGTH);
        expect(excerpt.endsWith('…')).toBe(true);
        // Cut between words, never inside one.
        expect(excerpt.slice(0, -1)).toMatch(/word\d+$/);
    });

    it('honours a custom cap and never splits an emoji', () => {
        const excerpt = markdownExcerpt('🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀', 5);
        expect(Array.from(excerpt)).toHaveLength(5);
        expect(excerpt).toBe('🚀🚀🚀🚀…');
    });

    it('excerpts a structured description without leaking markup', () => {
        const excerpt = markdownExcerpt(MISSION, 60);
        expect(excerpt).toBe('Goal. Grow weekly signups by 20% through the onboarding…');
    });
});

describe('markdownToPlainText — cost (PR #3137 review B2)', () => {
    // Before the fix a 64 KB line of `[` took 11.5 s on every render of the Task list.
    // Linear from 256 characters to 1 MB, not a wall-clock budget ("1 MB in under
    // 50 ms" failed on a busy CI runner with nothing wrong): see `expectLinearTime`.
    // No costlier path past the 4 KB cap: growth stays under 1.5× on every step,
    // idle or under load, so the bound is tighter than the default.
    const maxGrowth = 4;
    it.each([
        '[',
        '](',
        '`',
        '*',
        '_',
        '<',
        '!',
        '![',
        '[a](',
        '<a',
        '**a ',
        '~~a ',
        '``a',
        '\\',
        '<!--',
        '|',
    ])('1 MB of %j takes linear time (one line and many lines)', (unit) => {
        const oneLine = (size: number) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
        const manyLines = (size: number) =>
            (unit.repeat(200) + '\n')
                .repeat(Math.ceil(size / (unit.length * 200 + 1)))
                .slice(0, size);
        for (const build of [oneLine, manyLines]) {
            expectLinearTime(
                build,
                (input) => [markdownToPlainText(input), markdownExcerpt(input)],
                { maxGrowth },
            );
        }
    });

    it(`reads only the first ${EXCERPT_INPUT_LIMIT} characters`, () => {
        const text = 'a '.repeat(EXCERPT_INPUT_LIMIT) + 'TAIL';
        expect(markdownToPlainText(text)).not.toContain('TAIL');
    });
});

describe('markdownToPlainText — the cases the review found', () => {
    it.each([
        [
            'a line starting with inline triple-backtick code is not a fence',
            '```npm i``` first\n\n## Next\n\n**Bold** [l](https://x.test)',
            'npm i first. Next. Bold l',
        ],
        [
            'a fence indented inside a list item',
            '- item\n\n    ```\n    code\n    ```\n\n**after**',
            'item. code. after',
        ],
        ['`~~~` inside a backtick fence is content', '```\n~~~\n```\n**after**', '~~~ after'],
        ['a URL with parentheses', '[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) baz', 'Foo baz'],
        ['nested brackets in a link label', '[a [b] c](https://x.test) tail', 'a [b] c tail'],
        ['a multi-line HTML comment', 'a <!--\nhidden\n--> b', 'a b'],
        [
            'a link label with inline code',
            'Run [`pnpm test`](https://x.test) now',
            'Run pnpm test now',
        ],
        ['nested links', '[[x](https://a.test)](https://b.test)', 'x'],
        ['an image inside a link', '[![logo](https://x.test/a.png)](https://x.test)', 'logo'],
        ['a reference link and its definition', '[x][r] y\n\n[r]: https://x.test', 'x y.'],
        ['a footnote reference and its definition', 'Text[^1]\n\n[^1]: The note', 'Text.'],
        [
            'escaped markup stays literal',
            '\\*not bold\\* and \\[not a link\\](x)',
            '*not bold* and [not a link](x)',
        ],
        ['emphasis inside code is kept', 'use `**kwargs` and `a_b_c`', 'use **kwargs and a_b_c'],
        ['an unclosed emphasis stays literal', '5* rating and **open', '5* rating and **open'],
        ['tags split by a tag', '<scr<b>ipt>alert(1)</script>', '<scr ipt>alert(1)'],
        ['an indented setext underline', 'Title\n  ===\nBody', 'Title. Body'],
    ])('%s', (_name, md, expected) => {
        expect(markdownToPlainText(md)).toBe(expected);
    });
});

describe('markdownExcerpt — grapheme-safe truncation', () => {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    const clusters = (text: string) => Array.from(segmenter.segment(text), (part) => part.segment);

    it.each([
        ['an emoji family (ZWJ sequence)', 'ab ' + '👨‍👩‍👧‍👦'.repeat(40)],
        ['flags (regional-indicator pairs)', 'ab ' + '🇫🇷🇩🇪'.repeat(40)],
        ['skin tones', 'ab ' + '👍🏽'.repeat(60)],
        ['combining marks', 'ab ' + 'é'.repeat(200)],
        ['plain astral emoji', 'ab ' + '🚀'.repeat(60)],
    ])('never cuts %s', (_name, md) => {
        const source = new Set(clusters(md));
        for (let max = 2; max <= 14; max++) {
            const excerpt = markdownExcerpt(md, max);
            expect(clusters(excerpt).length).toBeLessThanOrEqual(max);
            const body = excerpt.endsWith('…') ? excerpt.slice(0, -1) : excerpt;
            for (const cluster of clusters(body)) expect(source.has(cluster)).toBe(true);
        }
    });

    it('max = 1 answers at most one grapheme', () => {
        expect(markdownExcerpt('hello world', 1)).toBe('…');
        expect(clusters(markdownExcerpt('👨‍👩‍👧‍👦👨‍👩‍👧‍👦', 1))).toHaveLength(1);
        expect(markdownExcerpt('h', 1)).toBe('h');
    });

    it('the fallback without Intl.Segmenter keeps the same clusters together', () => {
        for (const sample of ['👨‍👩‍👧‍👦👍🏽', '🇫🇷🇩🇪🇮🇹', 'éä', '❤️🚀', 'abc']) {
            expect(graphemesFallback(sample)).toEqual(clusters(sample));
        }
        expect(graphemes('🇫🇷🇩🇪')).toEqual(['🇫🇷', '🇩🇪']);
    });
});
