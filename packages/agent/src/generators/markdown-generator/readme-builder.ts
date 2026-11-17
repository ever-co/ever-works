import { createHash } from 'node:crypto';
import GithubSlugger from 'github-slugger';
import type { ItemData } from '@ever-works/plugin';
import { CATEGORY_PAGES_DIR, CATEGORY_PAGE_MARKER } from './markdown-repository';

/**
 * Largest README (UTF-8 bytes) the generator writes as a single file.
 *
 * GitHub stops rendering a large README part-way: on 2026-11-17 the front page
 * of `ever-works/awesome-mcp-servers` (a 1.38 MB README) stopped after about
 * 366 KB, mid-line, so most entries were invisible there. Above this size the
 * README becomes a category index and every category gets its own page under
 * `categories/` (see {@link buildSplitReadme}); every generated file is laid
 * out to stay at or under this size (secret redaction, which runs afterwards,
 * can still change a file by a few bytes). Chosen well below the measured
 * cut-off because GitHub's limit applies to the rendered HTML, not to the
 * Markdown source.
 */
export const README_SPLIT_THRESHOLD_BYTES = 300 * 1024;

/** "Read more" prefix from the repository root (README.md). */
const ROOT_DETAILS_PATH = '/details/';
/** "Read more" prefix from a page in `categories/`. */
const CATEGORY_PAGE_DETAILS_PATH = '../details/';

// Security: README.md is committed verbatim to the user's (often public)
// GitHub repo, and `item.name`/`description`/`source_url`/tag names are
// populated by the AI pipeline from externally-fetched, attacker-controllable
// web content. Escape Markdown control characters in text fields and validate
// the link target so a hostile page title/description/URL cannot inject extra
// links or break out of the list-item / inline-code context. Benign values
// (plain titles, descriptions, http(s) URLs) are left byte-for-byte unchanged.
export function escapeMarkdownInline(value: unknown): string {
    return String(value ?? '').replace(/[\\`[\]]/g, '\\$&');
}

// Security: only emit `http(s)` link targets; anything else (e.g.
// `javascript:`/`data:` URIs) collapses to an inert anchor. For accepted
// URLs, percent-encode the few characters that would otherwise terminate or
// break out of the Markdown link destination `(...)`. Legitimate http(s)
// URLs do not contain these characters, so they pass through verbatim.
export function sanitizeMarkdownUrl(value: unknown): string {
    const raw = String(value ?? '');
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return '#';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return '#';
    }
    return raw.replace(/[()<>\s]/g, encodeURIComponent);
}

/**
 * One list line for an item (no trailing newline): name link, description,
 * optional "Read more" link to `<detailsBasePath><slug>.md`, then the tags.
 */
export function formatReadmeItem(
    item: ItemData,
    options: { hasDetails?: boolean; detailsBasePath?: string } = {},
): string {
    // TODO: consider making featured items bolder (item.featured)
    const name = escapeMarkdownInline(item.name);
    const url = sanitizeMarkdownUrl(item.source_url);
    const description = escapeMarkdownInline(item.description);
    let line = `- [${name}](${url}) - ${description}`;
    if (options.hasDetails) {
        line += ` ([Read more](${options.detailsBasePath ?? ROOT_DETAILS_PATH}${item.slug}.md))`;
    }

    if (item.tags && item.tags.length > 0) {
        const tags = item.tags
            .map(
                (tag) =>
                    `\`${escapeMarkdownInline((tag as { name?: string }).name ?? String(tag))}\``,
            )
            .join(' ');
        line += ` ${tags}`;
    }
    return line;
}

export type ReadmeBuilderOptions = {
    /** Prefix of the "Read more" links. Default `/details/` (repository root). */
    detailsBasePath?: string;
};

export class ReadmeBuilder {
    private content: string = '';
    private isTocEnabled: boolean = false;
    private readonly toc: { header: string; count?: number }[] = []; // Table of Contents

    constructor(
        private readonly header: string,
        private readonly footer: string,
        private readonly options: ReadmeBuilderOptions = {},
    ) {}

    addHeader(header: string) {
        this.content += `# ${header}\n\n`;
        return this;
    }

    addSubHeader(header: string, count?: number) {
        this.content += `## ${header}\n\n`;
        this.toc.push({ header, count });
        return this;
    }

    addParagraph(paragraph: string) {
        this.content += `${paragraph}\n\n`;
        return this;
    }

    addNewLine() {
        this.content += '\n';
        return this;
    }

    enableToC() {
        this.isTocEnabled = true;
        return this;
    }

    private generateToC() {
        let toc = '';

        if (this.isTocEnabled) {
            // Fresh slugger per ToC build. `GithubSlugger` is stateful —
            // it tracks every slug it has ever produced to enforce
            // intra-document uniqueness. A module-scoped or per-instance
            // slugger reused across multiple READMEs would gradually
            // suffix headers (`tools`, `tools-1`, `tools-2`, ...) while
            // GitHub Markdown re-renders each `## Tools` header back to
            // anchor `#tools` — every TOC link past the first would
            // become a dead anchor.
            const slugger = new GithubSlugger();
            toc += '## 📑 Table of Contents\n\n';
            this.toc.forEach(({ header, count }) => {
                const slug = slugger.slug(header);
                let label = header;
                if (count !== undefined) {
                    label += ` (${count.toLocaleString('en-US')})`;
                }
                toc += `- [${label}](#${slug})\n`;
            });
            toc += '\n';
        }

        return toc;
    }

