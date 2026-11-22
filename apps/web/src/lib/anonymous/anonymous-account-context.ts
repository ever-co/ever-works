'use client';

import { createContext, useContext } from 'react';
import type { SaveAccountStripProps } from './types';

/**
 * Whether the signed-in account is a temporary (anonymous) one that can still be saved, for
 * the dashboard's client components: the strip's own props, or null for everyone else (a
 * registered account, a demo sandbox, a demo instance). Provided once by the dashboard shell
 * from `buildSaveAccountStrip`, so every reminder follows the strip's rules.
 */
export const AnonymousAccountContext = createContext<SaveAccountStripProps | null>(null);

export function useAnonymousAccount(): SaveAccountStripProps | null {
    return useContext(AnonymousAccountContext);
}
