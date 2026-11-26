'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useMounted } from './use-mounted';

export type Theme = 'light' | 'dark';

/**
 * What the person picked (shared Ever shell, A4): a fixed theme, or `system`,
 * which follows the device. `system` is the absence of a stored theme — the
 * same rule `theme-init.ts` and `useTheme` have always applied — so nothing
 * stored before this choice existed changes meaning.
 */
export type ThemePreference = Theme | 'system';

export const THEME_PREFERENCES: ReadonlyArray<ThemePreference> = ['light', 'dark', 'system'];

interface UseThemeReturn {
    theme: Theme;
    isDark: boolean;
    toggleTheme: (newTheme?: Theme) => void;
    mounted: boolean;
}

const THEME_STORAGE_KEY = 'theme';

/**
 * Same-tab broadcast of a theme change. The `storage` event only reaches
 * other tabs, so without this a second `useTheme()` in the same tab (the
 * header toggle and the command palette's "Toggle dark mode") would keep a
 * stale theme after the other one switched it.
 */
export const THEME_CHANGE_EVENT = 'ever-works:theme-change';

/**
 * Applies theme to the document root
 */
function applyTheme(newTheme: Theme): void {
    const root = document.documentElement;
    if (newTheme === 'dark') {
        root.classList.add('dark');
    } else {
        root.classList.remove('dark');
    }
}

/**
 * Custom hook for managing theme state
 * Handles dark/light mode switching with localStorage persistence
 * Respects system preference if no stored theme is found
 */
export function useTheme(): UseThemeReturn {
    const mounted = useMounted();
    const [theme, setTheme] = useState<Theme>(() => {
        if (typeof window === 'undefined') {
            return 'light';
        }

        // Brave, Safari ITP, locked-down enterprise profiles, and
        // private-browsing modes all make `localStorage.getItem` throw.
        // Letting that throw inside `useState`'s lazy initialiser
        // aborts React's render and leaves the page blank — that's
        // the exact regression feature-detect-storage.spec is built
        // to catch. Wrap every browser-API access in try/catch and
        // fall back to a sensible default.
        let storedTheme: Theme | null = null;
        try {
            storedTheme = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
        } catch {
            storedTheme = null;
        }
        let prefersDark = false;
        try {
            prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        } catch {
            prefersDark = false;
        }
        return storedTheme || (prefersDark ? 'dark' : 'light');
    });

    useEffect(() => {
        applyTheme(theme);
    }, [theme]);

    useEffect(() => {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const handleSystemThemeChange = (event: MediaQueryListEvent) => {
            let storedTheme: Theme | null = null;
            try {
                storedTheme = localStorage.getItem(THEME_STORAGE_KEY) as Theme | null;
            } catch {
                storedTheme = null;
            }
            if (!storedTheme) {
                setTheme(event.matches ? 'dark' : 'light');
            }
        };

        const handleStorageChange = (event: StorageEvent) => {
            if (event.key !== THEME_STORAGE_KEY) return;
            if (event.newValue === 'light' || event.newValue === 'dark') {
                setTheme(event.newValue);
            } else if (event.newValue == null) {
                // Another tab picked System: follow the device again.
                setTheme(systemTheme());
            }
        };

        const handleSameTabChange = (event: Event) => {
            const next = (event as CustomEvent<unknown>).detail;
            if (next === 'light' || next === 'dark') {
                setTheme(next);
            }
        };

        mediaQuery.addEventListener('change', handleSystemThemeChange);
        window.addEventListener('storage', handleStorageChange);
        window.addEventListener(THEME_CHANGE_EVENT, handleSameTabChange);

        return () => {
            mediaQuery.removeEventListener('change', handleSystemThemeChange);
            window.removeEventListener('storage', handleStorageChange);
            window.removeEventListener(THEME_CHANGE_EVENT, handleSameTabChange);
        };
    }, []);

    const toggleTheme = (newTheme?: Theme) => {
        const targetTheme: Theme = newTheme || (theme === 'dark' ? 'light' : 'dark');
        setTheme(targetTheme);
        try {
            localStorage.setItem(THEME_STORAGE_KEY, targetTheme);
        } catch {
            // localStorage may be disabled — DOM still gets the update.
        }
        applyTheme(targetTheme);
        try {
            window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: targetTheme }));
        } catch {
            // CustomEvent unavailable — this instance is still correct.
        }
    };

    return {
        theme,
        isDark: theme === 'dark',
        toggleTheme,
        mounted,
    };
}

/** The device's theme, `light` when it cannot be read. */
function systemTheme(): Theme {
    try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
        return 'light';
    }
}

/** Same-tab broadcast of a preference change (a `system` pick stores nothing). */
const THEME_PREFERENCE_EVENT = 'ever-works:theme-preference-change';

/** The stored choice: `light`, `dark`, or `system` when nothing is stored. */
export function readThemePreference(): ThemePreference {
    if (typeof window === 'undefined') return 'system';
    try {
        const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
        return stored === 'light' || stored === 'dark' ? stored : 'system';
    } catch {
        return 'system';
    }
}

/**
 * Apply and keep a choice. `system` removes the stored theme, so the page
 * follows the device from now on (and on the next load, through the inline
 * init script). Every `useTheme()` in this tab hears the resolved theme, the
 * other tabs hear the storage change.
 */
export function setThemePreference(preference: ThemePreference): void {
    const resolved: Theme = preference === 'system' ? systemTheme() : preference;
    try {
        if (preference === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
        else window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
        // Storage refused: the page still switches for this visit.
    }
    applyTheme(resolved);
    try {
        window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: resolved }));
        window.dispatchEvent(new Event(THEME_PREFERENCE_EVENT));
    } catch {
        // CustomEvent unavailable — the DOM is already updated.
    }
}

function subscribePreference(onChange: () => void): () => void {
    const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === THEME_STORAGE_KEY) onChange();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(THEME_PREFERENCE_EVENT, onChange);
    // The header toggle stores an explicit theme through `toggleTheme`.
    window.addEventListener(THEME_CHANGE_EVENT, onChange);
    return () => {
        window.removeEventListener('storage', onStorage);
        window.removeEventListener(THEME_PREFERENCE_EVENT, onChange);
        window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    };
}

/** The person's theme choice, kept current. `system` on the server. */
export function useThemePreference(): ThemePreference {
    return useSyncExternalStore(subscribePreference, readThemePreference, () => 'system');
}
