import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * PR #3137 — the Goal page shows Edit only to a viewer the API says may change the Goal
 * (`GET /api/record-visibility/goal/:id` → `canEdit`), and keeps it when that answer
 * cannot be read (the API is still the gate).
 */

const { getGoal, visibilityGet, listAgents, lookupAgent } = vi.hoisted(() => ({
    getGoal: vi.fn(),
    visibilityGet: vi.fn(),
    listAgents: vi.fn(),
    lookupAgent: vi.fn(),
}));

vi.mock('next/navigation', () => ({
    notFound: () => {
        throw new Error('NEXT_NOT_FOUND');
    },
}));
vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/api/goals', () => ({
    goalsAPI: {
        get: getGoal,
        samples: vi.fn().mockResolvedValue([]),
        events: vi.fn().mockResolvedValue([]),
        sessions: vi.fn().mockResolvedValue([]),
    },
}));
vi.mock('@/lib/api/agents', () => ({
    agentsAPI: { list: listAgents, lookup: lookupAgent },
}));
vi.mock('@/lib/api/record-visibility', () => ({ recordVisibilityAPI: { get: visibilityGet } }));
vi.mock('@/components/goals', () => ({
    GoalDetailClient: ({
        canEdit,
        agents,
        missingAgentId,
    }: {
        canEdit?: boolean;
        agents?: Array<{ id: string }>;
        missingAgentId?: string | null;
    }) => (
        <div
            data-testid="goal-detail"
            data-can-edit={String(canEdit)}
            data-agents={(agents ?? []).map((agent) => agent.id).join(',')}
            data-missing-agent={String(missingAgentId)}
        />
    ),
}));

import GoalDetailPage from './page';

async function renderPage() {
    const element = await GoalDetailPage({ params: Promise.resolve({ id: 'g1', locale: 'en' }) });
    render(element);
    return screen.getByTestId('goal-detail').getAttribute('data-can-edit');
}

beforeEach(() => {
    getGoal.mockReset();
    visibilityGet.mockReset();
    listAgents.mockReset();
    lookupAgent.mockReset();
    getGoal.mockResolvedValue({ id: 'g1', title: 'G', description: null });
    listAgents.mockResolvedValue({ data: [] });
});

afterEach(cleanup);

describe('Goal detail page — canEdit wiring', () => {
    it('passes canEdit=true for the owner', async () => {
        visibilityGet.mockResolvedValue({ canEdit: true });
        expect(await renderPage()).toBe('true');
        expect(visibilityGet).toHaveBeenCalledWith('goal', 'g1');
    });

    it('passes canEdit=false to a viewer who may only read it', async () => {
        visibilityGet.mockResolvedValue({ canEdit: false });
        expect(await renderPage()).toBe('false');
    });

    it('keeps Edit when the visibility answer cannot be read (the API still refuses)', async () => {
        visibilityGet.mockRejectedValue(new Error('down'));
        expect(await renderPage()).toBe('true');
    });
});

/**
 * Review of #3172 — a pinned Agent the list does not hold is looked up on its
 * own: a 404 is reported as a deleted Agent, a failed read is not.
 */
describe('Goal detail page — the pinned Agent', () => {
    const rendered = async () => {
        await renderPage();
        const node = screen.getByTestId('goal-detail');
        return {
            agents: node.getAttribute('data-agents'),
            missing: node.getAttribute('data-missing-agent'),
        };
    };

    beforeEach(() => {
        visibilityGet.mockResolvedValue({ canEdit: true });
        getGoal.mockResolvedValue({ id: 'g1', title: 'G', assignedAgentId: 'pinned' });
    });

    it('reports a pin the API answers 404 for as missing', async () => {
        lookupAgent.mockResolvedValue({ status: 'missing' });
        expect(await rendered()).toEqual({ agents: '', missing: 'pinned' });
        expect(lookupAgent).toHaveBeenCalledWith('pinned');
    });

    it('adds a pinned Agent found past the list to the options', async () => {
        listAgents.mockResolvedValue({ data: [{ id: 'a1', name: 'A' }] });
        lookupAgent.mockResolvedValue({ status: 'found', agent: { id: 'pinned', name: 'P' } });
        expect(await rendered()).toEqual({ agents: 'a1,pinned', missing: 'null' });
    });

    it('does not call a failed read a deletion', async () => {
        lookupAgent.mockResolvedValue({ status: 'unknown' });
        expect(await rendered()).toEqual({ agents: '', missing: 'null' });
    });

    it('looks nothing up when the pin is listed, or there is none', async () => {
        listAgents.mockResolvedValue({ data: [{ id: 'pinned', name: 'P' }] });
        expect(await rendered()).toEqual({ agents: 'pinned', missing: 'null' });
        cleanup();
        getGoal.mockResolvedValue({ id: 'g1', title: 'G', assignedAgentId: null });
        expect(await rendered()).toEqual({ agents: 'pinned', missing: 'null' });
        expect(lookupAgent).not.toHaveBeenCalled();
    });
});
