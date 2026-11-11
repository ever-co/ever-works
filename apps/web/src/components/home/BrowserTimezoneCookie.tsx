'use client';

import { useEffect } from 'react';
import { useRouter } from '@/i18n/navigation';
import {
    browserTimezoneCookie,
    detectBrowserTimezone,
    readBrowserTimezoneCookie,
} from '@/lib/browser-timezone';

/**
 * Keeps the `ew-browser-tz` cookie equal to this browser's IANA timezone, so
 * the server-rendered Home asks the API for the browser's "today" when the
 * profile has no timezone (see `lib/browser-timezone.ts`). Renders nothing.
 *
 * `refreshIfChanged` — when the cookie was missing or stale AND the summary
 * the server just rendered fell back to UTC, re-render once with the new
 * cookie, so even the very first visit shows the right day. It cannot loop:
 * after the write the cookie matches, and the next mount writes nothing.
 */
export function BrowserTimezoneCookie({
    refreshIfChanged = false,
}: {
    refreshIfChanged?: boolean;
}) {
    const router = useRouter();

    useEffect(() => {
        const timezone = detectBrowserTimezone();
        if (!timezone) return;
        if (readBrowserTimezoneCookie(document.cookie) === timezone) return;
        document.cookie = browserTimezoneCookie(timezone, {
            secure: window.location.protocol === 'https:',
        });
        if (refreshIfChanged) router.refresh();
    }, [refreshIfChanged, router]);

    return null;
}
