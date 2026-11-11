'use client';

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { updateMissionDetailsAction } from '@/app/actions/dashboard/missions';
import type { Mission } from '@/lib/api/missions';
import { RecordEditDialog } from '@/components/common/RecordEditDialog';

/** `UpdateMissionDto` (apps/api/src/missions/dto/mission.dto.ts). */
export const MISSION_TITLE_MAX_LENGTH = 200;
export const MISSION_DESCRIPTION_MAX_LENGTH = 10000;

export interface MissionEditDialogProps {
    mission: Pick<Mission, 'id' | 'title' | 'description'>;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Receives the Mission the API answered, so the page shows it at once. */
    onSaved: (mission: Mission) => void;
}

/**
 * The Mission detail page's Edit action: title + Markdown description with a
 * Write / Preview editor, saved through `PATCH /api/me/missions/:id`. The API
 * requires a non-empty description (`@MinLength(1)`), so the dialog does too.
 */
export function MissionEditDialog({
    mission,
    open,
    onOpenChange,
    onSaved,
}: MissionEditDialogProps) {
    const t = useTranslations('dashboard.missionDetail.editDialog');
    const router = useRouter();

    return (
        <RecordEditDialog
            open={open}
            onOpenChange={onOpenChange}
            dialogTitle={t('title')}
            dialogDescription={t('description')}
            initialTitle={mission.title}
            initialDescription={mission.description ?? ''}
            titleMaxLength={MISSION_TITLE_MAX_LENGTH}
            descriptionMaxLength={MISSION_DESCRIPTION_MAX_LENGTH}
            descriptionRequired
            testIdPrefix="mission-edit"
            onSave={async (values) => {
                const result = await updateMissionDetailsAction(mission.id, values);
                if (!result.success) return { ok: false, error: result.error };
                onSaved(result.mission);
                toast.success(t('saved'));
                // The browser title and the server-rendered panels read the
                // Mission too; refresh them as well.
                router.refresh();
                return { ok: true };
            }}
        />
    );
}
