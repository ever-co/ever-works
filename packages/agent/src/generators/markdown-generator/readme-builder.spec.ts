// `github-slugger` is shipped as ESM-only, which Jest's CommonJS pipeline
// cannot parse. Replace it with a tiny deterministic stand-in that mirrors
// the slugify-with-dedup behaviour the builder relies on (lowercase, runs
// of non-alphanumeric → `-`, append `-1`/`-2`/... for repeats per instance).
jest.mock('github-slugger', () => {
    return class MockGithubSlugger {
        private seen = new Map<string, number>();
        slug(input: string): string {
            const base = input
                .toLowerCase()
                .replace(/&/g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '');
            const count = this.seen.get(base) ?? 0;
            this.seen.set(base, count + 1);
            return count === 0 ? base : `${base}-${count}`;
        }
    };
});

import type { ItemData } from '@ever-works/plugin';
import { CATEGORY_PAGE_MARKER } from './markdown-repository';

// `readme-builder` instantiates the slugger at module load and never resets
// it. Across tests, identical headers would otherwise drift to `tools-1`,
// `tools-2`, etc. Reload the module per test so each scenario starts with a
// pristine slugger.
let ReadmeBuilder: typeof import('./readme-builder').ReadmeBuilder;
let builderModule: typeof import('./readme-builder');
beforeEach(() => {
    jest.isolateModules(() => {
        builderModule = require('./readme-builder');
        ReadmeBuilder = builderModule.ReadmeBuilder;
    });
});

function makeItem(overrides: Partial<ItemData> = {}): ItemData {
    return {
        slug: 'foo',
        name: 'Foo',
        description: 'A foo',
        source_url: 'https://foo.test',
        ...overrides,
    } as ItemData;
}

