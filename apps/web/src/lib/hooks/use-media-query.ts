'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether a CSS media query matches, kept current. `false` on the server and
 * during hydration (no window to ask), then the real answer.
 */
export function useMediaQuery(query: string): boolean {
    const subscribe = useCallback(
        (onChange: () => void) => {
            if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
                return () => undefined;
            }
            const list = window.matchMedia(query);
            list.addEventListener('change', onChange);
            return () => list.removeEventListener('change', onChange);
        },
        [query],
    );
    const getSnapshot = useCallback(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
        return window.matchMedia(query).matches;
    }, [query]);
    return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Tailwind's `lg` breakpoint: where the dashboard sidebar stops being a drawer. */
export const DESKTOP_MEDIA_QUERY = '(min-width: 1024px)';

/** True from the `lg` breakpoint up. */
export function useIsDesktop(): boolean {
    return useMediaQuery(DESKTOP_MEDIA_QUERY);
}
