import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { readThemePreference, setThemePreference, useThemePreference } from './use-theme';

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
    vi.unstubAllGlobals();
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
        const { result } = renderHook(() => useThemePreference());
        expect(result.current).toBe('system');
        act(() => setThemePreference('dark'));
        expect(result.current).toBe('dark');
        act(() => {
            window.localStorage.setItem('theme', 'light');
            window.dispatchEvent(new CustomEvent('ever-works:theme-change', { detail: 'light' }));
        });
        expect(result.current).toBe('light');
        act(() => setThemePreference('system'));
        expect(result.current).toBe('system');
    });
});
