'use client';

import { useId, useState, useTransition, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Pencil } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { validatorLength } from '@/lib/utils/text-length';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { MarkdownEditor } from '@/components/markdown/MarkdownEditor';

/** What a save answers: a refusal carries the API's reason, shown in the dialog. */
export type RecordEditResult = { ok: true } | { ok: false; error: string };

export interface RecordEditValues {
    title: string;
    description: string;
}

export interface RecordEditDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    dialogTitle: string;
    dialogDescription?: string;
    initialTitle: string;
    initialDescription: string;
    /** The API DTO's limits (`@MaxLength`), checked before the request. */
    titleMaxLength: number;
    descriptionMaxLength: number;
    /** `true` when the API rejects an empty description (`@MinLength(1)`). */
    descriptionRequired?: boolean;
    /**
     * Receives ONLY the fields that changed, trimmed (at least one). Sending an
     * unchanged description would overwrite a newer one an agent wrote while
     * the dialog was open, when the owner only fixed the title.
     */
    onSave: (changes: Partial<RecordEditValues>) => Promise<RecordEditResult>;
    /** Prefix for every `data-testid` in the dialog (e.g. `mission-edit`). */
    testIdPrefix: string;
}

const inputClass =
    'w-full rounded-lg border bg-white dark:bg-card-primary-dark px-3 py-2 text-sm text-text dark:text-text-dark placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/30';

/**
 * Edit a record's title and Markdown description: the dialog behind the
 * "Edit" action on the Mission and Goal detail pages.
 *
 * Validates the API's limits before sending, shows the API's own message when
 * it refuses (a server action that THROWS loses its message in a production
 * build, so `onSave` answers a value instead), and stays open on failure so
 * nothing typed is lost. Focus is trapped by the Headless UI dialog under
 * `ui/dialog`, like every other dialog in the app.
 *
 * Closing (Cancel, the close button, Escape, a click on the backdrop) with
 * unsaved changes asks first — the app's `window.confirm` pattern — and a
 * confirmed close discards the draft: the next opening starts from the record
 * as it is then. Nothing closes while a save is in flight. Lengths are counted
 * like the API's validators count them (`validatorLength`).
 */
