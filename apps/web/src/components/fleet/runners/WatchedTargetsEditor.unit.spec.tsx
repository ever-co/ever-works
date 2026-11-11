import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
    FLEET_ACTIONS_MAX_WATCHED_TARGETS,
    type FleetActionsWatchedTarget,
} from '@ever-works/contracts';

vi.mock('next-intl', async () => {
    const { testTranslations } = await import('../health/fleet-test-intl');
    return { useLocale: () => 'en-GB', useTranslations: testTranslations };
});
vi.mock('@/app/actions/fleet/runners', () => ({
    setFleetActionsWatchedTargetsAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

import { WatchedTargetsEditor } from './WatchedTargetsEditor';

const repos = (n: number): FleetActionsWatchedTarget[] =>
    Array.from({ length: n }, (_, i) => ({ scope: 'repo', target: `acme/repo-${i}` }));

const editor = (watched: FleetActionsWatchedTarget[]) =>
    render(
        <WatchedTargetsEditor
            open
            watched={watched}
            saved={false}
            available={watched}
            onClose={() => undefined}
            onSaved={() => undefined}
        />,
    );

describe('WatchedTargetsEditor — the API takes at most FLEET_ACTIONS_MAX_WATCHED_TARGETS', () => {
    it('cannot save a default list longer than the limit (it answered 400)', () => {
        editor(repos(FLEET_ACTIONS_MAX_WATCHED_TARGETS + 5));
        const save = screen.getByTestId('fleet-actions-watched-save') as HTMLButtonElement;
        expect(save.disabled).toBe(true);
    });

    it('can save a list at the limit', () => {
        editor(repos(FLEET_ACTIONS_MAX_WATCHED_TARGETS));
        const save = screen.getByTestId('fleet-actions-watched-save') as HTMLButtonElement;
        expect(save.disabled).toBe(false);
    });
});
