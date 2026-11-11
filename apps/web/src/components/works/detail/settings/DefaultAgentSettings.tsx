'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useRouter } from '@/i18n/navigation';
import { updateWorkDefaultAgent } from '@/app/actions/dashboard/works';
import { AgentSelect } from '@/components/tasks/AgentSelect';
import { useSettings } from './SettingsContext';

/**
 * The Work's default Agent (`defaultAgentId`) — the Agent that runs its new Tasks when nobody
 * picks one, tried before "the Work's only Agent". The point is an Agent that serves several
 * Works (a tenant- or organization-wide one), which is pinned to none of them and so was never
 * found by that older rule.
 *
 * Reuses the Task detail page's `AgentSelect` (the caller's non-archived Agents). Saves on
 * change through the same `PATCH /works/:id` path as the sibling cards; the API refuses an
 * Agent outside the Work's scope with a 404, which surfaces as the error toast and leaves the
 * stored value as it was.
 */
export function DefaultAgentSettings() {
    const t = useTranslations('dashboard.workDetail.settings.defaultAgent');
    const { context } = useSettings();
    const { work } = context;
    const router = useRouter();

    const [value, setValue] = useState(work.defaultAgentId ?? '');
    const [pending, startTransition] = useTransition();

    const save = (next: string) => {
        const previous = value;
        setValue(next);
        startTransition(async () => {
            try {
                const result = await updateWorkDefaultAgent(work.id, next || null);
                if (result.success) {
                    toast.success(t('saved'));
                    router.refresh();
                } else {
                    setValue(previous);
                    toast.error(result.error || t('saveFailed'));
                }
            } catch {
                setValue(previous);
                toast.error(t('saveFailed'));
            }
        });
    };

    return (
        <div
            className={cn(
                'rounded-lg border overflow-hidden',
                'bg-card dark:bg-card-primary-dark/30',
                'border-card-border dark:border-border-secondary-dark',
            )}
            data-testid="default-agent-settings"
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-border-secondary-dark">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
                <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('subtitle')}
                </p>
            </div>

            <div className="px-5 py-4 space-y-2">
                <label
                    htmlFor="work-default-agent"
                    className="block text-xs font-medium text-text dark:text-text-dark"
                >
                    {t('label')}
                </label>
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('description')}
                </p>
                <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                        <AgentSelect
                            id="work-default-agent"
                            value={value}
                            onValueChange={save}
                            disabled={pending}
                            size="sm"
                            noneLabel={t('none')}
                            testId="work-default-agent-select"
                        />
                    </div>
                    {pending && <Loader2 className="h-4 w-4 animate-spin text-text-muted" />}
                </div>
            </div>
        </div>
    );
}
