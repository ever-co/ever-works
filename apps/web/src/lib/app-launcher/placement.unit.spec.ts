import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
    APP_LAUNCHER_PLACEMENT_STORAGE_KEY,
    DEFAULT_APP_LAUNCHER_PLACEMENT,
    parseAppLauncherPlacement,
    readAppLauncherPlacement,
    useAppLauncherPlacement,
    writeAppLauncherPlacement,
} from './placement';

/**
 * Shared Ever shell, A3 — where the App Launcher sits is a per-browser choice,
 * stored under Ever Teams' key and in Ever Teams' shape (Jotai's
 * `atomWithStorage` writes JSON), so the four Ever apps read alike.
 */
describe('App Launcher placement', () => {
    beforeEach(() => window.localStorage.clear());
    afterEach(() => vi.restoreAllMocks());

    it("uses Ever Teams' key and defaults to the sidebar", () => {
        expect(APP_LAUNCHER_PLACEMENT_STORAGE_KEY).toBe('app-switcher-placement');
        expect(DEFAULT_APP_LAUNCHER_PLACEMENT).toBe('sidebar');
        expect(readAppLauncherPlacement()).toBe('sidebar');
    });

    it('writes JSON, as Ever Teams does, and reads JSON or bare values', () => {
        writeAppLauncherPlacement('rail');
        expect(window.localStorage.getItem('app-switcher-placement')).toBe('"rail"');
        expect(readAppLauncherPlacement()).toBe('rail');
        expect(parseAppLauncherPlacement('header')).toBe('header');
        expect(parseAppLauncherPlacement('"header"')).toBe('header');
    });

    it('falls back to the sidebar for anything else', () => {
        expect(parseAppLauncherPlacement(null)).toBe('sidebar');
        expect(parseAppLauncherPlacement('"dock"')).toBe('sidebar');
        expect(parseAppLauncherPlacement('{')).toBe('sidebar');
    });

    it('falls back to the sidebar when storage throws', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });
        expect(readAppLauncherPlacement()).toBe('sidebar');
    });

    it('tells every reader in this tab, and follows another tab', () => {
        const { result } = renderHook(() => useAppLauncherPlacement());
        expect(result.current).toBe('sidebar');

        act(() => writeAppLauncherPlacement('header'));
        expect(result.current).toBe('header');

        act(() => {
            window.localStorage.setItem('app-switcher-placement', '"rail"');
            window.dispatchEvent(new StorageEvent('storage', { key: 'app-switcher-placement' }));
        });
        expect(result.current).toBe('rail');
    });
});
