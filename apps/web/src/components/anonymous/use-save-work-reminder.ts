'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useAnonymousAccount } from '@/lib/anonymous/anonymous-account-context';

/** Per-browser record of the Works already reminded about, so each gets the reminder once. */
export const SAVE_WORK_REMINDER_STORAGE_KEY = 'ew.saveWorkReminder.v1';
/** Enough for any anonymous account (the quota is a handful of Works); keeps the value small. */
const MAX_REMEMBERED = 50;

function readReminded(): string[] {
    try {
        const raw = window.localStorage.getItem(SAVE_WORK_REMINDER_STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
    } catch {
        return [];
    }
}

function rememberReminded(workId: string): void {
    try {
        const ids = [...readReminded().filter((id) => id !== workId), workId].slice(
            -MAX_REMEMBERED,
        );
        window.localStorage.setItem(SAVE_WORK_REMINDER_STORAGE_KEY, JSON.stringify(ids));
    } catch {
        // Storage blocked (private window, policy): the reminder may show again. Harmless.
    }
}

/**
 * EW-617 — the light reminder at the moment a temporary account has something to lose: a
 * Work whose generation finished. Answers a function the Work page calls:
 *
 *  - `remind(workId, true)` when a generation just finished in front of the visitor. For a
 *    temporary account this IS the "generation completed" toast, with the save action on it,
 *    so the visitor gets one toast, not two; it returns true so the caller skips its own.
 *  - `remind(workId, false)` when a finished Work is opened (the onboarding console opens it
 *    after generating, so no transition is seen). Shown once per Work per browser.
 *
 * Does nothing (returns false) for anyone the strip would not show to: registered accounts,
 * demo sandboxes, a demo instance. The persistent strip stays the main prompt; this only adds
 * a word at the right moment.
 */
export function useSaveWorkReminder(): (workId: string, justFinished: boolean) => boolean {
    // A boolean, never the context object: the object is a server prop, so every
    // router.refresh() delivers a NEW one, and a callback keyed on it changes identity on every
    // refresh. Callers that list it in an effect's deps would re-run that effect each time
    // (seen: an endless refresh loop after a cancelled generation).
    const isAnonymous = useAnonymousAccount() !== null;
    const t = useTranslations('anonymousAccount.reminder');
    const router = useRouter();

    return useCallback(
        (workId: string, justFinished: boolean) => {
            if (!isAnonymous) return false;
            if (!justFinished && readReminded().includes(workId)) return false;
            rememberReminded(workId);

            const show = justFinished ? toast.success : toast.info;
            // On the next tick, not now: on a full page load this runs in the Work page's
            // mount effect, BEFORE the root <Toaster> has subscribed (a child's effects run
            // before its parent's), and sonner drops a toast published with no subscriber.
            window.setTimeout(() => {
                show(justFinished ? t('ready') : t('kept'), {
                    id: `save-work-${workId}`,
                    description: t('description'),
                    duration: 10_000,
                    action: {
                        label: t('action'),
                        onClick: () => router.push(ROUTES.SAVE_ACCOUNT),
                    },
                });
            }, 0);
            return true;
        },
        [isAnonymous, router, t],
    );
}
