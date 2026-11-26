'use client';

import { useSyncExternalStore } from 'react';

/**
 * Where the App Launcher's shortcut sits (shared Ever shell, A3): the Ever mark
 * at the top of the sidebar, an icon at the right end of the top bar, or a rail
 * of app icons left of the sidebar.
 *
 * Kept per browser, under the SAME key and values Ever Teams uses
 * (`apps/web/core/stores/common/app-switcher.ts`), so the Ever apps read alike.
 * Teams stores it through Jotai's `atomWithStorage`, which writes the value as
 * JSON (`"rail"`, quotes included); this module writes the same shape and reads
 * both the JSON and the bare form.
 */
export type AppLauncherPlacement = 'sidebar' | 'header' | 'rail';

export const APP_LAUNCHER_PLACEMENTS: ReadonlyArray<AppLauncherPlacement> = [
    'sidebar',
    'header',
    'rail',
];

export const DEFAULT_APP_LAUNCHER_PLACEMENT: AppLauncherPlacement = 'sidebar';

export const APP_LAUNCHER_PLACEMENT_STORAGE_KEY = 'app-switcher-placement';

/** Same-tab broadcast: the `storage` event only reaches other tabs. */
const PLACEMENT_CHANGE_EVENT = 'ever-works:app-launcher-placement-change';

export function isAppLauncherPlacement(value: unknown): value is AppLauncherPlacement {
    return APP_LAUNCHER_PLACEMENTS.some((placement) => placement === value);
}

/** The stored value, JSON (`"rail"`) or bare (`rail`); anything else is the default. */
export function parseAppLauncherPlacement(raw: string | null): AppLauncherPlacement {
    if (raw === null) return DEFAULT_APP_LAUNCHER_PLACEMENT;
    let value: unknown = raw;
    try {
        value = JSON.parse(raw);
    } catch {
        value = raw;
    }
    return isAppLauncherPlacement(value) ? value : DEFAULT_APP_LAUNCHER_PLACEMENT;
}

export function readAppLauncherPlacement(): AppLauncherPlacement {
    if (typeof window === 'undefined') return DEFAULT_APP_LAUNCHER_PLACEMENT;
    try {
        return parseAppLauncherPlacement(
            window.localStorage.getItem(APP_LAUNCHER_PLACEMENT_STORAGE_KEY),
        );
    } catch {
        // Private modes and locked-down profiles make storage throw: use the default.
        return DEFAULT_APP_LAUNCHER_PLACEMENT;
    }
}

/**
 * Store the choice and tell every reader in this tab. Throws when the browser
 * refuses to store it, so the caller can say the choice was not kept.
 */
export function writeAppLauncherPlacement(placement: AppLauncherPlacement): void {
    window.localStorage.setItem(APP_LAUNCHER_PLACEMENT_STORAGE_KEY, JSON.stringify(placement));
    window.dispatchEvent(new Event(PLACEMENT_CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
    const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === APP_LAUNCHER_PLACEMENT_STORAGE_KEY) onChange();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(PLACEMENT_CHANGE_EVENT, onChange);
    return () => {
        window.removeEventListener('storage', onStorage);
        window.removeEventListener(PLACEMENT_CHANGE_EVENT, onChange);
    };
}

function getServerSnapshot(): AppLauncherPlacement {
    return DEFAULT_APP_LAUNCHER_PLACEMENT;
}

/**
 * The person's choice. The server render and the hydration pass use the
 * default; the stored choice applies right after, without a hydration mismatch.
 */
export function useAppLauncherPlacement(): AppLauncherPlacement {
    return useSyncExternalStore(subscribe, readAppLauncherPlacement, getServerSnapshot);
}