export function RecordEditDialog({
    open,
    onOpenChange,
    dialogTitle,
    dialogDescription,
    initialTitle,
    initialDescription,
    titleMaxLength,
    descriptionMaxLength,
    descriptionRequired = false,
    onSave,
    testIdPrefix,
}: RecordEditDialogProps) {
    const t = useTranslations('common.recordEdit');
    const baseId = useId();
    const titleId = `${baseId}-title`;
    const titleErrorId = `${baseId}-title-error`;
    const descriptionId = `${baseId}-description`;

    const [titleDraft, setTitleDraft] = useState(initialTitle);
    const [descriptionDraft, setDescriptionDraft] = useState(initialDescription);
    const [titleError, setTitleError] = useState<string | null>(null);
    const [descriptionError, setDescriptionError] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [pending, startSave] = useTransition();

    // Every opening starts from the record as it is now — not from a draft a
    // cancelled edit left behind. Adjusting state during render on the
    // `open` edge is React's documented alternative to an effect here.
    const [wasOpen, setWasOpen] = useState(open);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open) {
            setTitleDraft(initialTitle);
            setDescriptionDraft(initialDescription);
            setTitleError(null);
            setDescriptionError(null);
            setSaveError(null);
        }
    }

    const title = titleDraft.trim();
    const description = descriptionDraft.trim();
    const titleChanged = title !== initialTitle.trim();
    const descriptionChanged = description !== initialDescription.trim();
    const changed = titleChanged || descriptionChanged;

    const close = () => {
        if (pending) return;
        if (changed && !window.confirm(t('discardConfirm'))) return;
        onOpenChange(false);
    };

    /** Validates only what will be sent: an unchanged field is not the user's to fix here. */
    const validate = (): boolean => {
        let nextTitleError: string | null = null;
        let nextDescriptionError: string | null = null;
        if (titleChanged) {
            if (title.length === 0) nextTitleError = t('titleRequired');
            else if (validatorLength(title) > titleMaxLength) {
                nextTitleError = t('titleTooLong', { max: titleMaxLength });
            }
        }
        if (descriptionChanged) {
            if (descriptionRequired && description.length === 0) {
                nextDescriptionError = t('descriptionRequired');
            } else if (validatorLength(description) > descriptionMaxLength) {
                nextDescriptionError = t('descriptionTooLong', { max: descriptionMaxLength });
            }
        }
        setTitleError(nextTitleError);
        setDescriptionError(nextDescriptionError);
        return nextTitleError === null && nextDescriptionError === null;
    };

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (pending) return;
        setSaveError(null);
        if (!changed) {
            onOpenChange(false);
            return;
        }
        if (!validate()) return;
        const changes: Partial<RecordEditValues> = {};
        if (titleChanged) changes.title = title;
        if (descriptionChanged) changes.description = description;
        startSave(async () => {
            try {
                const result = await onSave(changes);
                if (result.ok) {
                    onOpenChange(false);
                } else {
                    setSaveError(result.error || t('saveError'));
                }
            } catch (err) {
                setSaveError(err instanceof Error && err.message ? err.message : t('saveError'));
            }
        });
    };

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
            <DialogContent className="max-w-3xl">
                <DialogClose onClose={close} />
                <form onSubmit={handleSubmit} noValidate data-testid={`${testIdPrefix}-dialog`}>
                    <DialogHeader>
                        <div className="flex items-center gap-2.5">
                            <span className="flex items-center justify-center size-8 rounded-lg border border-border/60 dark:border-border-dark/60 bg-surface-secondary dark:bg-surface-secondary-dark shrink-0">
                                <Pencil
                                    className="size-3.5 text-text-secondary dark:text-text-secondary-dark"
                                    aria-hidden="true"
                                />
                            </span>
                            <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                                {dialogTitle}
                            </DialogTitle>
                        </div>
                        {dialogDescription ? (
                            <DialogDescription>{dialogDescription}</DialogDescription>
                        ) : null}
                    </DialogHeader>

                    <div className="space-y-5">
                        <div className="space-y-1.5">
                            <label
                                htmlFor={titleId}
                                className="block text-sm font-medium text-text dark:text-text-dark"
                            >
                                {t('titleLabel')}
                                <span aria-hidden="true" className="ml-0.5 text-danger">
                                    *
                                </span>
                            </label>
                            <input
                                id={titleId}
                                value={titleDraft}
                                onChange={(event) => setTitleDraft(event.target.value)}
                                required
                                disabled={pending}
                                aria-invalid={titleError ? true : undefined}
                                aria-describedby={titleError ? titleErrorId : undefined}
                                data-testid={`${testIdPrefix}-title`}
                                className={cn(
                                    inputClass,
                                    titleError
                                        ? 'border-danger/50 focus:border-danger'
                                        : 'border-border dark:border-border-dark focus:border-primary',
                                )}
                            />
                            {titleError ? (
                                <p id={titleErrorId} role="alert" className="text-xs text-danger">
                                    {titleError}
                                </p>
                            ) : null}
                        </div>

                        <MarkdownEditor
                            id={descriptionId}
                            label={t('descriptionLabel')}
                            value={descriptionDraft}
                            onChange={setDescriptionDraft}
                            maxLength={descriptionMaxLength}
                            required={descriptionRequired}
                            disabled={pending}
                            placeholder={t('descriptionPlaceholder')}
                            error={descriptionError}
                            rows={14}
                            data-testid={`${testIdPrefix}-description`}
                        />
                    </div>

                    {saveError ? (
                        <p
                            role="alert"
                            data-testid={`${testIdPrefix}-error`}
                            className="mt-4 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger"
                        >
                            {saveError}
                        </p>
                    ) : null}

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={pending}
                            onClick={close}
                            data-testid={`${testIdPrefix}-cancel`}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            type="submit"
                            size="sm"
                            loading={pending}
                            disabled={pending || !changed}
                            data-testid={`${testIdPrefix}-save`}
                        >
                            {pending ? t('saving') : t('save')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
