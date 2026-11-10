'use client';

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import type { Goal } from '@/lib/api/goals';
import { RecordEditDialog } from '@/components/common/RecordEditDialog';
import { updateGoalDetailsAction } from './actions';

/** `UpdateGoalDto` (apps/api/src/goals/dto/goal.dto.ts). */
export const GOAL_TITLE_MAX_LENGTH = 200;
export const GOAL_DESCRIPTION_MAX_LENGTH = 10000;

export interface GoalEditDialogProps {
    goal: Pick<Goal, 'id' | 'title' | 'description'>;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Receives the Goal the API answered, so the page shows it at once. */
    onSaved: (goal: Goal) => void;
}

/**
 * The Goal detail page's Edit action: title + Markdown description with a
 * Write / Preview editor, saved through `PATCH /api/me/goals/:id`. A Goal's
 * description is optional; clearing it sends `null`.
 */
export function GoalEditDialog({ goal, open, onOpenChange, onSaved }: GoalEditDialogProps) {
    const t = useTranslations('dashboard.goalDetail.editDialog');
    const router = useRouter();

    return (
        <RecordEditDialog
            open={open}
            onOpenChange={onOpenChange}
            dialogTitle={t('title')}
            dialogDescription={t('description')}
            initialTitle={goal.title}
            initialDescription={goal.description ?? ''}
            titleMaxLength={GOAL_TITLE_MAX_LENGTH}
            descriptionMaxLength={GOAL_DESCRIPTION_MAX_LENGTH}
            testIdPrefix="goal-edit"
            onSave={async (values) => {
                const result = await updateGoalDetailsAction(goal.id, values);
                if (!result.success) return { ok: false, error: result.error };
                onSaved(result.goal);
                toast.success(t('saved'));
                router.refresh();
                return { ok: true };
            }}
        />
    );
}
