import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import type { Work } from '@/lib/api/types-only';
import { GenerateStatusType } from '@/lib/api/enums';

/**
 * Regression (PR #3300 review): an anonymous account's save reminder made WorkLayoutClient
 * call router.refresh() forever after a cancelled generation. The reminder callback was keyed
 * on the anonymous-account context OBJECT, a server prop that is new on every refresh, and the
 * status effect listed it in its deps; the cancellation branch refreshes whenever that effect
 * runs. Measured before the fix: anonymous 20 refreshes in 20 ticks, registered 1.
 */

const getWorkForStatusRefresh = vi.fn();
const refresh = vi.fn();
const toastInfo = vi.fn();

vi.mock('@/app/actions/dashboard/works', () => ({
    syncWorkData: vi.fn().mockResolvedValue(undefined),
    getWorkForStatusRefresh: (...args: unknown[]) => getWorkForStatusRefresh(...args),
}));
const tCache = new Map<string, (key: string) => string>();
vi.mock('next-intl', () => ({
    // Stable per namespace, as next-intl's memoised translator is.
    useTranslations: (ns: string) => {
        if (!tCache.has(ns)) tCache.set(ns, (key: string) => `${ns}.${key}`);
        return tCache.get(ns)!;
    },
}));
/** Set by the Shell below: re-renders it, the way an RSC refresh delivers fresh props. */
let rerenderShell: (() => void) | null = null;
const stableRouter = {
    refresh: (...a: unknown[]) => {
        refresh(...a);
        // On a timer, as a real refresh lands after the current commit.
        setTimeout(() => rerenderShell?.(), 0);
    },
    push: vi.fn(),
};
vi.mock('@/i18n/navigation', () => ({ useRouter: () => stableRouter }));
vi.mock('sonner', () => ({
    toast: { info: (...a: unknown[]) => toastInfo(...a), error: vi.fn(), success: vi.fn() },
}));
const bg = { markGenerating: vi.fn(), clearGenerating: vi.fn() };
vi.mock('@/lib/hooks/use-background-activity', () => ({ useBackgroundActivity: () => bg }));
vi.mock('@/lib/hooks/use-dashboard-current-work', () => ({
    setDashboardCurrentWork: vi.fn(),
    clearDashboardCurrentWork: vi.fn(),
}));
vi.mock('./WorkHeader', () => ({ WorkHeader: () => null }));
vi.mock('./WorkTabs', () => ({ WorkTabs: () => null }));
vi.mock('./WorkDetailContext', () => ({
    WorkDetailProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { WorkLayoutClient } from './WorkLayoutClient';
import { AnonymousAccountContext } from '@/lib/anonymous/anonymous-account-context';

const generating = {
    id: 'w1',
    name: 'W',
    slug: 'w',
    kind: 'app',
    generateStatus: { status: GenerateStatusType.GENERATING },
} as unknown as Work;
const cancelledAsError = () =>
    ({
        ...generating,
        generateStatus: { status: GenerateStatusType.ERROR, error: 'Generation cancelled by user' },
    }) as unknown as Work;

/** Models the RSC refresh: every router.refresh() re-renders the shell with fresh props. */
function Shell({ anonymous }: { anonymous: boolean }) {
    const [renders, setRenders] = useState(0);
    useEffect(() => {
        rerenderShell = () => setRenders((n) => n + 1);
        return () => {
            rerenderShell = null;
        };
    }, []);
    // A fresh object per render, as a deserialised server prop is.
    const strip = anonymous ? { expiresAt: '2030-01-01T00:00:00.000Z' } : null;
    const work = renders === 0 ? generating : cancelledAsError();
    return (
        <AnonymousAccountContext value={strip}>
            <WorkLayoutClient work={work} oauthConnection={null} config={null}>
                <p>body</p>
            </WorkLayoutClient>
        </AnonymousAccountContext>
    );
}

describe('WorkLayoutClient — no refresh loop after a cancelled generation', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        refresh.mockReset();
        toastInfo.mockReset();
        getWorkForStatusRefresh.mockReset().mockResolvedValue(cancelledAsError());
    });
    afterEach(() => vi.useRealTimers());

    it.each([
        ['registered', false],
        ['anonymous', true],
    ])('%s account: refreshes at most once', async (_label, anonymous) => {
        render(<Shell anonymous={anonymous} />);
        for (let i = 0; i < 20; i++) {
            await act(async () => {
                await vi.advanceTimersByTimeAsync(10);
            });
        }
        expect(refresh.mock.calls.length).toBeLessThanOrEqual(1);
        expect(toastInfo.mock.calls.length).toBeLessThanOrEqual(1);
    });
});
