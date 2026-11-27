import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

/**
 * Shared Ever shell, A9 — Settings › Preferences holds Theme (A4), App
 * Launcher position (A3) and Language (A5), in that order.
 */

const replaceMock = vi.hoisted(() => vi.fn());

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
    useLocale: () => 'en',
}));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
    usePathname: () => '/settings/preferences',
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { PreferencesSettings } from './PreferencesSettings';
import { endonym } from './LanguagePreference';

beforeEach(() => {
    window.localStorage.clear();
    replaceMock.mockReset();
    window.history.replaceState({}, '', '/settings/preferences');
    vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({
            matches: false,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('PreferencesSettings', () => {
    it('shows Theme, App Launcher position and Language, in that order', () => {
        const { container } = render(<PreferencesSettings appLauncherEnabled />);
        const order = Array.from(
            container.querySelectorAll(
                '[data-testid="preferences-theme"], [data-testid="app-launcher-placement"], [data-testid="preferences-language"]',
            ),
        ).map((node) => node.getAttribute('data-testid'));
        expect(order).toEqual([
            'preferences-theme',
            'app-launcher-placement',
            'preferences-language',
        ]);
    });

    it('leaves the App Launcher position out where the launcher does not exist', () => {
        render(<PreferencesSettings appLauncherEnabled={false} />);
        expect(screen.queryByTestId('app-launcher-placement')).toBeNull();
        expect(screen.getByTestId('preferences-language')).toBeInTheDocument();
    });

    it('offers Light, Dark and System, marks System by default, and saves a pick', () => {
        render(<PreferencesSettings appLauncherEnabled={false} />);
        expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual([
            'light',
            'dark',
            'system',
        ]);
        expect(screen.getByTestId('theme-preference-system')).toBeChecked();
        fireEvent.click(screen.getByTestId('theme-preference-dark'));
        expect(window.localStorage.getItem('theme')).toBe('dark');
        expect(screen.getByTestId('theme-preference-dark')).toBeChecked();
    });

    it('lists every language by its own name and switches the locale in place', () => {
        render(<PreferencesSettings appLauncherEnabled={false} />);
        const select = screen.getByTestId('language-preference') as HTMLSelectElement;
        expect(select.value).toBe('en');
        expect(select.options).toHaveLength(21);
        expect(
            Array.from(select.options).find((option) => option.value === 'de')?.textContent,
        ).toBe(endonym('de'));
        fireEvent.change(select, { target: { value: 'fr' } });
        expect(replaceMock).toHaveBeenCalledWith('/settings/preferences', { locale: 'fr' });
    });

    it('keeps the query string when the language changes', () => {
        window.history.replaceState({}, '', '/settings/preferences?tab=billing&tag=a&tag=b');
        render(<PreferencesSettings appLauncherEnabled={false} />);
        fireEvent.change(screen.getByTestId('language-preference'), { target: { value: 'fr' } });
        expect(replaceMock).toHaveBeenCalledWith(
            { pathname: '/settings/preferences', query: { tab: 'billing', tag: ['a', 'b'] } },
            { locale: 'fr' },
        );
    });

    it('shows the same keyboard focus outline as the theme tiles', () => {
        render(<PreferencesSettings appLauncherEnabled={false} />);
        const classes = screen.getByTestId('language-preference').className;
        expect(classes).toContain('focus-visible:outline-2');
        expect(classes).toContain('focus-visible:outline-offset-2');
        expect(classes).toContain('focus-visible:outline-primary');
        expect(classes).not.toContain('ring-primary/30');
    });

    it('names a language in that language, capitalised', () => {
        expect(endonym('de')).toBe('Deutsch');
        expect(endonym('fr')).toBe('Français');
    });
});
