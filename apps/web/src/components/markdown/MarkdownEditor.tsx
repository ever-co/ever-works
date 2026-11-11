'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { validatorLength } from '@/lib/utils/text-length';
import { MarkdownContent } from './MarkdownContent';

type EditorMode = 'write' | 'preview';
const MODES: readonly EditorMode[] = ['write', 'preview'];

export interface MarkdownEditorProps {
    /** id of the textarea; the label points at it and the tab ids derive from it. */
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
    /** Shown as a live `n / max` counter; the caller validates on save. */
    maxLength?: number;
    rows?: number;
    placeholder?: string;
    /** Validation message for the field (renders under it, linked by aria-describedby). */
    error?: string | null;
    required?: boolean;
    disabled?: boolean;
    autoFocus?: boolean;
    /** Keep the label for assistive tech only, when a heading above already names the field. */
    hideLabel?: boolean;
    className?: string;
    'data-testid'?: string;
}

const tabClass = (selected: boolean) =>
    cn(
        'inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        selected
            ? 'border-border-secondary dark:border-border-secondary-dark bg-surface-secondary dark:bg-surface-secondary-dark font-medium text-text dark:text-text-dark'
            : 'border-border/60 dark:border-border-dark/60 text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark hover:border-border dark:hover:border-border-dark',
    );

/**
 * A Markdown field with Write / Preview tabs. The preview uses the same
 * `MarkdownContent` renderer the detail pages use, so what the author sees
 * is what the page will show.
 *
 * Accessibility: the textarea has a real `<label>`; the tabs follow the WAI
 * tabs pattern (roving tabindex, Arrow / Home / End move between them); the
 * hint, the counter and the error are wired through `aria-describedby`.
 * Both panels stay mounted (the inactive one `hidden`) so switching to
 * Preview and back keeps the caret and the undo history.
 */
export function MarkdownEditor({
    id,
    label,
    value,
    onChange,
    maxLength,
    rows = 12,
    placeholder,
    error,
    required,
    disabled,
    autoFocus,
    hideLabel = false,
    className,
    'data-testid': testId,
}: MarkdownEditorProps) {
    const t = useTranslations('common.markdown');
    const [mode, setMode] = useState<EditorMode>('write');
    const tabRefs = useRef<Record<EditorMode, HTMLButtonElement | null>>({
        write: null,
        preview: null,
    });

    const tabId = (m: EditorMode) => `${id}-tab-${m}`;
    const panelId = (m: EditorMode) => `${id}-panel-${m}`;
    const hintId = `${id}-hint`;
    const counterId = `${id}-counter`;
    const errorId = `${id}-error`;
    // Counted like the API's `@MaxLength` (an emoji is one character, not two).
    const length = validatorLength(value);
    const overLimit = typeof maxLength === 'number' && length > maxLength;

    const select = (next: EditorMode, focus: boolean) => {
        setMode(next);
        if (focus) tabRefs.current[next]?.focus();
    };

    const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        const index = MODES.indexOf(mode);
        let next: EditorMode | null = null;
        if (event.key === 'ArrowRight') next = MODES[(index + 1) % MODES.length];
        else if (event.key === 'ArrowLeft') next = MODES[(index - 1 + MODES.length) % MODES.length];
        else if (event.key === 'Home') next = MODES[0];
        else if (event.key === 'End') next = MODES[MODES.length - 1];
        if (!next) return;
        event.preventDefault();
        select(next, true);
    };

    const describedBy = [hintId, maxLength ? counterId : null, error ? errorId : null]
        .filter(Boolean)
        .join(' ');

    return (
        <div className={cn('space-y-2', className)} data-testid={testId}>
            <div
                className={cn(
                    'flex items-center gap-3 flex-wrap',
                    hideLabel ? 'justify-end' : 'justify-between',
                )}
            >
                <label
                    htmlFor={id}
                    className={cn(
                        'text-sm font-medium text-text dark:text-text-dark',
                        hideLabel && 'sr-only',
                    )}
                >
                    {label}
                    {required ? (
                        <span aria-hidden="true" className="ml-0.5 text-danger">
                            *
                        </span>
                    ) : null}
                </label>
                <div
                    role="tablist"
                    aria-label={t('tabsLabel', { field: label })}
                    className="flex gap-1.5"
                >
                    {MODES.map((m) => (
                        <button
                            key={m}
                            ref={(element) => {
                                tabRefs.current[m] = element;
                            }}
                            id={tabId(m)}
                            type="button"
                            role="tab"
                            aria-selected={mode === m}
                            aria-controls={panelId(m)}
                            tabIndex={mode === m ? 0 : -1}
                            onClick={() => select(m, false)}
                            onKeyDown={onTabKeyDown}
                            className={tabClass(mode === m)}
                            data-testid={testId ? `${testId}-tab-${m}` : undefined}
                        >
                            {m === 'write' ? (
                                <Pencil className="w-3 h-3" aria-hidden="true" />
                            ) : (
                                <Eye className="w-3 h-3" aria-hidden="true" />
                            )}
                            {m === 'write' ? t('write') : t('preview')}
                        </button>
                    ))}
                </div>
            </div>

            <div
                id={panelId('write')}
                role="tabpanel"
                aria-labelledby={tabId('write')}
                hidden={mode !== 'write'}
            >
                <textarea
                    id={id}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    rows={rows}
                    placeholder={placeholder}
                    required={required}
                    disabled={disabled}
                    autoFocus={autoFocus}
                    spellCheck
                    aria-invalid={error || overLimit ? true : undefined}
                    aria-describedby={describedBy}
                    data-testid={testId ? `${testId}-textarea` : undefined}
                    className={cn(
                        'w-full rounded-lg border bg-white dark:bg-card-primary-dark px-3 py-2',
                        'font-mono text-xs leading-relaxed resize-y text-text dark:text-text-dark',
                        'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                        'focus:outline-none focus:ring-2 focus:ring-primary/30',
                        'disabled:opacity-60 disabled:cursor-not-allowed',
                        error || overLimit
                            ? 'border-danger/50 focus:border-danger'
                            : 'border-border dark:border-border-dark focus:border-primary',
                    )}
                />
            </div>

            <div
                id={panelId('preview')}
                role="tabpanel"
                aria-labelledby={tabId('preview')}
                hidden={mode !== 'preview'}
                tabIndex={0}
                data-testid={testId ? `${testId}-preview` : undefined}
                className="rounded-lg border border-border/60 dark:border-border-dark/60 bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 px-4 py-3 min-h-40 max-h-[28rem] overflow-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
                {mode === 'preview' ? (
                    value.trim().length > 0 ? (
                        <MarkdownContent content={value} />
                    ) : (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('emptyPreview')}
                        </p>
                    )
                ) : null}
            </div>

            <div className="flex items-start justify-between gap-3 text-[11px] text-text-muted dark:text-text-muted-dark">
                <span id={hintId}>{t('hint')}</span>
                {typeof maxLength === 'number' ? (
                    <span
                        id={counterId}
                        className={cn(
                            'shrink-0 tabular-nums',
                            overLimit && 'text-danger font-medium',
                        )}
                    >
                        {t('counter', { count: length, max: maxLength })}
                    </span>
                ) : null}
            </div>
            {error ? (
                <p id={errorId} role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
