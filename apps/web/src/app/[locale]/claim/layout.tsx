import { SaveAccountStripSlot } from '@/components/anonymous/SaveAccountStripSlot';

/**
 * EW-617 — a signed-in temporary (anonymous) account sees the "save your account" strip here
 * too: accepting an invitation on a temporary account attaches it to an account that is
 * deleted after a few days. Renders nothing for everyone else.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
    return (
        <>
            <SaveAccountStripSlot />
            {children}
        </>
    );
}