describe('ReadmeBuilder', () => {
    describe('build envelope', () => {
        it('emits header + body + footer with empty body', () => {
            const out = new ReadmeBuilder('HDR', 'FTR').build();
            expect(out).toBe('HDR\n\nFTR');
        });

        it('preserves multiline header/footer verbatim', () => {
            const out = new ReadmeBuilder('# Hello\nLine 2', '> bye').build();
            expect(out.startsWith('# Hello\nLine 2\n')).toBe(true);
            expect(out.endsWith('> bye')).toBe(true);
        });
    });

    describe('section helpers', () => {
        it('addHeader emits H1 with two trailing newlines', () => {
            const out = new ReadmeBuilder('', '').addHeader('Title').build();
            expect(out).toContain('# Title\n\n');
        });

        it('addSubHeader emits H2, registers a ToC entry, and is chainable', () => {
            const builder = new ReadmeBuilder('', '');
            const ret = builder.addSubHeader('Tools', 12);
            expect(ret).toBe(builder);
            const out = builder.enableToC().build();
            expect(out).toContain('## Tools\n\n');
            expect(out).toContain('## 📑 Table of Contents');
            expect(out).toContain('- [Tools (12)](#tools)');
        });

        it('addParagraph + addNewLine compose with double + single newlines', () => {
            const out = new ReadmeBuilder('', '')
                .addParagraph('Para A')
                .addNewLine()
                .addParagraph('Para B')
                .build();
            // Body ends with the trailing `\n` from build() too.
            expect(out).toContain('Para A\n\n\nPara B\n\n');
        });

        it('every section helper is chainable (returns the builder)', () => {
            const b = new ReadmeBuilder('', '');
            expect(b.addHeader('h')).toBe(b);
            expect(b.addParagraph('p')).toBe(b);
            expect(b.addNewLine()).toBe(b);
            expect(b.enableToC()).toBe(b);
        });
    });

    describe('Table of Contents', () => {
        it('is omitted when enableToC() is not called', () => {
            const out = new ReadmeBuilder('H', 'F')
                .addSubHeader('Tools', 5)
                .addSubHeader('Libraries', 10)
                .build();
            expect(out).not.toContain('Table of Contents');
            expect(out).toContain('## Tools');
            expect(out).toContain('## Libraries');
        });

        it('is rendered with anchor slugs and en-US-formatted counts', () => {
            const out = new ReadmeBuilder('', '')
                .enableToC()
                .addSubHeader('Tools & Utilities', 1234)
                .addSubHeader('Libraries')
                .build();

            expect(out).toContain('## 📑 Table of Contents\n\n');
            // The slugger lowercases, drops `&`, and collapses non-alphanum
            // runs into single `-` (the exact slug shape comes from
            // github-slugger; here we assert against a stable substring that
            // both the real library and our mock agree on).
            expect(out).toMatch(/- \[Tools & Utilities \(1,234\)\]\(#tools-+utilities\)/);
            // Count omitted when undefined.
            expect(out).toContain('- [Libraries](#libraries)');
            // The body subheaders still render.
            expect(out).toContain('## Tools & Utilities\n\n');
            expect(out).toContain('## Libraries\n\n');
        });

        it('disambiguates duplicate slugs across the document', () => {
            const out = new ReadmeBuilder('', '')
                .enableToC()
                .addSubHeader('Tools')
                .addSubHeader('Tools')
                .build();
            // github-slugger appends -1, -2, ... for repeats.
            expect(out).toContain('- [Tools](#tools)');
            expect(out).toContain('- [Tools](#tools-1)');
        });

        it('renders 0 as "0" not as omitted', () => {
            const out = new ReadmeBuilder('', '').enableToC().addSubHeader('Empty', 0).build();
            expect(out).toContain('- [Empty (0)](#empty)');
        });
    });

    describe('addItem', () => {
        it('emits the standard item line without details and with no tags', () => {
            const out = new ReadmeBuilder('', '').addItem(makeItem()).build();
            expect(out).toContain('- [Foo](https://foo.test) - A foo\n');
            expect(out).not.toContain('Read more');
            expect(out).not.toContain('`');
        });

        it('appends the details link when hasDetails=true', () => {
            const out = new ReadmeBuilder('', '')
                .addItem(makeItem({ slug: 'cool-thing' }), { hasDetails: true })
                .build();
            expect(out).toContain(
                '- [Foo](https://foo.test) - A foo ([Read more](/details/cool-thing.md))',
            );
        });

        it('joins tags with spaces and wraps each in backticks', () => {
            const out = new ReadmeBuilder('', '')
                .addItem(
                    makeItem({
                        tags: [
                            { name: 'rust', slug: 'rust' },
                            { name: 'cli', slug: 'cli' },
                        ] as any,
                    }),
                )
                .build();
            expect(out).toContain('- [Foo](https://foo.test) - A foo `rust` `cli`');
        });

        it('emits BOTH the details link AND the tags when both are present', () => {
            const out = new ReadmeBuilder('', '')
                .addItem(
                    makeItem({
                        slug: 's',
                        tags: [{ name: 'a', slug: 'a' }] as any,
                    }),
                    { hasDetails: true },
                )
                .build();
            expect(out).toContain(
                '- [Foo](https://foo.test) - A foo ([Read more](/details/s.md)) `a`',
            );
        });

        it('skips the tags suffix when tags is missing or empty array', () => {
            const out1 = new ReadmeBuilder('', '').addItem(makeItem({ tags: [] as any })).build();
            const out2 = new ReadmeBuilder('', '').addItem(makeItem({ tags: undefined })).build();
            expect(out1).not.toContain('`');
            expect(out2).not.toContain('`');
        });

        it('addItem is chainable for multi-item runs', () => {
            const b = new ReadmeBuilder('', '');
            expect(b.addItem(makeItem())).toBe(b);
            const out = b.addItem(makeItem({ slug: 'b', name: 'Bar' })).build();
            expect(out).toMatch(/- \[Foo\].*\n- \[Bar\]/);
        });
    });

    describe('end-to-end shape', () => {
        it('produces a sensible README from header → ToC → sections → items → footer', () => {
            const out = new ReadmeBuilder('# Awesome List', '## License\n\nMIT')
                .addHeader('Awesome List')
                .enableToC()
                .addSubHeader('Tools', 2)
                .addItem(makeItem({ slug: 'a', name: 'A', description: 'An A' }))
                .addItem(
                    makeItem({
                        slug: 'b',
                        name: 'B',
                        description: 'A B',
                        tags: [{ name: 't', slug: 't' }] as any,
                    }),
                    { hasDetails: true },
                )
                .build();

            expect(out.startsWith('# Awesome List\n')).toBe(true);
            expect(out).toContain('## 📑 Table of Contents');
            expect(out).toContain('- [Tools (2)](#tools)');
            expect(out).toContain('## Tools');
            expect(out).toContain('- [A](https://foo.test) - An A');
            expect(out).toContain('- [B](https://foo.test) - A B ([Read more](/details/b.md)) `t`');
            expect(out.endsWith('## License\n\nMIT')).toBe(true);
        });
    });

    describe('details link base path', () => {
        it('defaults to /details/ (repository root)', () => {
            const out = new ReadmeBuilder('', '')
                .addItem(makeItem({ slug: 'x' }), { hasDetails: true })
                .build();
            expect(out).toContain('([Read more](/details/x.md))');
        });

        it('uses the configured detailsBasePath for every Read more link', () => {
            const out = new ReadmeBuilder('', '', { detailsBasePath: '../details/' })
                .addItem(makeItem({ slug: 'x' }), { hasDetails: true })
                .build();
            expect(out).toContain('([Read more](../details/x.md))');
        });

        it('formatReadmeItem returns the same line addItem writes, without the newline', () => {
            const item = makeItem({ slug: 's', tags: [{ name: 'a' }] as any });
            const line = builderModule.formatReadmeItem(item, { hasDetails: true });
            expect(line).toBe('- [Foo](https://foo.test) - A foo ([Read more](/details/s.md)) `a`');
            expect(new ReadmeBuilder('', '').addItem(item, { hasDetails: true }).build()).toContain(
                `${line}\n`,
            );
        });
    });
});

describe('category page file names', () => {
    it('toCategoryFileSlug keeps a plain id and slugifies anything else', () => {
        const { toCategoryFileSlug } = builderModule;
        expect(toCategoryFileSlug('cloud-devops-mcp-servers')).toBe('cloud-devops-mcp-servers');
        expect(toCategoryFileSlug('Cloud & DevOps MCP Servers')).toBe('cloud-devops-mcp-servers');
        expect(toCategoryFileSlug('Café_Tools')).toBe('cafe-tools');
        expect(toCategoryFileSlug('../../etc/passwd')).toBe('etc-passwd');
        // never two hyphens in a row, so `--page-N` stays unambiguous
        expect(toCategoryFileSlug('a -- b')).toBe('a-b');
    });

    it('toCategoryFileSlug caps the length at 80 characters without a trailing hyphen', () => {
        const slug = builderModule.toCategoryFileSlug(`${'a'.repeat(79)} b`);
        expect(slug.length).toBeLessThanOrEqual(80);
        expect(slug.endsWith('-')).toBe(false);
    });

    it('toCategoryFileSlug falls back to a stable hash when nothing usable is left', () => {
        const { toCategoryFileSlug } = builderModule;
        const slug = toCategoryFileSlug('数据库');
        expect(slug).toMatch(/^category-[0-9a-f]{8}$/);
        expect(toCategoryFileSlug('数据库')).toBe(slug);
        expect(toCategoryFileSlug('工具')).not.toBe(slug);
    });

    it('assignCategoryFileSlugs gives clashing ids distinct slugs, independent of input order', () => {
        const { assignCategoryFileSlugs } = builderModule;
        const a = assignCategoryFileSlugs(['foo-bar', 'Foo_Bar', 'other']);
        const b = assignCategoryFileSlugs(['other', 'Foo_Bar', 'foo-bar']);
        expect(new Set(a.values()).size).toBe(3);
        expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
        expect(a.get('other')).toBe('other');
    });

    it('categoryPageFileName names page 1 after the slug and later pages with --page-N', () => {
        expect(builderModule.categoryPageFileName('tools')).toBe('tools.md');
        expect(builderModule.categoryPageFileName('tools', 1)).toBe('tools.md');
        expect(builderModule.categoryPageFileName('tools', 3)).toBe('tools--page-3.md');
    });
});

describe('buildSplitReadme', () => {
    const item = (slug: string, overrides: Partial<ItemData> = {}) =>
        makeItem({ slug, name: slug.toUpperCase(), description: `About ${slug}`, ...overrides });

    const baseInput = () => ({
        header: '# Awesome Things\n\nIntro.',
        footer: '## License\n\nMIT',
        sections: [
            {
                id: 'cloud-devops',
                name: 'Cloud & DevOps',
                items: [item('k8s', { featured: true }), item('terraform')],
            },
            {
                id: 'databases',
                name: 'Databases',
                items: [item('pg'), item('k8s', { featured: true })],
            },
        ],
        hasDetails: (i: ItemData) => i.slug !== 'terraform',
    });

    it('README keeps header and footer and lists every category with its count and page link', () => {
        const { readme } = builderModule.buildSplitReadme(baseInput());

        expect(readme.startsWith('# Awesome Things\n\nIntro.\n')).toBe(true);
        expect(readme.endsWith('## License\n\nMIT')).toBe(true);
        expect(readme).toContain('## 📑 Categories\n\n');
        expect(readme).toContain('- [Cloud & DevOps](categories/cloud-devops.md) (2)');
        expect(readme).toContain('- [Databases](categories/databases.md) (2)');
        // unique items, not item/category pairs
        expect(readme).toContain('> **3 items in 2 categories.**');
        // non-featured items live only on the category pages
        expect(readme).not.toContain('About terraform');
        expect(readme).not.toContain('About pg');
    });

    it('README lists featured items once each, with root-relative details links', () => {
        const { readme } = builderModule.buildSplitReadme(baseInput());

        expect(readme).toContain('## ⭐ Featured\n\n');
        expect(readme.match(/About k8s/g)).toHaveLength(1);
        expect(readme).toContain(
            '- [K8S](https://foo.test) - About k8s ([Read more](/details/k8s.md))',
        );
    });

    it('omits the Featured section when no item is featured', () => {
        const input = baseInput();
        input.sections = [{ id: 'x', name: 'X', items: [item('a')] }];
        const { readme } = builderModule.buildSplitReadme(input);
        expect(readme).not.toContain('Featured');
        expect(readme).toContain('> **1 item in 1 category.**');
    });

    it('writes one page per category with the marker, a title, back links and ../details/ links', () => {
        const { pages } = builderModule.buildSplitReadme(baseInput());

        expect(pages.map((p) => p.fileName)).toEqual(['cloud-devops.md', 'databases.md']);
        const cloud = pages[0].content;
        expect(cloud.startsWith(`${CATEGORY_PAGE_MARKER}\n# Cloud & DevOps\n\n`)).toBe(true);
        expect(cloud.match(/\[⬅ Back to the full list\]\(\.\.\/README\.md\)/g)).toHaveLength(2);
        expect(cloud).toContain('2 items');
        expect(cloud).toContain(
            '- [K8S](https://foo.test) - About k8s ([Read more](../details/k8s.md))\n',
        );
        // no details file → no Read more link
        expect(cloud).toContain('- [TERRAFORM](https://foo.test) - About terraform\n');
        expect(cloud).not.toContain('](/details/');
        // featured item stays in every category it belongs to
        expect(pages[1].content).toContain('About k8s');
    });

    it('links the website from the README and every page when siteUrl is an http(s) URL', () => {
        const { readme, pages } = builderModule.buildSplitReadme({
            ...baseInput(),
            siteUrl: 'https://mcpserver.ever.works',
        });
        expect(readme).toContain(
            'You can also browse and search everything on [mcpserver.ever.works](https://mcpserver.ever.works).',
        );
        for (const page of pages) {
            expect(page.content).toContain('[Browse on the website](https://mcpserver.ever.works)');
        }
    });

    it('drops a non-http(s) siteUrl instead of linking it', () => {
        const { readme, pages } = builderModule.buildSplitReadme({
            ...baseInput(),
            siteUrl: 'javascript:alert(1)',
        });
        expect(readme).not.toContain('javascript:');
        expect(readme).not.toContain('browse and search');
        expect(pages[0].content).not.toContain('Browse on the website');
    });

    it('escapes Markdown control characters of category names in the index', () => {
        const input = baseInput();
        input.sections = [{ id: 'evil', name: 'Evil](https://x.test) [', items: [item('a')] }];
        const { readme } = builderModule.buildSplitReadme(input);
        expect(readme).toContain('- [Evil\\](https://x.test) \\[](categories/evil.md) (1)');
    });

    it('splits a category that is too large for one page into --page-N files, each within the threshold', () => {
        const many = Array.from({ length: 60 }, (_, n) =>
            item(`item-${String(n).padStart(2, '0')}`, { description: 'x'.repeat(80) }),
        );
        const thresholdBytes = 2048;
        const { readme, pages } = builderModule.buildSplitReadme({
            header: '# H',
            footer: 'F',
            sections: [{ id: 'big', name: 'Big', items: many }],
            hasDetails: () => true,
            thresholdBytes,
        });

        expect(pages.length).toBeGreaterThan(1);
        expect(pages[0].fileName).toBe('big.md');
        expect(pages[1].fileName).toBe('big--page-2.md');
        for (const [index, page] of pages.entries()) {
            expect(Buffer.byteLength(page.content, 'utf8')).toBeLessThanOrEqual(thresholdBytes);
            expect(page.content).toContain(`Page ${index + 1} of ${pages.length}: `);
            expect(page.content).toContain(`**${index + 1}**`);
        }
        expect(pages[0].content).toContain('[2](big--page-2.md)');
        // every item appears exactly once across the pages
        const all = pages.map((p) => p.content).join('');
        for (const it of many) {
            expect(all.match(new RegExp(`\\[${it.slug.toUpperCase()}\\]`, 'g'))).toHaveLength(1);
        }
        // the index points at the first page
        expect(readme).toContain('- [Big](categories/big.md) (60)');
    });

    it('caps the Featured section so the README stays within the threshold', () => {
        const featured = Array.from({ length: 40 }, (_, n) =>
            item(`f-${n}`, { featured: true, description: 'y'.repeat(100) }),
        );
        const thresholdBytes = 2048;
        const { readme } = builderModule.buildSplitReadme({
            header: '# H',
            footer: 'F',
            sections: [{ id: 'a', name: 'A', items: featured }],
            hasDetails: () => false,
            thresholdBytes,
        });
        expect(Buffer.byteLength(readme, 'utf8')).toBeLessThanOrEqual(thresholdBytes);
        expect(readme).toMatch(/- …and \d+ more featured items on the category pages\.\n/);
        expect(readme.endsWith('\nF')).toBe(true);
    });
});
