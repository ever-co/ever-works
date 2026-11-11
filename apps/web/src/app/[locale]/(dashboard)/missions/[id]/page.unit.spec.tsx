import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * PR #3137 — the Mission page shows Edit only to a viewer the API says may change the
 * Mission (`GET /api/record-visibility/mission/:id` → `canEdit`), and keeps it when that
 * answer cannot be read (the API is still the gate).
 */

const { getMission, visibilityGet } = vi.hoisted(() => ({
    getMission: vi.fn(),
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
vi.mock('@/lib/api/missions', () => ({
    missionsAPI: {
        get: getMission,
        getBudget: vi.fn().mockResolvedValue(null),
        listAttachments: vi.fn().mockResolvedValue([]),
        listWorks: vi.fn().mockResolvedValue([]),
        listGoals: vi.fn().mockResolvedValue([]),
    },
}));
vi.mock('@/lib/api/work-proposals', () => ({
    workProposalsAPI: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/lib/api/work', () => ({ workAPI: { getAll: vi.fn().mockResolvedValue(null) } }));
vi.mock('@/lib/api/goals', () => ({ goalsAPI: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock('@/lib/api/record-visibility', () => ({ recordVisibilityAPI: { get: visibilityGet } }));
vi.mock('@/components/missions', () => ({
    MissionDetailClient: ({ canEdit }: { canEdit?: boolean }) => (
        <div data-testid="mission-detail" data-can-edit={String(canEdit)} />
    ),
}));

import MissionDetailPage from './page';

async function renderPage() {
    const element = await MissionDetailPage({
        params: Promise.resolve({ id: 'm1', locale: 'en' }),
    });
    render(element);
    return screen.getByTestId('mission-detail').getAttribute('data-can-edit');
}

beforeEach(() => {
    getMission.mockReset();
    visibilityGet.mockReset();
    getMission.mockResolvedValue({ id: 'm1', title: 'M', description: 'd', sourceMissionId: null });
});

afterEach(cleanup);

describe('Mission detail page — canEdit wiring', () => {
    it('passes canEdit=true for the owner', async () => {
        visibilityGet.mockResolvedValue({ canEdit: true });
        expect(await renderPage()).toBe('true');
        expect(visibilityGet).toHaveBeenCalledWith('mission', 'm1');
    });

    it('passes canEdit=false to a viewer who may only read it', async () => {
        visibilityGet.mockResolvedValue({ canEdit: false });
        expect(await renderPage()).toBe('false');
    });

    it('keeps Edit when the visibility answer cannot be read (the API still refuses)', async () => {
        visibilityGet.mockRejectedValue(new Error('down'));
        expect(await renderPage()).toBe('true');
        visibilityGet.mockReset();
        visibilityGet.mockResolvedValue(null);
        cleanup();
        expect(await renderPage()).toBe('true');
    });
});
