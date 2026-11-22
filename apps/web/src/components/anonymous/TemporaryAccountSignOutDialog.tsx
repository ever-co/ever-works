'use client';

import { useCallback, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { logout } from '@/app/actions/auth';
import { useRouter } from '@/i18n/navigation';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';

// Plain buttons with the shared look, like `EverIdSignOutDialog`: both dialogs mount in the
// sidebar and the command palette, so neither pulls the link-capable `Button` in.
const BUTTON_BASE =
    'inline-flex cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors h-9 px-4 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 dark:focus-visible:ring-white/20 disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * EW-617 — signing out of a temporary (anonymous) account is a one-way door: it has no email
 * or password to sign back in with, so its Works are out of reach and are deleted with it.
 * Every sign-out entry point (sidebar, command palette) asks first, the same way
 * `useEverIdSignOut` does for Ever ID sessions.
 *
 * `offerSaveFirst()` answers true when it opened the dialog (the caller stops: the dialog
 * signs out itself, or sends the visitor to save the account); false for any other account,
 * which signs out exactly as before.
 */
export function useTemporaryAccountSignOut(temporaryAccount: boolean) {
    const [open, setOpen] = useState(false);
    const offerSaveFirst = useCallback((): boolean => {
        if (temporaryAccount) setOpen(true);
        return temporaryAccount;
    }, [temporaryAccount]);
    return { offerSaveFirst, dialogProps: { open, onOpenChange: setOpen } };
}

interface TemporaryAccountSignOutDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function TemporaryAccountSignOutDialog({
    open,
    onOpenChange,
}: TemporaryAccountSignOutDialogProps) {
    const t = useTranslations('anonymousAccount.signOut');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();

    const close = () => {
        if (!isPending) onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !next && close()}>
            <DialogContent className="max-w-md">
                <div data-testid="temporary-account-sign-out-dialog">
                    <DialogHeader>
                        <DialogTitle className="text-lg font-medium text-text dark:text-text-dark">
                            {t('title')}
                        </DialogTitle>
                        <DialogDescription className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('body')}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2">
                        <button
                            type="button"
                            onClick={close}
                            disabled={isPending}
                            className={cn(
                                BUTTON_BASE,
                                'bg-transparent hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark text-text dark:text-text-dark',
                            )}
                        >
                            {t('cancel')}
                        </button>
                        <button
                            type="button"
                            data-testid="temporary-account-sign-out-confirm"
                            disabled={isPending}
                            aria-busy={isPending}
                            onClick={() =>
                                startTransition(async () => {
                                    await logout();
                                })
                            }
                            className={cn(
                                BUTTON_BASE,
                                'border border-border dark:border-border-dark bg-transparent hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark text-danger',
                            )}
                        >
                            {t('confirm')}
                        </button>
                        <button
                            type="button"
                            data-testid="temporary-account-sign-out-save"
                            disabled={isPending}
                            onClick={() => {
                                onOpenChange(false);
                                router.push(ROUTES.SAVE_ACCOUNT);
                            }}
                            className={cn(
                                BUTTON_BASE,
                                'bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-button-primary-foreground dark:text-button-primary-foreground-dark',
                            )}
                        >
                            {t('save')}
                        </button>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
