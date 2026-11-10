'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Mission, MissionOutputMode } from '@/lib/api/missions';
import { updateMissionAction } from '@/app/actions/dashboard/missions';
import type { MissionIsolationOffWork } from './mission-task-output-works';

const sectionCard =
    'rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5';

const MODES: MissionOutputMode[] = ['ideas', 'tasks', 'both'];

/** APW-08 T36 — the bounds the API enforces (plan §3.3). */
export const TASKS_PER_TICK = { min: 1, max: 3 } as const;
export const OPEN_TASKS_CAP = { min: 1, max: 10 } as const;

function clamp(raw: string, bounds: { min: number; max: number }, fallback: number): number {
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(bounds.max, Math.max(bounds.min, value));
}

/**
 * APW-08 T36 (FR-51…FR-53) — the Mission's **Output**: Ideas (as before), Tasks on its attached
 * App or Repository Works, or both; and, when it files Tasks, how many per tick and the
 * open-Tasks cap per Work.
 *
 * `hasTaskWork` is whether an App or Repository Work is attached as Improves or Operates. Filing
 * Tasks without one is allowed (the API answers `warnings: ['noAppWorkRelation']`), and the card
 * says what to attach instead of refusing.
 *
 * `isolationOffWorks` are the attached Repository Works whose Task isolation is off: a Task
 * there would get no branch and no pull request, so the Mission files nothing on them (the API
 * answers `warnings: ['repoWorkTaskIsolationOff']`). The card says so and links to each Work's
 * settings, where the owner turns it on; nothing turns it on for them.
 */
export function MissionOutputCard({
    mission,
    hasTaskWork,
    isolationOffWorks = [],
    onMissionChange,
}: {
    mission: Mission;
    hasTaskWork: boolean;
    isolationOffWorks?: readonly MissionIsolationOffWork[];
    onMissionChange: (mission: Mission) => void;
}) {
    const t = useTranslations('dashboard.missionDetail.output');
    const [pending, startSave] = useTransition();
    const [mode, setMode] = useState<MissionOutputMode>(mission.outputMode ?? 'ideas');
    const [perTick, setPerTick] = useState(String(mission.taskOutput?.tasksPerTick ?? 1));
    const [openCap, setOpenCap] = useState(String(mission.taskOutput?.openTasksCap ?? 3));
    const [warned, setWarned] = useState(false);
    const [warnedIsolationOff, setWarnedIsolationOff] = useState(false);
    const filesTasks = mode === 'tasks' || mode === 'both';

    const save = () => {
        const taskOutput = {
            tasksPerTick: clamp(perTick, TASKS_PER_TICK, 1),
            openTasksCap: clamp(openCap, OPEN_TASKS_CAP, 3),
        };
        startSave(async () => {
            try {
                const updated = await updateMissionAction(mission.id, {
                    outputMode: mode,
                    taskOutput,
                });
                onMissionChange(updated);
                setPerTick(String(updated.taskOutput?.tasksPerTick ?? taskOutput.tasksPerTick));
                setOpenCap(String(updated.taskOutput?.openTasksCap ?? taskOutput.openTasksCap));
                setWarned((updated.warnings ?? []).includes('noAppWorkRelation'));
                setWarnedIsolationOff(
                    (updated.warnings ?? []).includes('repoWorkTaskIsolationOff'),
                );
                toast.success(t('saved'));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('saveError'));
            }
        });
    };

    return (
        <section className={sectionCard} data-testid="mission-output-card">
            <h2 className="text-sm font-semibold text-text dark:text-text-dark mb-3">
                {t('title')}
            </h2>
            <div role="radiogroup" aria-label={t('title')} className="space-y-1.5">
                {MODES.map((value) => (
                    <label
                        key={value}
                        className="flex items-center gap-2 text-sm text-text dark:text-text-dark"
                    >
                        <input
                            type="radio"
                            name={`mission-output-${mission.id}`}
                            value={value}
                            checked={mode === value}
                            onChange={() => setMode(value)}
                            disabled={pending}
                            data-testid={`mission-output-${value}`}
                        />
                        {t(value)}
                    </label>
                ))}
            </div>

            {filesTasks ? (
                <div className="mt-4 space-y-3" data-testid="mission-output-limits">
                    <div className="grid grid-cols-2 gap-3">
                        <Input
                            label={t('tasksPerTick')}
                            type="number"
                            min={TASKS_PER_TICK.min}
                            max={TASKS_PER_TICK.max}
                            value={perTick}
                            onChange={(e) => setPerTick(e.target.value)}
                            disabled={pending}
                            data-testid="mission-output-per-tick"
                        />
                        <Input
                            label={t('openCap')}
                            type="number"
                            min={OPEN_TASKS_CAP.min}
                            max={OPEN_TASKS_CAP.max}
                            value={openCap}
                            onChange={(e) => setOpenCap(e.target.value)}
                            disabled={pending}
                            data-testid="mission-output-open-cap"
                        />
                    </div>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('appliesTo')}
                    </p>
                    {!hasTaskWork || warned ? (
                        <p
                            role="status"
                            className="text-xs text-text-secondary dark:text-text-secondary-dark"
                            data-testid="mission-output-no-app-work"
                        >
                            {t('noAppWork')}
                        </p>
                    ) : null}
                    {isolationOffWorks.length > 0 || warnedIsolationOff ? (
                        <div
                            role="status"
                            className="text-xs text-text-secondary dark:text-text-secondary-dark"
                            data-testid="mission-output-repo-isolation-off"
                        >
                            <p>{t('repoIsolationOff')}</p>
                            {isolationOffWorks.length > 0 ? (
                                <ul className="mt-1 list-disc ps-4">
                                    {isolationOffWorks.map((work) => (
                                        <li key={work.workId}>
                                            <Link
                                                href={ROUTES.DASHBOARD_WORK_SETTINGS(work.workId)}
                                                className="underline underline-offset-2"
                                            >
                                                {work.workName}
                                            </Link>
                                        </li>
                                    ))}
                                </ul>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            ) : null}

            <div className="mt-4">
                <Button
                    type="button"
                    size="sm"
                    onClick={save}
                    disabled={pending}
                    data-testid="mission-output-save"
                >
                    {t('save')}
                </Button>
            </div>
        </section>
    );
}
