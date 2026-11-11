'use client';

import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { MissionTeamAgentDto, MissionTeamView } from '@/lib/api/missions';
import { getMissionTeamAction } from '@/app/actions/dashboard/missions';
import { agentLastRunStatusKey } from '@/components/agents/agent-card.shared';

const sectionCard =
    'rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5';

type Load =
    | { kind: 'loading' }
    | { kind: 'unavailable' }
    | { kind: 'ready'; view: MissionTeamView };

/** The card's status labels, by agent status. */
const STATUS_KEYS = {
    draft: 'statusDraft',
    active: 'statusActive',
    paused: 'statusPaused',
    running: 'statusRunning',
    error: 'statusError',
    archived: 'statusArchived',
} as const;

/**
 * **Team and agents** — who works on this Mission: the Teams that hold it as a
 * resource (name + link) with their Agent members, then the Agents scoped to
 * the Mission or to one of its attached Works that no listed Team shows. Each
 * Agent carries its status and its last run.
 *
 * One read (`GET /me/missions/:id/team`, owner-gated like the attached-Works
 * panel; every Agent is one the viewer may read). Self-fetching like
 * `MissionTasksOnWorksPanel`, so the Mission page passes only the id.
 */
export function MissionTeamPanel({ missionId }: { missionId: string }) {
    const t = useTranslations('dashboard.missionDetail.team');
    const card = useTranslations('dashboard.agentsPage.card');
    const format = useFormatter();
    const [load, setLoad] = useState<Load>({ kind: 'loading' });

    useEffect(() => {
        // The initial state is already `loading`; a page shows one Mission.
        let cancelled = false;
        getMissionTeamAction(missionId)
            .then((view) => {
                if (!cancelled) setLoad({ kind: 'ready', view });
            })
            .catch(() => {
                if (!cancelled) setLoad({ kind: 'unavailable' });
            });
        return () => {
            cancelled = true;
        };
    }, [missionId]);

    const statusLabel = (status: string): string =>
        status in STATUS_KEYS ? card(STATUS_KEYS[status as keyof typeof STATUS_KEYS]) : status;

    const lastRunLabel = (agent: MissionTeamAgentDto): string => {
        const run = agent.latestRun;
        const at = run ? new Date(run.finishedAt) : null;
        if (!run || !at || Number.isNaN(at.getTime())) return t('neverRan');
        const key = agentLastRunStatusKey(run.status);
        return card('lastRun', {
            time: format.relativeTime(at),
            status: key ? card(key) : (run.status ?? card('lastRunUnknown')),
        });
    };

    const tieLabel = (agent: MissionTeamView['agents'][number]): string => {
        if (agent.via === 'mission') return t('viaMission');
        if (agent.via === 'standing-tasks') {
            return agent.workName
                ? t('viaStandingTasks', { name: agent.workName })
                : t('viaStandingTasksUnnamed');
        }
        return agent.workName ? t('viaWork', { name: agent.workName }) : t('viaWorkUnnamed');
    };

    const agentRow = (agent: MissionTeamAgentDto, detail?: string | null) => (
        <li
            key={agent.id}
            className="flex items-center justify-between gap-3 py-2 text-xs"
            data-testid="mission-team-agent"
        >
            <div className="min-w-0">
                <Link
                    href={ROUTES.DASHBOARD_AGENT(agent.id)}
                    className="block truncate font-medium text-text hover:text-primary hover:underline dark:text-text-dark"
                >
                    {agent.name}
                </Link>
                {detail ? (
                    <span className="block truncate text-[11px] text-text-muted dark:text-text-muted-dark">
                        {detail}
                    </span>
                ) : null}
            </div>
            <div className="shrink-0 text-end">
                <span className="block text-text-secondary dark:text-text-secondary-dark">
                    {statusLabel(agent.status)}
                </span>
                <span
                    className="block text-[11px] text-text-muted dark:text-text-muted-dark"
                    suppressHydrationWarning
                >
                    {lastRunLabel(agent)}
                </span>
            </div>
        </li>
    );

    const view = load.kind === 'ready' ? load.view : null;
    const empty = view !== null && view.teams.length === 0 && view.agents.length === 0;

    return (
        <section className={sectionCard} data-testid="mission-team">
            <div className="flex items-center gap-2.5 mb-4">
                <div className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 border bg-surface-secondary dark:bg-surface-secondary-dark border-border/60 dark:border-border-dark/60">
                    <Users className="w-3.5 h-3.5 text-text-secondary dark:text-text-secondary-dark" />
                </div>
                <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h2>
            </div>
            {load.kind === 'loading' ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('loading')}</p>
            ) : load.kind === 'unavailable' ? (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('unavailable')}
                </p>
            ) : empty ? (
                <p
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="mission-team-empty"
                >
                    {t('empty')}
                </p>
            ) : (
                <div className="space-y-4">
                    {view?.teams.map((team) => (
                        <div key={team.id} data-testid="mission-team-team">
                            <Link
                                href={ROUTES.DASHBOARD_TEAM(team.id)}
                                className="text-xs font-semibold text-text hover:text-primary hover:underline dark:text-text-dark"
                            >
                                {team.name}
                            </Link>
                            {team.agents.length === 0 ? (
                                <p className="mt-1 text-[11px] text-text-muted dark:text-text-muted-dark">
                                    {t('teamNoAgents')}
                                </p>
                            ) : (
                                <ul className="divide-y divide-border/40 dark:divide-border-dark/40">
                                    {team.agents.map((agent) => agentRow(agent))}
                                </ul>
                            )}
                        </div>
                    ))}
                    {view && view.agents.length > 0 ? (
                        <div data-testid="mission-team-others">
                            <h3 className="text-xs font-semibold text-text dark:text-text-dark">
                                {view.teams.length > 0 ? t('otherAgents') : t('agents')}
                            </h3>
                            <ul className="divide-y divide-border/40 dark:divide-border-dark/40">
                                {view.agents.map((agent) => agentRow(agent, tieLabel(agent)))}
                            </ul>
                        </div>
                    ) : null}
                </div>
            )}
        </section>
    );
}
