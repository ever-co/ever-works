import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { readThemePreference, setThemePreference, useTheme, useThemePreference } from './use-theme';

/**
 * Shared Ever shell, A4 — Light, Dark or System. System is "no stored theme",
 * the rule the inline init script and `useTheme` already follow, so a choice
 * stored before this existed keeps its meaning.
 */

function stubDevice(dark: boolean) {
    vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({
            matches: dark && query === '(prefers-color-scheme: dark)',
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })),
    );
}

beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
    stubDevice(false);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // The page's own memory of a pick (used when storage refuses it) goes back to System.
    setThemePreference('system');
    window.localStorage.clear();
});

describe('theme preference', () => {
    it('reads System when nothing is stored, and the stored theme otherwise', () => {
        expect(readThemePreference()).toBe('system');
        window.localStorage.setItem('theme', 'dark');
        expect(readThemePreference()).toBe('dark');
        window.localStorage.setItem('theme', 'nonsense');
        expect(readThemePreference()).toBe('system');
    });

    it('stores Light and Dark, and applies them to the page', () => {
        setThemePreference('dark');
        expect(window.localStorage.getItem('theme')).toBe('dark');
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        setThemePreference('light');
        expect(window.localStorage.getItem('theme')).toBe('light');
        expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    it('System removes the stored theme and follows the device', () => {
        window.localStorage.setItem('theme', 'light');
        stubDevice(true);
        setThemePreference('system');
        expect(window.localStorage.getItem('theme')).toBeNull();
        expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('tells readers in this tab, including after the header toggle stored a theme', () => {
        const preference = renderHook(() => useThemePreference());
        const header = renderHook(() => useTheme());
        expect(preference.result.current).toBe('system');
        act(() => setThemePreference('dark'));
        expect(preference.result.current).toBe('dark');
        expect(header.result.current.theme).toBe('dark');
        // The real top-bar toggle, not a hand-written event.
        act(() => header.result.current.toggleTheme());
        expect(window.localStorage.getItem('theme')).toBe('light');
        expect(preference.result.current).toBe('light');
        act(() => setThemePreference('system'));
        expect(preference.result.current).toBe('system');
    });

    it('tells the tiles the applied theme when storage reads but refuses writes', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        setThemePreference('dark');
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(readThemePreference()).toBe('dark');
        setThemePreference('system');
        expect(readThemePreference()).toBe('system');
    });

    it('keeps the tiles in step with the top-bar toggle when storage refuses writes', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        const preference = renderHook(() => useThemePreference());
        const header = renderHook(() => useTheme());
        act(() => header.result.current.toggleTheme());
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(preference.result.current).toBe('dark');
        act(() => header.result.current.toggleTheme());
        expect(preference.result.current).toBe('light');
    });

    it('follows the device again when another tab picks System', () => {
        stubDevice(true);
        window.localStorage.setItem('theme', 'light');
        const { result } = renderHook(() => useTheme());
        expect(result.current.theme).toBe('light');
        act(() => {
            window.localStorage.removeItem('theme');
            window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: null }));
        });
        expect(result.current.theme).toBe('dark');
    });

    it('keeps the pick for this page when the browser refuses storage', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });
        setThemePreference('dark');
        expect(readThemePreference()).toBe('dark');
        expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('treats an unknown stored value as System, as the page does', () => {
        window.localStorage.setItem('theme', 'auto');
        expect(readThemePreference()).toBe('system');
        stubDevice(true);
        expect(renderHook(() => useTheme()).result.current.theme).toBe('dark');
    });
});
