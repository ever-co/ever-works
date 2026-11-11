import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { goalsAPI, type GoalEvent, type GoalMetricSample, type GoalSession } from '@/lib/api/goals';
import { agentsAPI } from '@/lib/api/agents';
import { recordVisibilityAPI } from '@/lib/api/record-visibility';
import { GoalDetailClient, type GoalAgentOption } from '@/components/goals';

/**
 * Goals & Metrics — PR-8. `/goals/[id]` detail page. Server-fetches
 * the Goal + its observation samples. Unknown ids / fetch failures
 * trigger notFound() so the user sees the standard 404 surface
 * instead of a half-rendered page; the samples fetch is defensive
 * (`.catch(() => [])`) so a flaky samples endpoint just renders the
 * empty sparkline state.
 */
type Params = Promise<{ id: string; locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
    const { id } = await params;
    const goal = await goalsAPI.get(id);
    if (!goal) {
        const t = await getTranslations('dashboard.goalsPage');
        return { title: t('title') };
    }
    return { title: goal.title };
}

export default async function GoalDetailPage({ params }: { params: Params }) {
    const { id } = await params;
    const goal = await goalsAPI.get(id);
    if (!goal) {
        notFound();
    }

    // Every secondary fetch degrades to an empty tab rather than a 404:
    // the orchestrator log and the session list are supporting evidence,
    // and losing one of them must not take the whole Goal page down.
    //
    // The Agent list feeds the Adjust-limits dialog's routing pin
    // (`assignedAgentId`). A pin is optional: without one the router
    // round-robins over the agents that have already worked this Goal and,
    // for a brand-new Goal, over the eligible agents in the Goal's own
    // Organization / tenant scope (self-build slice AG, finding R1) — so a
    // Goal created in the UI can start its loop as soon as the scope has
    // an agent, and `no-candidate-agent` now means the scope has none.
    const [samples, events, sessions, agents, visibility]: [
        GoalMetricSample[],
        GoalEvent[],
        GoalSession[],
        GoalAgentOption[],
        Awaited<ReturnType<typeof recordVisibilityAPI.get>>,
    ] = await Promise.all([
        goalsAPI.samples(id, 200).catch(() => []),
        goalsAPI.events(id, 200).catch(() => []),
        goalsAPI.sessions(id).catch(() => []),
        agentsAPI
            .list({ limit: 100 })
            .then((res) => res.data.map((agent) => ({ id: agent.id, name: agent.name })))
            .catch(() => []),
        // Who may change this Goal (the owner): gates the Edit action.
        // Unknown (a flaky endpoint) keeps the action, the API still refuses.
        recordVisibilityAPI.get('goal', id).catch(() => null),
    ]);

    return (
        <GoalDetailClient
            goal={goal}
            samples={samples}
            events={events}
            sessions={sessions}
            agents={agents}
            canEdit={visibility ? visibility.canEdit : true}
        />
    );
}
