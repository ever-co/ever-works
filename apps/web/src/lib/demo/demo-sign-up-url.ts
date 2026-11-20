'use client';

import { createContext, useContext } from 'react';

/**
 * Platform demo mode — the instance's sign-up URL (`DEMO_SIGN_UP_URL`, read from the web's demo
 * config) for the demo error messages a demo account's pages show in the browser (the chat panel,
 * the demo toasts). The dashboard layout provides it with the demo strip; null everywhere else,
 * where the messages fall back to the default sign-up host.
 */
export const DemoSignUpUrlContext = createContext<string | null>(null);

export function useDemoSignUpUrl(): string | null {
    return useContext(DemoSignUpUrlContext);
}
