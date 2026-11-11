import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const refresh = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh }),
}));

import { BrowserTimezoneCookie } from './BrowserTimezoneCookie';
import { BROWSER_TIMEZONE_COOKIE } from '@/lib/browser-timezone';

function clearCookie() {
    document.cookie = `${BROWSER_TIMEZONE_COOKIE}=; path=/; max-age=0`;
}

function cookieValue(): string | null {
    const part = document.cookie
        .split(';')
        .map((p) => p.trim())
        .find((p) => p.startsWith(`${BROWSER_TIMEZONE_COOKIE}=`));
    return part ? decodeURIComponent(part.split('=')[1]) : null;
}

describe('BrowserTimezoneCookie', () => {
    beforeEach(() => {
        refresh.mockReset();
        clearCookie();
        vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
            timeZone: 'America/Los_Angeles',
        } as Intl.ResolvedDateTimeFormatOptions);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        clearCookie();
    });

    it("writes the browser's zone so the next server render can use it", () => {
        render(<BrowserTimezoneCookie />);
        expect(cookieValue()).toBe('America/Los_Angeles');
        expect(refresh).not.toHaveBeenCalled();
    });

    it('re-renders once when the summary fell back to UTC only for want of the cookie', () => {
        render(<BrowserTimezoneCookie refreshIfChanged />);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('writes nothing and refreshes nothing when the cookie already matches (no loop)', () => {
        document.cookie = `${BROWSER_TIMEZONE_COOKIE}=America%2FLos_Angeles; path=/`;
        render(<BrowserTimezoneCookie refreshIfChanged />);
        expect(refresh).not.toHaveBeenCalled();
    });

    it('updates a stale cookie after the device changed zone', () => {
        document.cookie = `${BROWSER_TIMEZONE_COOKIE}=Europe%2FKyiv; path=/`;
        render(<BrowserTimezoneCookie />);
        expect(cookieValue()).toBe('America/Los_Angeles');
    });
});