    addItem(item: ItemData, options: { hasDetails?: boolean } = {}) {
        this.content += `${formatReadmeItem(item, {
            hasDetails: options.hasDetails,
            detailsBasePath: this.options.detailsBasePath,
        })}\n`;
        return this;
    }

    build(): string {
        let result = this.header + '\n';

        if (this.isTocEnabled) {
            result += this.generateToC();
            result += '\n';
        }

        return result + this.content + '\n' + this.footer;
    }
}

// ---------------------------------------------------------------------------
// Split layout: README index + one page per category
// ---------------------------------------------------------------------------

/** A README section: one category and its items, already in display order. */
export type ReadmeCategorySection = {
    /** Canonical category id (used to name the category page). */
    id: string;
    name: string;
    items: readonly ItemData[];
};

/** A generated page, relative to `categories/`. */
export type CategoryPageFile = {
    fileName: string;
    content: string;
};

export type SplitReadmeInput = {
    header: string;
    footer: string;
    sections: readonly ReadmeCategorySection[];
    /** Whether `details/<slug>.md` exists for the item. */
    hasDetails: (item: ItemData) => boolean;
    /** Size limit for every generated file. Default {@link README_SPLIT_THRESHOLD_BYTES}. */
    thresholdBytes?: number;
    /** The directory's website; linked from the README and every page when it is an http(s) URL. */
    siteUrl?: string;
};

export type SplitReadme = {
    readme: string;
    pages: CategoryPageFile[];
};

const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');
const formatCount = (count: number) => count.toLocaleString('en-US');
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
const oneLine = (value: unknown) =>
    String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim();

/**
 * File-name slug for a category page: lowercase ASCII letters, digits and
 * single hyphens only (so the `--page-N` suffix of later pages can never
 * collide with another category), at most 80 characters. A value with no
 * usable characters (e.g. a name written only in non-Latin script) gets a
 * stable `category-<hash>` name instead.
 */
