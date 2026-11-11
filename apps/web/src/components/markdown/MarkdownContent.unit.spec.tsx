import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { MarkdownContent, MarkdownInline } from './MarkdownContent';

function renderMd(content: string) {
    return render(<MarkdownContent content={content} data-testid="md" />).getByTestId('md');
}

describe('MarkdownContent — GFM', () => {
    it('renders bullet, numbered and task lists', () => {
        const root = renderMd('- one\n- two\n\n1. first\n2. second\n\n- [x] done\n- [ ] open');
        expect(root.querySelectorAll('ul')).toHaveLength(2);
        expect(root.querySelector('ol')?.querySelectorAll('li')).toHaveLength(2);
        const boxes = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
        expect(boxes).toHaveLength(2);
        expect(boxes[0].checked).toBe(true);
        expect(boxes[1].checked).toBe(false);
        expect(boxes[0].disabled).toBe(true);
    });

    it('renders inline and fenced code', () => {
        const root = renderMd('Run `pnpm test` now.\n\n```ts\nconst x = 1;\n```');
        expect(root.querySelector('p code')?.textContent).toBe('pnpm test');
        const block = root.querySelector('pre code');
        expect(block?.textContent).toBe('const x = 1;\n');
        expect(block?.className).toContain('language-ts');
    });

    it('renders a table inside a horizontal scroller', () => {
        const root = renderMd('| Metric | Target |\n| --- | ---: |\n| Signups | +20% |');
        const table = root.querySelector('table');
        expect(table).not.toBeNull();
        expect(table?.parentElement?.className).toContain('overflow-x-auto');
        expect(Array.from(root.querySelectorAll('th')).map((th) => th.textContent)).toEqual([
            'Metric',
            'Target',
        ]);
        expect(root.querySelector('td')?.textContent).toBe('Signups');
    });

    it('demotes headings two levels below the page outline', () => {
        const root = renderMd('# Big\n\n## Medium\n\n### Small');
        expect(root.querySelector('h1')).toBeNull();
        expect(root.querySelector('h2')).toBeNull();
        expect(root.querySelector('h3')?.textContent).toBe('Big');
        expect(root.querySelector('h4')?.textContent).toBe('Medium');
        expect(root.querySelector('h5')?.textContent).toBe('Small');
    });

    it('opens external links in a new tab with noopener noreferrer and keeps internal ones in place', () => {
        const root = renderMd('[docs](https://ever.works/docs) and [mission](/missions/m1)');
        const [external, internal] = Array.from(root.querySelectorAll('a'));
        expect(external.getAttribute('href')).toBe('https://ever.works/docs');
        expect(external.getAttribute('target')).toBe('_blank');
        expect(external.getAttribute('rel')).toBe('noopener noreferrer');
        expect(internal.getAttribute('href')).toBe('/missions/m1');
        expect(internal.hasAttribute('target')).toBe(false);
    });
});

describe('MarkdownContent — sanitization', () => {
    it('never renders a <script> element', () => {
        const root = renderMd(
            'Before\n\n<script>alert("x")</script>\n\nAfter <script>alert(1)</script>',
        );
        expect(root.querySelector('script')).toBeNull();
        expect(root.textContent).toContain('Before');
        expect(root.textContent).toContain('After');
    });

    it('drops raw <img onerror> and other event-handler HTML', () => {
        const root = renderMd(
            'x <img src="x" onerror="alert(1)"> y\n\n<div onclick="alert(1)" style="color:red">z</div>\n\n<iframe src="https://evil.test"></iframe>',
        );
        expect(root.querySelector('img')).toBeNull();
        expect(root.querySelector('iframe')).toBeNull();
        expect(root.querySelector('[onerror],[onclick],[style]')).toBeNull();
        expect(root.innerHTML).not.toContain('onerror');
        expect(root.innerHTML).not.toContain('alert(1)');
    });

    it.each([
        '[click](javascript:alert(1))',
        '[click](JAVASCRIPT:alert(1))',
        '[click](vbscript:msgbox(1))',
        '[click](data:text/html,hi)',
        '[click](//evil.test)',
        '<javascript:alert(1)>',
    ])('renders %j as text, never a javascript:/data: link', (source) => {
        const root = renderMd(source);
        for (const anchor of Array.from(root.querySelectorAll('a'))) {
            const href = anchor.getAttribute('href') ?? '';
            expect(href).not.toMatch(/^\s*(javascript|vbscript|data):/i);
            expect(href.startsWith('//')).toBe(false);
        }
        expect(root.innerHTML.toLowerCase()).not.toContain('href="javascript');
    });

    it('keeps a refused link label as plain text', () => {
        const root = renderMd('[click me](javascript:alert(1))');
        expect(root.querySelector('a')).toBeNull();
        expect(root.textContent).toBe('click me');
    });

    it('loads https images lazily without a referrer and refuses others', () => {
        const root = renderMd(
            '![ok](https://cdn.test/a.png) ![bad](javascript:alert(1)) ![plain](http://cdn.test/b.png)',
        );
        const images = root.querySelectorAll('img');
        expect(images).toHaveLength(1);
        expect(images[0].getAttribute('src')).toBe('https://cdn.test/a.png');
        expect(images[0].getAttribute('loading')).toBe('lazy');
        expect(images[0].getAttribute('referrerpolicy')).toBe('no-referrer');
        expect(root.textContent).toContain('bad');
        expect(root.textContent).toContain('plain');
    });
});

