'use client';

import { useEffect, useId, useRef, useState, type FocusEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { MarkdownContent, type MarkdownContentSize } from './MarkdownContent';

/** Collapsed height in px when the caller does not pick one (~8 lines of text-sm). */
export const DEFAULT_COLLAPSED_HEIGHT = 176;

/**
 * Content must be at least this much taller than the collapsed height before
 * it is clamped, so "Show more" never hides a single trailing line.
 */
const OVERFLOW_SLACK = 1.25;

/**
 * Before the first measurement (server render, first paint) a long
 * description starts clamped so the page header does not jump; a short one
 * starts open. The measurement then settles it either way.
 */
function looksLong(content: string): boolean {
    return content.length > 700 || content.split('\n').length > 14;
}

export interface CollapsibleMarkdownProps {
    content: string;
    size?: MarkdownContentSize;
    /** Height in px the content is clamped to while collapsed. */
    collapsedHeight?: number;
    className?: string;
    'data-testid'?: string;
}

/**
 * A record description rendered as Markdown, clamped to a few lines with a
 * "Show more" / "Show less" toggle when it is long, so a structured
 * description (sections, lists, tables) does not push the rest of the page
 * — the header actions, the panels — off the screen.
 *
 * The toggle is a real button with `aria-expanded` / `aria-controls`.
 * Tabbing into a link hidden below the fold expands the content instead of
 * moving focus somewhere the reader cannot see.
 */
export function CollapsibleMarkdown({
    content,
    size = 'sm',
    collapsedHeight = DEFAULT_COLLAPSED_HEIGHT,
    className,
    'data-testid': testId,
}: CollapsibleMarkdownProps) {
    const t = useTranslations('common.markdown');
    const contentId = useId();
    const contentRef = useRef<HTMLDivElement | null>(null);
    const [expanded, setExpanded] = useState(false);
    const [overflowing, setOverflowing] = useState(() => looksLong(content));

    useEffect(() => {
        const element = contentRef.current;
        if (!element) return;
        const measure = () => {
            // `scrollHeight` is the full content height even while clamped.
            setOverflowing(element.scrollHeight > collapsedHeight * OVERFLOW_SLACK);
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [content, collapsedHeight]);

    const clamped = overflowing && !expanded;

    const handleFocus = (event: FocusEvent<HTMLDivElement>) => {
        if (!clamped) return;
        let keyboard = true;
        try {
            keyboard = event.target.matches(':focus-visible');
        } catch {
            // Engines without `:focus-visible` support: expand on any focus.
        }
        if (keyboard) setExpanded(true);
    };

    return (
        <div className={className} data-testid={testId}>
            <div
                id={contentId}
                ref={contentRef}
                onFocus={handleFocus}
                data-collapsed={clamped ? 'true' : 'false'}
                className={cn(
                    'relative',
                    clamped &&
                        'overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]',
                )}
                style={clamped ? { maxHeight: collapsedHeight } : undefined}
            >
                <MarkdownContent content={content} size={size} />
            </div>
            {overflowing ? (
                <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={contentId}
                    onClick={() => setExpanded((value) => !value)}
                    className="mt-1.5 inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                    {expanded ? (
                        <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                    ) : (
                        <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                    )}
                    {expanded ? t('showLess') : t('showMore')}
                </button>
            ) : null}
        </div>
    );
}
