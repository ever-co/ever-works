'use client';

import { APP_LAUNCHER_CLIENT_CACHE_MS, type AppLauncherListResponse } from '@ever-works/contracts';
import { browserApiFetch } from '@/lib/api/browser-api';

/**
 * APW-11 — the App Launcher's client cache (plan §6.4), shared by every surface
 * that shows the person's apps: the panel (`AppLauncherButton`) and the left
 * rail (`AppLauncherRail`).
 *
 * One entry, keyed by the workspace scope: `GET /api/me/apps` is answered per
 * scope, so an entry from another scope is never handed out (spec FR-66 /
 * ACC-11-49). It is module-level on purpose — that is why a second open inside
 * five minutes is free — and it tells its subscribers when it changes, so the
 * rail redraws when the panel refetched, and both redraw when Manage apps
 * dropped the entry after a save.
 */

/** The registry read of plan §4.1, through the scope-stamping BFF transport. */
export const APPS_ENDPOINT = '/api/me/apps';

export interface AppLauncherCacheEntry {
    data: AppLauncherListResponse;
    fetchedAt: number;
    scopeKey: string;
}

let appLauncherCache: AppLauncherCacheEntry | null = null;
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of listeners) listener();
}

/** The entry for this scope, or `null` — never another scope's entry. */
export function appLauncherCacheEntryFor(scopeKey: string | null): AppLauncherCacheEntry | null {
    if (scopeKey === null || appLauncherCache === null) return null;
    return appLauncherCache.scopeKey === scopeKey ? appLauncherCache : null;
}

export function storeAppLauncherList(scopeKey: string, data: AppLauncherListResponse): void {
    appLauncherCache = { data, fetchedAt: Date.now(), scopeKey };
    notify();
}

/** Whether an entry is young enough to render without a refetch (FR-6). */
export function isAppLauncherCacheFresh(
    entry: AppLauncherCacheEntry,
    now: number = Date.now(),
): boolean {
    return now - entry.fetchedAt < APP_LAUNCHER_CLIENT_CACHE_MS;
}

/**
 * Drop the entry. Manage apps calls this after a save, so the next open and the
 * rail read the new arrangement instead of the five-minute-old one; specs call
 * it between cases.
 */
export function resetAppLauncherCache(): void {
    appLauncherCache = null;
    notify();
}

export function subscribeAppLauncherCache(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** One read of the registry. Throws on a non-2xx answer. */
export async function fetchAppLauncherList(): Promise<AppLauncherListResponse> {
    const response = await browserApiFetch(APPS_ENDPOINT);
    if (!response.ok) {
        throw new Error(`App launcher read failed with ${response.status}`);
    }
    return (await response.json()) as AppLauncherListResponse;
}
