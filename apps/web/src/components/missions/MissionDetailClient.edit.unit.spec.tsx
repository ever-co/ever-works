import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    Link: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/app/actions/dashboard/missions', () => ({
    pauseMissionAction: vi.fn(),
    resumeMissionAction: vi.fn(),
    completeMissionAction: vi.fn(),
    deleteMissionAction: vi.fn(),
    runMissionNowAction: vi.fn(),
    updateMissionAction: vi.fn(),
    cloneMissionAction: vi.fn(),
    updateMissionDetailsAction: vi.fn(),
}));

vi.mock('@/app/actions/dashboard/work-proposals', () => ({
    dismissProposalAction: vi.fn(),
}));

// The "Team and agents" panel fetches its own data and has its own spec;
// here it is only a placeholder (as in MissionDetailClient.unit.spec.tsx).
vi.mock('./MissionTeamPanel', () => ({
    MissionTeamPanel: () => <div data-testid="mission-team-stub" />,
}));

import { MissionDetailClient } from './MissionDetailClient';
import type { Mission } from '@/lib/api/missions';

function mkMission(overrides: Partial<Mission> = {}): Mission {
    return {
        id: 'm1',
        title: 'Cats Business',
        description: 'd',
        type: 'one-shot',
        status: 'active',
        schedule: null,
        autoBuildWorks: false,
        outstandingIdeasCap: null,
        guardrailsOverride: null,
        missionTemplateRepo: null,
        missionRepo: null,
        sourceMissionId: null,
        createdAt: '2026-05-24T00:00:00Z',
        updatedAt: '2026-05-24T00:00:00Z',
        ...overrides,
    };
}

describe('MissionDetailClient — Markdown description and Edit', () => {
    it('renders the description as Markdown, not one plain paragraph', () => {
        render(
            <MissionDetailClient
                mission={mkMission({
                    description:
                        '## Context\n\nWe sell **toys**.\n\n1. Audit `/signup`\n2. Ship it\n\n- [x] tracked',
                })}
                ideas={[]}
            />,
        );
        const description = screen.getByTestId('mission-description');
        expect(description.querySelector('h4')?.textContent).toBe('Context');
        expect(description.querySelector('strong')?.textContent).toBe('toys');
        expect(description.querySelectorAll('ol li')).toHaveLength(2);
        expect(description.querySelector('code')?.textContent).toBe('/signup');
        expect(description.textContent).not.toContain('##');
        expect(description.textContent).not.toContain('**');
    });

    it('offers Edit in the header actions and opens the editor with the current values', async () => {
        render(
            <MissionDetailClient
                mission={mkMission({ description: 'Sell **toys**' })}
                ideas={[]}
            />,
        );
        const edit = screen.getByTestId('mission-edit-button');
        expect(edit.textContent).toContain('actions.edit');
        expect(screen.queryByTestId('mission-edit-title')).toBeNull();

        fireEvent.click(edit);

        const title = (await screen.findByTestId('mission-edit-title')) as HTMLInputElement;
        expect(title.value).toBe('Cats Business');
        expect(
            (screen.getByTestId('mission-edit-description-textarea') as HTMLTextAreaElement).value,
        ).toBe('Sell **toys**');
    });

    it('hides Edit from a viewer who may not change the Mission', () => {
        render(<MissionDetailClient mission={mkMission()} ideas={[]} canEdit={false} />);
        expect(screen.queryByTestId('mission-edit-button')).toBeNull();
    });
});
