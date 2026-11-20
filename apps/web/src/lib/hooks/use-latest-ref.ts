'use client';

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * `useLayoutEffect` in the browser, `useEffect` on the server (where neither
 * runs). Layout phase matters for the latest-ref pattern below: it lands
 * before any passive effect, timer or event handler can read the ref.
 */
export const useIsomorphicLayoutEffect =
    typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * A ref that always holds the latest COMMITTED `value` — for timers, sockets
 * and other callbacks that must see the current props/state without being
 * re-created (and re-subscribed) on every render.
 *
 * The write happens in a layout effect, not during render: a render React
 * throws away (StrictMode, a suspended or interrupted transition) never leaks
 * its value into the ref, and the React Compiler's `react-hooks/refs` rule
 * holds. Read `.current` only from callbacks and effects, never during render.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
    const ref = useRef(value);
    useIsomorphicLayoutEffect(() => {
        ref.current = value;
    });
    return ref;
}