export function toCategoryFileSlug(id: string): string {
    const slug = String(id ?? '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)
        .replace(/-+$/, '');
    if (slug) {
        return slug;
    }
    return `category-${createHash('sha256')
        .update(String(id ?? ''))
        .digest('hex')
        .slice(0, 8)}`;
}

/**
 * Give each category id a unique page slug. Ids are processed in sorted order
 * so the result does not depend on display order; a clash (`Foo_Bar` and
 * `foo-bar`) gets `-2`, `-3`, ... appended.
 */
export function assignCategoryFileSlugs(ids: readonly string[]): Map<string, string> {
    const result = new Map<string, string>();
    const used = new Set<string>();

    for (const id of [...new Set(ids)].sort()) {
        const base = toCategoryFileSlug(id);
        let slug = base;
        for (let n = 2; used.has(slug); n++) {
            slug = `${base}-${n}`;
        }
        used.add(slug);
        result.set(id, slug);
    }

    return result;
}

/** `<slug>.md` for the first page, `<slug>--page-<n>.md` after it. */
export function categoryPageFileName(slug: string, page = 1): string {
    return page <= 1 ? `${slug}.md` : `${slug}--page-${page}.md`;
}

type CategoryPageRender = {
    name: string;
    slug: string;
    itemCount: number;
    lines: readonly string[];
    page: number;
    pageCount: number;
    siteUrl?: string;
};

function renderCategoryPage(page: CategoryPageRender): string {
    const nav = [
        '[⬅ Back to the full list](../README.md)',
        `${formatCount(page.itemCount)} ${plural(page.itemCount, 'item', 'items')}`,
    ];
    if (page.siteUrl) {
        nav.push(`[Browse on the website](${page.siteUrl})`);
    }
    if (page.pageCount > 1) {
        const links: string[] = [];
        for (let n = 1; n <= page.pageCount; n++) {
            links.push(
                n === page.page ? `**${n}**` : `[${n}](${categoryPageFileName(page.slug, n)})`,
            );
        }
        nav.push(`Page ${page.page} of ${page.pageCount}: ${links.join(' ')}`);
    }
    const navLine = nav.join(' · ');
    const body = page.lines.map((line) => `${line}\n`).join('');

    return `${CATEGORY_PAGE_MARKER}\n# ${oneLine(page.name)}\n\n${navLine}\n\n${body}\n${navLine}\n`;
}

/** Greedy split of `lines` into chunks whose byte size stays within `budget` (at least one line each). */
function chunkLines(lines: readonly string[], budget: number): string[][] {
    if (lines.length === 0) {
        return [[]];
    }

    const chunks: string[][] = [];
    let current: string[] = [];
    let size = 0;
    for (const line of lines) {
        const lineSize = byteLength(line) + 1;
        if (current.length > 0 && size + lineSize > budget) {
            chunks.push(current);
            current = [];
            size = 0;
        }
        current.push(line);
        size += lineSize;
    }
    chunks.push(current);
    return chunks;
}

/**
 * Render one category as one page, or as several (`<slug>.md`,
 * `<slug>--page-2.md`, ...) when a single page would exceed the threshold.
 */
function buildCategoryPages(
    section: { name: string; slug: string; itemCount: number; lines: readonly string[] },
    thresholdBytes: number,
    siteUrl: string | undefined,
): CategoryPageFile[] {
    const render = (lines: readonly string[], page: number, pageCount: number) =>
        renderCategoryPage({ ...section, lines, page, pageCount, siteUrl });

    // The page navigation grows with the page count, which depends on the
    // budget left after the navigation: start from one page and grow until
    // the chunking needs no more pages than the navigation was sized for.
    let pageCount = 1;
    let chunks: string[][];
    for (;;) {
        const overhead = Math.max(
            byteLength(render([], 1, pageCount)),
            byteLength(render([], pageCount, pageCount)),
        );
        chunks = chunkLines(section.lines, thresholdBytes - overhead);
        if (chunks.length <= pageCount) {
            break;
        }
        pageCount = chunks.length;
    }

    return chunks.map((lines, index) => ({
        fileName: categoryPageFileName(section.slug, index + 1),
        content: render(lines, index + 1, chunks.length),
    }));
}

/**
 * Lay out a directory that is too large for one README: the README keeps the
 * header and footer and lists the categories (name, item count, link to
 * `categories/<slug>.md`) and the featured items; every category gets its own
 * page with the same item lines as the single-file README.
 */
export function buildSplitReadme(input: SplitReadmeInput): SplitReadme {
    const thresholdBytes = input.thresholdBytes ?? README_SPLIT_THRESHOLD_BYTES;
    const sanitizedSite = input.siteUrl ? sanitizeMarkdownUrl(input.siteUrl) : '#';
    const siteUrl = sanitizedSite === '#' ? undefined : sanitizedSite;
    const slugs = assignCategoryFileSlugs(input.sections.map((section) => section.id));

    const pages: CategoryPageFile[] = [];
    const indexLines: string[] = [];
    const uniqueItems = new Set<unknown>();
    const featured: ItemData[] = [];

    for (const section of input.sections) {
        const slug = slugs.get(section.id);
        const lines = section.items.map((item) =>
            formatReadmeItem(item, {
                hasDetails: input.hasDetails(item),
                detailsBasePath: CATEGORY_PAGE_DETAILS_PATH,
            }),
        );
        pages.push(
            ...buildCategoryPages(
                { name: section.name, slug, itemCount: section.items.length, lines },
                thresholdBytes,
                siteUrl,
            ),
        );
        indexLines.push(
            `- [${escapeMarkdownInline(oneLine(section.name))}](${CATEGORY_PAGES_DIR}/${categoryPageFileName(slug)}) (${formatCount(section.items.length)})`,
        );

        for (const item of section.items) {
            const key = item.slug ?? item;
            if (uniqueItems.has(key)) {
                continue;
            }
            uniqueItems.add(key);
            if (item.featured) {
                featured.push(item);
            }
        }
    }

    const total = uniqueItems.size;
    const categoryCount = input.sections.length;
    let intro =
        `> **${formatCount(total)} ${plural(total, 'item', 'items')} in ` +
        `${formatCount(categoryCount)} ${plural(categoryCount, 'category', 'categories')}.** ` +
        'The full list is too large for one GitHub page, so each category has its own page';
    if (siteUrl) {
        const host = escapeMarkdownInline(new URL(siteUrl).host);
        intro += `. You can also browse and search everything on [${host}](${siteUrl})`;
    }
    intro += '.';

    let readme = `${input.header}\n\n${intro}\n\n## 📑 Categories\n\n${indexLines.join('\n')}\n\n`;
    const tail = `\n${input.footer}`;

    if (featured.length > 0) {
        const heading = '## ⭐ Featured\n\n';
        const more = (count: number) =>
            `- …and ${formatCount(count)} more featured ${plural(count, 'item', 'items')} on the category pages.\n`;
        // Keep the README itself under the threshold: add featured items
        // while they fit, leaving room for the "…and N more" line.
        let budget =
            thresholdBytes - byteLength(readme) - byteLength(tail) - byteLength(heading) - 1;
        budget -= byteLength(more(featured.length));
        let body = '';
        let shown = 0;
        for (const item of featured) {
            const line = `${formatReadmeItem(item, {
                hasDetails: input.hasDetails(item),
                detailsBasePath: ROOT_DETAILS_PATH,
            })}\n`;
            const size = byteLength(line);
            if (size > budget) {
                break;
            }
            body += line;
            budget -= size;
            shown += 1;
        }
        if (shown > 0) {
            if (shown < featured.length) {
                body += more(featured.length - shown);
            }
            readme += `${heading}${body}\n`;
        }
    }

    return { readme: readme + tail, pages };
}
