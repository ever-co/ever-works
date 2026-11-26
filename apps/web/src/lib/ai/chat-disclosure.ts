'use client';

import { createContext, useContext } from 'react';

/**
 * How long Ever SI's conversations are kept for the person signed in, so the
 * disclosure line (shared Ever shell, A7) says what is true:
 *
 * - `kept`: a regular account keeps a conversation until the person deletes it.
 * - `temporary`: a temporary (anonymous) account or a demo workspace is deleted
 *   after its time limit, and its conversations with it.
 *
 * Set by the dashboard shell, which knows which strip it shows.
 */
export type ChatRetention = 'kept' | 'temporary';

export const ChatRetentionContext = createContext<ChatRetention>('kept');

export function useChatRetention(): ChatRetention {
    return useContext(ChatRetentionContext);
}
