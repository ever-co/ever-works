import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * Shared Ever shell, A3 — the three picture tiles in Settings: Sidebar, Top
 * bar, Left rail, with the line that says the choice is per browser; picking
 * one saves it at once, and a browser that refuses to store it says so.
 */

const toastError = vi.hoisted(() => vi.fn());

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock('sonner', () => ({ toast: { error: toastError } }));

import { AppLauncherPlacementTiles } from './AppLauncherPlacementTiles';

beforeEach(() => {
    window.localStorage.clear();
    toastError.mockReset();
    vi.restoreAllMocks();
});

describe('AppLauncherPlacementTiles', () => {
    it('shows the three positions in order, with the per-browser line', () => {
        render(<AppLauncherPlacementTiles />);
        expect(
            screen.getByText('dashboard.settings.appLauncher.placementDescription'),
        ).toBeInTheDocument();
        const radios = screen.getAllByRole('radio');
        expect(radios.map((radio) => radio.getAttribute('value'))).toEqual([
            'sidebar',
            'header',
            'rail',
        ]);
        for (const key of ['placementSidebar', 'placementHeader', 'placementRail']) {
            expect(screen.getByText(`dashboard.settings.appLauncher.${key}`)).toBeInTheDocument();
        }
        for (const placement of ['sidebar', 'header', 'rail']) {
            expect(
                screen.getByTestId(`app-launcher-placement-preview-${placement}`),
            ).toBeInTheDocument();
        }
    });

    it('marks the stored choice and saves a new one as it is picked', () => {
        window.localStorage.setItem('app-switcher-placement', '"header"');
        render(<AppLauncherPlacementTiles />);
        expect(screen.getByTestId('app-launcher-placement-header')).toBeChecked();

        fireEvent.click(screen.getByTestId('app-launcher-placement-rail'));
        expect(window.localStorage.getItem('app-switcher-placement')).toBe('"rail"');
        expect(screen.getByTestId('app-launcher-placement-rail')).toBeChecked();
        expect(screen.getByTestId('app-launcher-placement-header')).not.toBeChecked();
    });

    it('says so when the browser refuses to keep the choice', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        render(<AppLauncherPlacementTiles />);
        fireEvent.click(screen.getByTestId('app-launcher-placement-rail'));
        expect(toastError).toHaveBeenCalledWith(
            'dashboard.settings.appLauncher.placementSaveFailed',
        );
    });
});
