import type { ComponentPropsWithoutRef, ElementType } from 'react';
import Markdown, { type Components, type ExtraProps, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { cn } from '@/lib/utils/cn';
import { resolveMarkdownHref, resolveMarkdownImageSrc } from '@/lib/markdown/markdown-links';

/**
 * The one renderer for Markdown that users and agents write into record
 * descriptions: Missions, Goals (and their Definition-of-Done criteria),
 * Tasks, Teams, Works, Ideas and Agent capabilities.
 *
 * Extracted from `works/detail/items/MarkdownPreview` (same `react-markdown` +
 * `remark-gfm` pipeline and typography), hardened for content the viewer did
 * not write — an agent, an import or another member of the Organization may
 * have:
 *
 *  - GFM: headings, lists, task lists, tables, fenced and inline code,
 *    strikethrough, autolinks, footnotes.
 *  - Raw HTML is never rendered (`skipHtml`): `<script>`, `<img onerror>`,
 *    `<iframe>`, inline `style` and event handlers are dropped, their text kept.
 *  - `rehype-sanitize` (GitHub's schema) runs over the generated tree as a
 *    second line of defence, so a future plugin cannot reintroduce an unsafe
 *    attribute either.
 *  - URLs go through `lib/markdown/markdown-links`: links are http(s), mailto,
 *    `#anchors` or same-origin paths; anything else (`javascript:`, `data:`,
 *    `vbscript:`, `//other-host`) renders as plain text. External links open
 *    in a new tab with `rel="noopener noreferrer"`. Images must be https or
 *    same-origin and load lazily without a referrer.
 *  - Headings are demoted two levels (`#` renders an `<h3>`) so a description
 *    never competes with the page's own `<h1>` / section `<h2>` outline.
 *
 * No `'use client'`: the component has no state, so it renders in server
 * components (the Agent detail page) as well as inside client ones.
 */

export type MarkdownContentSize = 'sm' | 'xs';

const BLOCK_CLASS = cn(
    'prose dark:prose-invert max-w-none break-words',
    'text-text-secondary dark:text-text-secondary-dark',
    'prose-p:my-2 prose-p:leading-relaxed first:prose-p:mt-0',
    'prose-p:text-text-secondary dark:prose-p:text-text-secondary-dark',
    'prose-li:text-text-secondary dark:prose-li:text-text-secondary-dark',
    'prose-headings:text-text dark:prose-headings:text-text-dark prose-headings:font-semibold',
    'prose-headings:mt-4 prose-headings:mb-1.5 first:prose-headings:mt-0',
    'prose-strong:text-text dark:prose-strong:text-text-dark prose-strong:font-semibold',
    'prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-li:marker:text-text-muted',
    'prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:font-normal',
    'prose-code:bg-black/5 dark:prose-code:bg-white/10',
    'prose-code:text-text dark:prose-code:text-text-dark',
    'prose-code:before:content-none prose-code:after:content-none',
    'prose-pre:my-2 prose-pre:rounded-md prose-pre:border prose-pre:border-border/60 dark:prose-pre:border-border-dark/60',
    'prose-pre:bg-black/5 dark:prose-pre:bg-white/5',
    'prose-pre:text-text dark:prose-pre:text-text-dark',
    'prose-table:my-2',
    'prose-th:px-2 prose-th:py-1 prose-th:border prose-th:border-border dark:prose-th:border-border-dark',
    'prose-th:bg-surface-secondary dark:prose-th:bg-surface-secondary-dark',
    'prose-td:px-2 prose-td:py-1 prose-td:border prose-td:border-border dark:prose-td:border-border-dark',
    'prose-a:text-primary prose-a:font-medium prose-a:no-underline hover:prose-a:underline',
    'prose-blockquote:my-2 prose-blockquote:font-normal prose-blockquote:not-italic',
    'prose-blockquote:border-l-primary/30 prose-blockquote:text-text-muted dark:prose-blockquote:text-text-muted-dark',
    'prose-hr:my-3 prose-hr:border-border dark:prose-hr:border-border-dark',
    'prose-img:my-2 prose-img:rounded-md',
);

const SIZE_CLASS: Record<MarkdownContentSize, string> = {
    sm: 'prose-sm text-sm',
    xs: 'prose-sm text-xs prose-p:my-1 prose-pre:text-[11px] prose-code:text-[11px]',
};

/** Heading size by its SOURCE level; the rendered tag is demoted (see above). */
const HEADING_CLASS: Record<number, string> = {
    1: 'text-base',
    2: 'text-sm',
    3: 'text-sm',
    4: 'text-xs uppercase tracking-wide',
    5: 'text-xs uppercase tracking-wide',
    6: 'text-xs uppercase tracking-wide',
};

const DEMOTED_TAG: Record<number, ElementType> = {
    1: 'h3',
    2: 'h4',
    3: 'h5',
    4: 'h6',
    5: 'h6',
    6: 'h6',
};

function heading(level: number) {
    const Tag = DEMOTED_TAG[level];
    function MarkdownHeading({
        node,
        className,
        ...props
    }: ComponentPropsWithoutRef<'h1'> & ExtraProps) {
        void node;
        return <Tag {...props} className={cn(className, HEADING_CLASS[level])} />;
    }
    MarkdownHeading.displayName = `MarkdownHeading${level}`;
    return MarkdownHeading;
}

function MarkdownLink({
    node,
    href,
    children,
    ...props
}: ComponentPropsWithoutRef<'a'> & ExtraProps) {
    void node;
    const resolved = resolveMarkdownHref(href);
    if (!resolved) {
        // A refused URL keeps its label as text, never a clickable link.
        return <span data-markdown-refused-link="">{children}</span>;
    }
    return (
        <a
            {...props}
            href={resolved.href}
            {...(resolved.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
            {children}
        </a>
    );
}

function MarkdownImage({ node, src, alt, title }: ComponentPropsWithoutRef<'img'> & ExtraProps) {
    void node;
    const safe = typeof src === 'string' ? resolveMarkdownImageSrc(src) : null;
    if (!safe) return alt ? <span>{alt}</span> : null;
    return (
        // eslint-disable-next-line @next/next/no-img-element -- arbitrary user-supplied URL; next/image needs a configured host
        <img
            src={safe}
            alt={alt ?? ''}
            title={title}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="max-w-full h-auto"
        />
    );
}

function ScrollableTable({ node, ...props }: ComponentPropsWithoutRef<'table'> & ExtraProps) {
    void node;
    return (
        <div className="overflow-x-auto">
            <table className="min-w-full" {...props} />
        </div>
    );
}

const BLOCK_COMPONENTS: Components = {
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    a: MarkdownLink,
    img: MarkdownImage,
    table: ScrollableTable,
};

const INLINE_COMPONENTS: Components = {
    a: MarkdownLink,
};

/**
 * Every URL attribute in the tree passes the policy above; a refused one
 * becomes empty, which the link / image components then render as text.
 */
export const markdownUrlTransform: UrlTransform = (url, key) => {
    if (key === 'href') return resolveMarkdownHref(url)?.href ?? '';
    if (key === 'src') return resolveMarkdownImageSrc(url) ?? '';
    return '';
};

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeSanitize];

/** Inline formatting only — what a one-line field (a DoD criterion) may use. */
const INLINE_ELEMENTS = ['strong', 'em', 'del', 'code', 'a', 'br'];

export interface MarkdownContentProps {
    content: string;
    size?: MarkdownContentSize;
    className?: string;
    id?: string;
    'data-testid'?: string;
}

export function MarkdownContent({
    content,
    size = 'sm',
    className,
    id,
    'data-testid': testId,
}: MarkdownContentProps) {
    return (
        <div id={id} data-testid={testId} className={cn(BLOCK_CLASS, SIZE_CLASS[size], className)}>
            <Markdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={BLOCK_COMPONENTS}
                urlTransform={markdownUrlTransform}
                skipHtml
            >
                {content}
            </Markdown>
        </div>
    );
}

/**
 * One line of Markdown: bold, italic, strikethrough, inline code and links.
 * Block syntax (headings, lists, quotes) is unwrapped to its text, so a
 * criterion that starts with `#` or `-` still reads as a sentence.
 */
export function MarkdownInline({
    content,
    className,
    'data-testid': testId,
}: Omit<MarkdownContentProps, 'size' | 'id'>) {
    return (
        <span
            data-testid={testId}
            className={cn(
                '[&_code]:rounded [&_code]:bg-black/5 dark:[&_code]:bg-white/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em]',
                '[&_a]:text-primary [&_a]:font-medium hover:[&_a]:underline',
                '[&_strong]:font-semibold',
                className,
            )}
        >
            <Markdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={INLINE_COMPONENTS}
                urlTransform={markdownUrlTransform}
                allowedElements={INLINE_ELEMENTS}
                unwrapDisallowed
                skipHtml
            >
                {content}
            </Markdown>
        </span>
    );
}