describe('MarkdownInline', () => {
    it('renders inline formatting and unwraps block syntax', () => {
        const { container } = render(
            <MarkdownInline
                content={'# Ship **pricing** with `three` tiers\n- [docs](https://x.test)'}
            />,
        );
        expect(container.querySelector('h1,h3,ul,li,p')).toBeNull();
        expect(container.querySelector('strong')?.textContent).toBe('pricing');
        expect(container.querySelector('code')?.textContent).toBe('three');
        expect(container.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('drops raw HTML', () => {
        const { container } = render(
            <MarkdownInline content={'a <img src=x onerror=alert(1)> b'} />,
        );
        expect(container.querySelector('img')).toBeNull();
        expect(container.textContent).toContain('a');
    });
});

describe('MarkdownContent — never throws, never stalls (PR #3137 review B1)', () => {
    const CRASHERS: Array<[string, string]> = [
        ['2,000 nested bullets', '- '.repeat(2000) + 'x'],
        ['2,000 nested numbered items', '1. '.repeat(2000) + 'x'],
        ['4,000 nested quotes', '>'.repeat(4000) + ' x'],
    ];

    it.each(CRASHERS)(
        '%s: shows the text as plain text with a note, quickly, on the client',
        (_name, md) => {
            const started = performance.now();
            const root = renderMd(md);
            expect(performance.now() - started).toBeLessThan(200);
            const fallback = root.querySelector('[data-markdown-fallback]');
            expect(fallback).not.toBeNull();
            expect(fallback?.textContent).toContain('plainTextFallback');
            expect(root.querySelector('pre')?.textContent).toBe(md);
            expect(root.querySelector('ul,ol,blockquote')).toBeNull();
        },
    );

    it.each(CRASHERS)('%s: renders on the server without throwing', (_name, md) => {
        const started = performance.now();
        const html = renderToString(<MarkdownContent content={md} />);
        expect(performance.now() - started).toBeLessThan(200);
        expect(html).toContain('data-markdown-fallback');
    });

    it('MarkdownInline falls back to the plain text too', () => {
        const md = '>'.repeat(4000) + ' x';
        const { container } = render(<MarkdownInline content={md} />);
        expect(container.querySelector('[data-markdown-fallback]')?.textContent).toBe(md);
    });

    it('still renders a normal document as Markdown', () => {
        const root = renderMd('## Plan\n\n- **one**\n- two\n\n> quoted');
        expect(root.querySelector('[data-markdown-fallback]')).toBeNull();
        expect(root.querySelector('h4')?.textContent).toBe('Plan');
        expect(root.querySelectorAll('li')).toHaveLength(2);
        expect(root.querySelector('blockquote')).not.toBeNull();
    });
});

describe('MarkdownContent — footnotes', () => {
    const MD = 'Claim[^1] and another[^note].\n\n[^1]: The source.\n[^note]: More.';

    // rehype-sanitize is the ONLY step that namespaces ids (remark-rehype's own
    // prefix is off): without it the ids would be `fn-1` and this test fails.
    it('namespaces footnote ids once, and the links point at them', () => {
        const root = renderMd(MD);
        const refs = Array.from(root.querySelectorAll<HTMLAnchorElement>('sup a'));
        expect(refs).toHaveLength(2);
        for (const ref of refs) {
            const target = ref.getAttribute('href') ?? '';
            expect(target).toMatch(/^#user-content-fn-/);
            expect(target).not.toContain('user-content-user-content');
            expect(root.querySelector(`[id="${target.slice(1)}"]`)).not.toBeNull();
        }
        const back = root.querySelector<HTMLAnchorElement>('a[data-footnote-backref]');
        const backTarget = back?.getAttribute('href') ?? '';
        expect(backTarget).toMatch(/^#user-content-fnref-/);
        expect(root.querySelector(`[id="${backTarget.slice(1)}"]`)).not.toBeNull();
        for (const element of Array.from(root.querySelectorAll('[id]'))) {
            expect(element.id.startsWith('user-content-')).toBe(true);
            expect(element.id.startsWith('user-content-user-content-')).toBe(false);
        }
    });

    it('drops footnotes from an inline field instead of leaking "Footnotes" and "↩"', () => {
        const { container } = render(<MarkdownInline content={MD} />);
        expect(container.textContent).not.toContain('Footnotes');
        expect(container.textContent).not.toContain('↩');
        expect(container.querySelector('sup,section')).toBeNull();
        expect(container.textContent).toContain('Claim and another');
    });
});
