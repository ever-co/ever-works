import {
    Component,
    memo,
    type ComponentPropsWithoutRef,
    type ElementType,
    type ReactElement,
    type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import Markdown, {
    type Components,
    type ExtraProps,
    type Options,
    type UrlTransform,
} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { cn } from '@/lib/utils/cn';
import { resolveMarkdownHref, resolveMarkdownImageSrc } from '@/lib/markdown/markdown-links';
import { assessInlineMarkdown, assessMarkdown } from '@/lib/markdown/markdown-limits';

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
 *  - It never throws (PR #3137 review): `lib/markdown/markdown-limits` refuses
 *    text too long or too deeply nested to parse safely (2,000 nested list
 *    levels overflow the parser's stack), the parse runs inside a try/catch on
 *    the server and the client, and an error boundary catches the rest. All
 *    three show the text as escaped plain text with a one-line note, so a bad
 *    description can never take its detail page — and its Edit button — down.
 */

export type MarkdownContentSize = 'sm' | 'xs';

/** `rehype-sanitize`'s default `clobberPrefix` for ids and aria references. */
const ID_PREFIX = 'user-content-';

const BLOCK_CLASS = cn(
    'prose dark:prose-invert max-w-none break-words',
    'text-text-secondary dark:text-text-secondary-dark',
    'prose-p:my-2 prose-p:leading-relaxed',
    // No outer margin on the first / last block, so the text lines up with its container.
    '[&>:first-child]:mt-0 [&>:last-child]:mb-0',
    'prose-p:text-text-secondary dark:prose-p:text-text-secondary-dark',
    'prose-li:text-text-secondary dark:prose-li:text-text-secondary-dark',
    'prose-headings:text-text dark:prose-headings:text-text-dark prose-headings:font-semibold',
    'prose-headings:mt-4 prose-headings:mb-1.5',
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
    // In-page targets (footnotes) carry rehype-sanitize's `user-content-` id prefix.
    const target =
        resolved.href.startsWith('#') && !resolved.href.startsWith(`#${ID_PREFIX}`)
            ? `#${ID_PREFIX}${resolved.href.slice(1)}`
            : resolved.href;
    return (
        <a
            {...props}
            href={target}
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

interface HastNode {
    type: string;
    tagName?: string;
    properties?: Record<string, unknown>;
    children?: HastNode[];
}
interface HastParent extends HastNode {
    children: HastNode[];
}

function isFootnoteNode(node: HastNode): boolean {
    if (node.type !== 'element') return false;
    if (node.tagName === 'section' && node.properties?.dataFootnotes !== undefined) return true;
    // <sup><a data-footnote-ref …>1</a></sup>
    return (
        node.tagName === 'sup' &&
        (node.children ?? []).some((child) => child.properties?.dataFootnoteRef !== undefined)
    );
}

/**
 * Inline fields have no room for a footnotes section: drop footnote
 * references and the generated "Footnotes" list before anything is unwrapped,
 * so neither "Footnotes" nor "↩" leaks into a one-line criterion. Iterative,
 * so a deep tree cannot overflow the stack here either.
 */
function rehypeDropFootnotes() {
    return (tree: HastParent) => {
        const stack: HastParent[] = [tree];
        while (stack.length > 0) {
            const parent = stack.pop() as HastParent;
            parent.children = parent.children.filter((child) => !isFootnoteNode(child));
            for (const child of parent.children) {
                if (child.type === 'element' && child.children) stack.push(child as HastParent);
            }
        }
    };
}

const REMARK_PLUGINS = [remarkGfm];

/**
 * Every block construct the tokenizer knows, by its micromark name. The
 * inline variant switches them off, so a criterion is ONE paragraph of inline
 * Markdown: a table, list, heading, quote or code block in it is never built
 * (building a table there took 233 ms per criterion in the PR #3137 review).
 */
const BLOCK_CONSTRUCTS = [
    'blockQuote',
    'codeFenced',
    'codeIndented',
    'definition',
    'headingAtx',
    'htmlFlow',
    'list',
    'setextUnderline',
    'thematicBreak',
    'table',
    'tasklistCheck',
    'gfmFootnoteDefinition',
    'gfmFootnoteCall',
    'gfmPotentialFootnoteCall',
];

/** remark plugin: inline Markdown only (see {@link BLOCK_CONSTRUCTS}). */
function remarkInlineOnly(this: { data(): Record<string, unknown> }) {
    const data = this.data() as { micromarkExtensions?: unknown[] };
    data.micromarkExtensions = [
        ...(data.micromarkExtensions ?? []),
        { disable: { null: BLOCK_CONSTRUCTS } },
    ];
}

const INLINE_REMARK_PLUGINS = [remarkGfm, remarkInlineOnly];
/**
 * Footnote ids are namespaced by `rehype-sanitize` alone (`user-content-…`,
 * against DOM clobbering); remark-rehype's own prefix is turned off so they
 * are not prefixed twice, and `MarkdownLink` points `#fn-1` at the result.
 */
const REMARK_REHYPE_OPTIONS = { clobberPrefix: '' };
const REHYPE_PLUGINS = [rehypeSanitize];
const INLINE_REHYPE_PLUGINS = [rehypeDropFootnotes, rehypeSanitize];

/** Inline formatting only — what a one-line field (a DoD criterion) may use. */
const INLINE_ELEMENTS = ['strong', 'em', 'del', 'code', 'a', 'br'];

/**
 * Parse with the try/catch INSIDE this component's render, on the server and
 * the client alike: an error boundary cannot catch a server render, and the
 * parser is where an unforeseen input would throw. `Markdown` is a plain
 * synchronous function without hooks, so calling it here is the same work
 * React would do one level down.
 */
function parseMarkdown(options: Options): ReactElement | null {
    try {
        return Markdown(options);
    } catch {
        return null;
    }
}

interface BoundaryProps {
    resetKey: string;
    fallback: ReactNode;
    children: ReactNode;
}
interface BoundaryState {
    failed: boolean;
    resetKey: string;
}

/** Client-side safety net for anything that throws while React renders the tree. */
class MarkdownErrorBoundary extends Component<BoundaryProps, BoundaryState> {
    state: BoundaryState = { failed: false, resetKey: this.props.resetKey };

    static getDerivedStateFromError(): Partial<BoundaryState> {
        return { failed: true };
    }

    static getDerivedStateFromProps(
        props: BoundaryProps,
        state: BoundaryState,
    ): Partial<BoundaryState> | null {
        // New content (an edited preview) gets a fresh attempt.
        return props.resetKey === state.resetKey
            ? null
            : { failed: false, resetKey: props.resetKey };
    }

    render() {
        return this.state.failed ? this.props.fallback : this.props.children;
    }
}

/** The text as it was written, escaped by React, with a one-line explanation. */
function PlainTextFallback({ content }: { content: string }) {
    const t = useTranslations('common.markdown');
    return (
        <div className="not-prose space-y-1.5" data-markdown-fallback="">
            <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
                {t('plainTextFallback')}
            </p>
            <pre className="m-0 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-text-secondary dark:text-text-secondary-dark">
                {content}
            </pre>
        </div>
    );
}

export interface MarkdownContentProps {
    content: string;
    size?: MarkdownContentSize;
    className?: string;
    id?: string;
    'data-testid'?: string;
}

/**
 * Memoized: a parent re-render (a "Show more" toggle, a keystroke elsewhere in
 * a form) does not parse the same text again.
 */
export const MarkdownContent = memo(function MarkdownContent({
    content,
    size = 'sm',
    className,
    id,
    'data-testid': testId,
}: MarkdownContentProps) {
    const parsed = assessMarkdown(content).render
        ? parseMarkdown({
              children: content,
              remarkPlugins: REMARK_PLUGINS,
              remarkRehypeOptions: REMARK_REHYPE_OPTIONS,
              rehypePlugins: REHYPE_PLUGINS,
              components: BLOCK_COMPONENTS,
              urlTransform: markdownUrlTransform,
              skipHtml: true,
          })
        : null;
    const fallback = <PlainTextFallback content={content} />;

    return (
        <div id={id} data-testid={testId} className={cn(BLOCK_CLASS, SIZE_CLASS[size], className)}>
            {parsed ? (
                <MarkdownErrorBoundary resetKey={content} fallback={fallback}>
                    {parsed}
                </MarkdownErrorBoundary>
            ) : (
                fallback
            )}
        </div>
    );
});

/**
 * One line of Markdown: bold, italic, strikethrough, inline code and links.
 * Block syntax (headings, lists, quotes) is unwrapped to its text, so a
 * criterion that starts with `#` or `-` still reads as a sentence; footnotes
 * are dropped. Text the renderer will not parse shows as plain text.
 */
export const MarkdownInline = memo(function MarkdownInline({
    content,
    className,
    'data-testid': testId,
}: Omit<MarkdownContentProps, 'size' | 'id'>) {
    const parsed = assessInlineMarkdown(content).render
        ? parseMarkdown({
              children: content,
              remarkPlugins: INLINE_REMARK_PLUGINS,
              remarkRehypeOptions: REMARK_REHYPE_OPTIONS,
              rehypePlugins: INLINE_REHYPE_PLUGINS,
              components: INLINE_COMPONENTS,
              urlTransform: markdownUrlTransform,
              allowedElements: INLINE_ELEMENTS,
              unwrapDisallowed: true,
              skipHtml: true,
          })
        : null;
    const fallback = <span data-markdown-fallback="">{content}</span>;

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
            {parsed ? (
                <MarkdownErrorBoundary resetKey={content} fallback={fallback}>
                    {parsed}
                </MarkdownErrorBoundary>
            ) : (
                fallback
            )}
        </span>
    );
});
