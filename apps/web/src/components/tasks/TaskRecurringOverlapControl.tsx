'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Task } from '@/lib/api/tasks';
import { setTaskRecurringAction } from '@/app/actions/tasks';
import {
    MAX_OPEN_INSTANCES_LIMIT,
    formatMaxOpenInstances,
    parseMaxOpenInstances,
} from './recurring-overlap';

/* Same rail scale as `TaskRecurringSection` (label, `xs` input height). */
const FIELD_LABEL_CLASS = 'block text-[10px] uppercase tracking-wide text-text-muted mb-1';
const FIELD_CLASS = 'h-8 px-2 py-0 text-xs';
const HINT_CLASS = 'mt-1 text-[10px] leading-relaxed text-text-muted dark:text-text-muted-dark';

/**
 * Recurring Tasks overlap limit — the "At most N open at a time" number field (blank = no
 * limit). Controlled: the "Make recurring" form owns its text and sends it with the cadence.
 */
export function MaxOpenInstancesField({
    id,
    value,
    onChange,
    disabled,
}: {
    id: string;
    value: string;
    onChange: (next: string) => void;
    disabled?: boolean;
}) {
    const t = useTranslations('dashboard.tasksPage.recurring');
    const invalid = !parseMaxOpenInstances(value).ok;
    const hintId = `${id}-hint`;
    return (
        <div>
            <label htmlFor={id} className={FIELD_LABEL_CLASS}>
                {t('maxOpenInstances')}
            </label>
            <Input
                id={id}
                type="number"
                inputMode="numeric"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                min={1}
                max={MAX_OPEN_INSTANCES_LIMIT}
                step={1}
                placeholder="∞"
                disabled={disabled}
                variant="form"
                className={FIELD_CLASS}
                aria-invalid={invalid || undefined}
                aria-describedby={hintId}
                data-testid="task-recurring-max-open"
            />
            <p id={hintId} className={invalid ? `${HINT_CLASS} text-danger` : HINT_CLASS}>
                {invalid
                    ? t('maxOpenInstancesInvalid', { max: MAX_OPEN_INSTANCES_LIMIT })
                    : t('maxOpenInstancesHint')}
            </p>
        </div>
    );
}

/**
 * The same limit on a Task that is ALREADY recurring: the field plus its own Save, which
 * changes only the limit (`POST /api/tasks/:id/recurring` with the limit alone) and leaves the
 * cadence and the next fire exactly as they are.
 */
export function MaxOpenInstancesEditor({ task }: { task: Task }) {
    const t = useTranslations('dashboard.tasksPage.recurring');
    const router = useRouter();
    const saved = formatMaxOpenInstances(task.recurrenceMaxOpenInstances);
    const [text, setText] = useState(saved);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const parsed = parseMaxOpenInstances(text);
    const dirty = text.trim() !== saved;

    const handleSave = () => {
        if (!parsed.ok) return;
        setError(null);
        startTransition(() => {
            void (async () => {
                try {
                    await setTaskRecurringAction(task.id, {
                        recurrenceMaxOpenInstances: parsed.value,
                    });
                    router.refresh();
                } catch (err) {
                    setError(err instanceof Error ? err.message : t('saveError'));
                }
            })();
        });
    };

    return (
        <div className="space-y-2" data-testid="task-recurring-max-open-editor">
            <MaxOpenInstancesField
                id="task-recurring-max-open"
                value={text}
                onChange={setText}
                disabled={pending}
            />
            {dirty && (
                <Button
                    type="button"
                    size="sm"
                    onClick={handleSave}
                    disabled={pending || !parsed.ok}
                    data-testid="task-recurring-max-open-save"
                >
                    {pending ? '…' : t('save')}
                </Button>
            )}
            {error && (
                <p className="text-xs text-danger" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}
