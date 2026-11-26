'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AppLauncherListResponse } from '@ever-works/contracts';
import {
    appLauncherCacheEntryFor,
    fetchAppLauncherList,
    isAppLauncherCacheFresh,
    storeAppLauncherList,
    subscribeAppLauncherCache,
} from './app-launcher-cache';

export interface AppLauncherListState {
    data: AppLauncherListResponse | null;
    loading: boolean;
    failed: boolean;
}

/**
 * The person's App Launcher list for one workspace scope, read through the
 * shared cache: what the panel already read is reused, a missing or stale entry
 * is fetched once, and a later refetch by the panel (or a reset after Manage
 * apps saved) redraws every reader. For surfaces that show the list without
 * being opened first — the left rail.
 */
export function useAppLauncherList(scopeKey: string | null): AppLauncherListState {
    const entry = useSyncExternalStore(
        subscribeAppLauncherCache,
        () => appLauncherCacheEntryFor(scopeKey),
        () => null,
    );
    // Set only from the read's own callbacks, never synchronously in the effect.
    const [failedScope, setFailedScope] = useState<string | null>(null);
    const hasEntry = entry !== null;

    useEffect(() => {
        if (scopeKey === null) return;
        const current = appLauncherCacheEntryFor(scopeKey);
        if (current !== null && isAppLauncherCacheFresh(current)) return;
        let cancelled = false;
        fetchAppLauncherList()
            .then((data) => {
                if (cancelled) return;
                storeAppLauncherList(scopeKey, data);
                setFailedScope(null);
            })
            .catch(() => {
                if (!cancelled) setFailedScope(scopeKey);
            });
        return () => {
            cancelled = true;
        };
        // `hasEntry`: a reset (Manage apps saved) drops the entry, which reads again.
    }, [scopeKey, hasEntry]);

    const failed = scopeKey !== null && failedScope === scopeKey && entry === null;
    return {
        data: entry?.data ?? null,
        // Nothing to show yet and the read has not failed: it is on its way.
        loading: scopeKey !== null && entry === null && !failed,
        failed,
    };
}
