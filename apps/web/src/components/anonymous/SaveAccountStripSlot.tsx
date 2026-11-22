import { getSaveAccountStripForRequest } from '@/lib/anonymous/save-account-strip';
import { SaveAccountStrip } from './SaveAccountStrip';

/**
 * EW-617 — the temporary-account strip for pages OUTSIDE the dashboard shell (the dashboard
 * renders it above its own header). A server component: it reads this request's session and
 * renders nothing for a signed-out visitor, a registered account or a demo, so a layout can
 * place it unconditionally above its pages.
 */
export async function SaveAccountStripSlot() {
    const strip = await getSaveAccountStripForRequest();
    return strip ? <SaveAccountStrip {...strip} /> : null;
}
