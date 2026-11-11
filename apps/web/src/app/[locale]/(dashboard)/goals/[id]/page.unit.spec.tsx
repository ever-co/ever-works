import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * PR #3137 — the Goal page shows Edit only to a viewer the API says may change the Goal
 * (`GET /api/record-visibility/goal/:id` → `canEdit`), and keeps it when that answer
 * cannot be read (the API is still the gate).
 */

const { getGoal, visibilityGet } = vi.hoisted(() => ({
    getGoal: vi.fn(),
    visibilityGet: vi.fn(),
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
    agentsAPI: { list: vi.fn().mockResolvedValue({ data: [] }) },
}));
vi.mock('@/lib/api/record-visibility', () => ({ recordVisibilityAPI: { get: visibilityGet } }));
vi.mock('@/components/goals', () => ({
    GoalDetailClient: ({ canEdit }: { canEdit?: boolean }) => (
        <div data-testid="goal-detail" data-can-edit={String(canEdit)} />
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
    getGoal.mockResolvedValue({ id: 'g1', title: 'G', description: null });
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
