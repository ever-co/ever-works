import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCERPT_LENGTH, markdownExcerpt, markdownToPlainText } from './markdown-excerpt';

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
