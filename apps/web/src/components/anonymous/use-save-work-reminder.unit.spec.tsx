import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    success: vi.fn(),
    info: vi.fn(),
    push: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: mocks.success, info: mocks.info } }));
vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { useTranslations: enUseTranslations };
});
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));

import { AnonymousAccountContext } from '@/lib/anonymous/anonymous-account-context';
import { SAVE_WORK_REMINDER_STORAGE_KEY, useSaveWorkReminder } from './use-save-work-reminder';

function renderReminder(anonymous: boolean) {
    const wrapper = ({ children }: { children: ReactNode }) => (
        <AnonymousAccountContext value={anonymous ? { expiresAt: null } : null}>
            {children}
        </AnonymousAccountContext>
    );
    return renderHook(() => useSaveWorkReminder(), { wrapper }).result;
}

describe('useSaveWorkReminder', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        window.localStorage.clear();
    });
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('does nothing for a registered account (no context), so its own toast shows', () => {
        const remind = renderReminder(false);

        expect(remind.current('w-1', true)).toBe(false);
        expect(remind.current('w-1', false)).toBe(false);
        expect(mocks.success).not.toHaveBeenCalled();
        expect(mocks.info).not.toHaveBeenCalled();
    });

    it('turns the "generation completed" moment into one toast with the save action', () => {
        const remind = renderReminder(true);

        expect(remind.current('w-1', true)).toBe(true);
        // Published on the next tick, once the root <Toaster> has subscribed (see below).
        expect(mocks.success).not.toHaveBeenCalled();
        vi.runAllTimers();
        expect(mocks.success).toHaveBeenCalledTimes(1);
        const [title, options] = mocks.success.mock.calls[0];
        expect(title).toBe('Your Work is ready');
        expect(options).toMatchObject({
            id: 'save-work-w-1',
            description:
                'Save your account to keep it. Temporary accounts are deleted after a few days.',
            action: { label: 'Save my account' },
        });

        act(() => options.action.onClick());
        expect(mocks.push).toHaveBeenCalledWith('/save-account');
    });

    it('reminds about an opened finished Work once per Work, then stays quiet', () => {
        const remind = renderReminder(true);

        expect(remind.current('w-1', false)).toBe(true);
        expect(remind.current('w-1', false)).toBe(false);
        expect(remind.current('w-2', false)).toBe(true);
        vi.runAllTimers();
        expect(mocks.info).toHaveBeenCalledTimes(2);
        expect(mocks.info.mock.calls[0][0]).toBe('This Work is on a temporary account');
        expect(JSON.parse(window.localStorage.getItem(SAVE_WORK_REMINDER_STORAGE_KEY)!)).toEqual([
            'w-1',
            'w-2',
        ]);
    });

    // Found on the local stack: on a full page load the Work page's mount effect runs before
    // the root <Toaster> subscribes (a child's effects run first), and sonner drops a toast
    // published with no subscriber, while the Work was already marked as reminded. So the
    // toast must not go out in the same tick as the call.
    it('never publishes in the same tick as the call, so a Toaster mounting after it gets it', () => {
        const remind = renderReminder(true);

        remind.current('w-1', false);
        expect(mocks.info).not.toHaveBeenCalled();
        vi.advanceTimersByTime(0);
        expect(mocks.info).toHaveBeenCalledTimes(1);
    });

    it('still reminds when storage is unreadable (private window), and does not throw', () => {
        window.localStorage.setItem(SAVE_WORK_REMINDER_STORAGE_KEY, '{not json');
        const remind = renderReminder(true);

        expect(remind.current('w-1', false)).toBe(true);
    });
});
