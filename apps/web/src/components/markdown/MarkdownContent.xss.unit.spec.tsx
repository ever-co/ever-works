import { describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { MarkdownContent, MarkdownInline } from './MarkdownContent';
import { resolveMarkdownHref, resolveMarkdownImageSrc } from '@/lib/markdown/markdown-links';

/**
 * Hostile Markdown through `MarkdownContent` and `MarkdownInline`, from the
 * independent review of PR #3137 (141 cases, all passing there): the rendered
 * DOM may hold only safe tags, no event handlers, no inline styles, no `name`
 * attributes, only `user-content-`-prefixed ids, and URLs judged the way a
 * browser resolves them (WHATWG URL against an app origin).
 */

const APP = 'https://app.ever.test/en/missions/m1';
const APP_ORIGIN = new URL(APP).origin;

const PAYLOADS: Array<[string, string]> = [
    // raw HTML forms
    ['html-script-block', '<script>alert(1)</script>'],
    ['html-script-inline', 'a <script>alert(1)</script> b'],
    ['html-img-onerror', '<img src=x onerror=alert(1)>'],
    ['html-img-onerror-inline', 'x <img src=x onerror=alert(1)> y'],
    ['html-svg-onload', '<svg onload=alert(1)><circle r=1></svg>'],
    ['html-a-js', '<a href="javascript:alert(1)">x</a>'],
    ['html-iframe', '<iframe src="javascript:alert(1)"></iframe>'],
    ['html-details-ontoggle', '<details open ontoggle=alert(1)>x</details>'],
    ['html-comment-then-script', '<!-- c --><script>alert(1)</script>'],
    ['html-math-xlink', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>'],
    ['html-style', '<style>body{background:url(https://evil.test/p)}</style>'],
    ['html-in-list', '- <img src=x onerror=alert(1)>\n- b'],
    ['html-inline-b-onmouseover', 'a<b onmouseover=alert(1)>b</b>'],
    ['html-object', '<object data="javascript:alert(1)"></object>'],
    ['html-form-action', '<form action="javascript:alert(1)"><button>x</button></form>'],
    ['html-input-autofocus', '<input autofocus onfocus=alert(1)>'],
    ['html-base', '<base href="https://evil.test/">'],
    ['html-meta-refresh', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
    ['html-img-srcset', '<img srcset="javascript:alert(1) 1x" src="https://ok.test/a.png">'],
    ['html-cdata', '<![CDATA[<script>alert(1)</script>]]>'],
    ['html-in-table', '| a |\n| - |\n| <img src=x onerror=alert(1)> |'],
    ['html-in-blockquote', '> <iframe src=javascript:alert(1)>'],
    ['html-entity-encoded-tag', '&lt;img src=x onerror=alert(1)&gt;'],
    // javascript: links
    ['js-plain', '[x](javascript:alert(1))'],
    ['js-mixed-case', '[x](JaVaScRiPt:alert(1))'],
    ['js-leading-space', '[x]( javascript:alert(1))'],
    ['js-angle', '[x](<javascript:alert(1)>)'],
    ['js-entity-s', '[x](java&#115;cript:alert(1))'],
    ['js-entity-j', '[x](&#106;avascript:alert(1))'],
    ['js-entity-hex', '[x](&#x6A;avascript:alert(1))'],
    ['js-entity-colon', '[x](javascript&colon;alert(1))'],
    ['js-entity-tab', '[x](java&#x09;script:alert(1))'],
    ['js-entity-nl', '[x](java&#10;script:alert(1))'],
    ['js-literal-tab-angle', '[x](<java\tscript:alert(1)>)'],
    ['js-c0-prefix', '[x](\u0001javascript:alert(1))'],
    ['js-entity-c0-prefix', '[x](&#1;javascript:alert(1))'],
    ['js-nul', '[x](javascript\u0000:alert(1))'],
    ['js-zwsp', '[x](java\u200bscript:alert(1))'],
    ['js-zwnj-prefix', '[x](\u200cjavascript:alert(1))'],
    ['js-bom-prefix', '[x](\ufeffjavascript:alert(1))'],
    ['js-nbsp-prefix', '[x](\u00a0javascript:alert(1))'],
    ['js-percent', '[x](%6Aavascript:alert(1))'],
    ['js-comment-nl', '[x](javascript://%0aalert(1))'],
    ['js-title', '[x](javascript:alert(1) "t")'],
    ['vbscript', '[x](vbscript:msgbox(1))'],
    ['data-html', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['data-upper', '[x](DATA:text/html,hi)'],
    ['file', '[x](file:///etc/passwd)'],
    ['proto-relative', '[x](//evil.test)'],
    ['backslash-backslash', '[x](\\\\\\\\evil.test)'],
    ['slash-backslash', '[x](/\\\\evil.test)'],
    ['slash-tab-slash', '[x](</\t/evil.test>)'],
    ['slash-entity-tab-slash', '[x](/&#9;/evil.test)'],
    ['slash-entity-nl-slash', '[x](/&#10;/evil.test)'],
    ['userinfo', '[x](https://user:pass@evil.test)'],
    ['userinfo-lookalike', '[x](https://ever.works@evil.test/)'],
    ['https-no-slashes', '[x](https:evil.test)'],
    ['relative-word', '[x](evil.test)'],
    ['dot-slash', '[x](./a)'],
    ['dot-dot-slash', '[x](../../../../evil)'],
    ['hash', '[x](#javascript:alert(1))'],
    ['mailto', '[x](mailto:a@b.test?body=javascript:alert(1))'],
    ['mailto-js', '[x](mailto:javascript:alert(1))'],
    // autolinks
    ['autolink-js', '<javascript:alert(1)>'],
    ['autolink-js-upper', '<JAVASCRIPT:alert(1)>'],
    ['autolink-vbscript', '<vbscript:msgbox(1)>'],
    ['autolink-data', '<data:text/html,hi>'],
    ['autolink-email', '<a@evil.test>'],
    ['gfm-www', 'see www.evil.test now'],
    ['gfm-bare-js', 'javascript:alert(1)'],
    ['gfm-url-lt', 'https://evil.test/<script>alert(1)</script>'],
    // reference-style
    ['ref-link-js', '[x][r]\n\n[r]: javascript:alert(1)'],
    ['ref-link-js-angle', '[x][r]\n\n[r]: <javascript:alert(1)> "t"'],
    ['ref-image-js', '![x][r]\n\n[r]: javascript:alert(1)'],
    ['ref-collapsed', '[r][]\n\n[r]: data:text/html,hi'],
    ['ref-shortcut', '[r]\n\n[r]: //evil.test'],
    // footnotes / clobbering
    ['footnote-js', 'a[^1]\n\n[^1]: [x](javascript:alert(1))'],
    ['footnote-clobber', 'a[^location] b[^__proto__]\n\n[^location]: x\n[^__proto__]: y'],
    ['heading-clobber', '# location\n\n## document'],
    // nested markdown in link text
    ['nested-img-in-link', '[![i](javascript:alert(1))](javascript:alert(2))'],
    ['nested-link-in-link', '[[x](javascript:alert(1))](https://ok.test)'],
    ['link-in-image-alt', '![[x](javascript:alert(1))](https://ok.test/a.png)'],
    // images
    ['img-js', '![x](javascript:alert(1))'],
    ['img-data-svg', '![x](data:image/svg+xml,<svg onload=alert(1)>)'],
    ['img-svg-https', '![x](https://evil.test/x.svg)'],
    ['img-http', '![x](http://evil.test/x.png)'],
    ['img-proto-relative', '![x](//evil.test/x.png)'],
    ['img-slash-backslash', '![x](/\\\\evil.test/x.png)'],
    ['img-userinfo', '![x](https://u:p@evil.test/x.png)'],
    ['img-title-quote', '![x](https://ok.test/a.png "a\\" onerror=\\"alert(1)")'],
    ['img-c0', '![x](\u0001//evil.test/x.png)'],
    // misc
    ['code-fence-html', '```html\n<script>alert(1)</script>\n```'],
    ['code-class', '```x" onmouseover="alert(1)\ncode\n```'],
    ['task-list', '- [x] done\n- [ ] open'],
];

const SAFE_TAGS = new Set([
    'div',
    'span',
    'p',
    'a',
    'img',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'ul',
    'ol',
    'li',
    'strong',
    'em',
    'del',
    'code',
    'pre',
    'blockquote',
    'hr',
    'br',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'input',
    'sup',
    'section',
]);
const URL_ATTRS = new Set([
    'href',
    'src',
    'action',
    'formaction',
    'xlink:href',
    'srcset',
    'poster',
    'data',
    'background',
    'cite',
    'ping',
]);

function verdictForUrl(attr: string, value: string): string | null {
    let url: URL;
    try {
        url = new URL(value, APP);
    } catch {
        return `${attr} unparsable`;
    }
    if (attr === 'href') {
        if (url.protocol === 'mailto:') return null;
        if (url.protocol !== 'https:' && url.protocol !== 'http:')
            return `href scheme ${url.protocol}`;
        if (url.username || url.password) return 'href userinfo';
        // relative value must stay on the app origin
        const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value.trim());
        if (!absolute && url.origin !== APP_ORIGIN)
            return `relative href left origin -> ${url.origin}`;
        return null;
    }
    if (attr === 'src') {
        const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value.trim());
        if (!absolute)
            return url.origin === APP_ORIGIN ? null : `relative src left origin -> ${url.origin}`;
        if (url.protocol !== 'https:') return `src scheme ${url.protocol}`;
        if (url.username || url.password) return 'src userinfo';
        return null;
    }
    return `unexpected url attr ${attr}`;
}

function inspect(root: Element): string[] {
    const problems: string[] = [];
    for (const el of Array.from(root.querySelectorAll('*'))) {
        const tag = el.tagName.toLowerCase();
        if (!SAFE_TAGS.has(tag)) problems.push(`tag <${tag}>`);
        if (tag === 'input') {
            const input = el as HTMLInputElement;
            if (input.type !== 'checkbox' || !input.disabled)
                problems.push('enabled/non-checkbox input');
        }
        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            if (name.startsWith('on')) problems.push(`event attr ${name}`);
            if (name === 'style') problems.push('style attr');
            if (name === 'name') problems.push(`name attr ${attr.value}`);
            if (name === 'id' && !attr.value.startsWith('user-content-'))
                problems.push(`unprefixed id ${attr.value}`);
            if (URL_ATTRS.has(name)) {
                const v = verdictForUrl(name, attr.value);
                if (v) problems.push(`${v} [${attr.value}]`);
            }
        }
    }
    return problems;
}

describe('MarkdownContent — hostile Markdown', () => {
    it.each(PAYLOADS)('%s', (id, source) => {
        const block = render(<MarkdownContent content={source} data-testid="md" />);
        const blockProblems = inspect(block.getByTestId('md'));
        cleanup();
        const inline = render(<MarkdownInline content={source} data-testid="mi" />);
        const inlineProblems = inspect(inline.getByTestId('mi'));
        cleanup();
        expect({ id, blockProblems, inlineProblems }).toEqual({
            id,
            blockProblems: [],
            inlineProblems: [],
        });
    });
});

describe('URL policy functions, direct', () => {
    const HREFS = [
        'javascript:alert(1)',
        ' JAVASCRIPT:alert(1)',
        '\u0001javascript:alert(1)',
        '\u0000javascript:alert(1)',
        'java\tscript:alert(1)',
        'java\nscript:alert(1)',
        '\tjavascript:alert(1)',
        '/\t/evil.test',
        '/\n/evil.test',
        '/\r\\evil.test',
        '\\\\evil.test',
        '\\/evil.test',
        '/\\evil.test',
        '//evil.test',
        ' //evil.test',
        '\u0001//evil.test',
        '/\u0001/evil.test',
        'https://u:p@evil.test',
        'https://@evil.test',
        'https://:@evil.test',
        'http:\\\\evil.test',
        'https:/evil.test',
        'mailto:x',
        'mailto:',
        'MAILTO:a@b',
        'data:text/html,x',
        'vbscript:x',
        'blob:https://app.ever.test/x',
        'filesystem:https://x/y',
        './x',
        '../x',
        './/evil.test',
        '#x',
        '?q=1',
        'x:y',
        'https://evil.test',
    ];
    it.each(HREFS)('href %j', (raw) => {
        const r = resolveMarkdownHref(raw);
        const verdict = r ? verdictForUrl('href', r.href) : null;
        expect(verdict).toBeNull();
    });
    const SRCS = [
        'https://ok.test/a.png',
        'http://ok.test/a.png',
        '//evil.test/a.png',
        '/\\evil.test/a.png',
        '/\t/evil.test/a.png',
        'data:image/png;base64,AA',
        'https://u:p@evil.test/a.png',
        '\u0001//evil.test/a.png',
        './a.png',
        'a.png',
    ];
    it.each(SRCS)('src %j', (raw) => {
        const r = resolveMarkdownImageSrc(raw);
        const verdict = r ? verdictForUrl('src', r) : null;
        expect(verdict).toBeNull();
    });
});
