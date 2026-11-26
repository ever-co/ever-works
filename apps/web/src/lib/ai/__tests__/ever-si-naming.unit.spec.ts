import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Shared Ever shell, A7 — the assistant is called **Ever SI** in every
 * product and every language, never "Assistant", "AI assistant" or "Chat".
 *
 * Every locale bundle the app ships is read, and the strings that NAME the
 * assistant (its panel title, the participant row, the sidebar entry, the
 * command palette's open/close commands, the knowledge-base pane) must say
 * "Ever SI". The disclosure line must be present everywhere too; next-intl
 * would otherwise fall back to English silently.
 */

const MESSAGES_DIR = join(__dirname, '..', '..', '..', '..', 'messages');

const NAMING_KEYS = [
    'dashboard.aiChat.title',
    'dashboard.aiChat.panelTitle',
    'dashboard.aiChat.welcomeTitle',
    'dashboard.aiChat.panel.assistant',
    'dashboard.sidebar.aiChat',
    'dashboard.workDetail.kb.panes.ai.title',
] as const;

const MENTIONING_KEYS = [
    'dashboard.aiChat.openPanel',
    'dashboard.aiChat.closeChat',
    'dashboard.aiChat.panel.close',
    'dashboard.aiChat.inputPlaceholder',
    'dashboard.commandPalette.commands.openChat',
    'dashboard.commandPalette.commands.closeChat',
    'dashboard.commandPalette.noResults.askChat',
] as const;

function read(bundle: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((node, key) => {
        if (node === null || typeof node !== 'object') return undefined;
        return (node as Record<string, unknown>)[key];
    }, bundle);
}

const bundles = readdirSync(MESSAGES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({
        locale: file.replace(/\.json$/, ''),
        messages: JSON.parse(readFileSync(join(MESSAGES_DIR, file), 'utf8')) as Record<
            string,
            unknown
        >,
    }));

describe('Ever SI naming (A7)', () => {
    it('reads all 21 bundles', () => {
        expect(bundles).toHaveLength(21);
    });

    it.each(bundles.map((bundle) => [bundle.locale, bundle.messages] as const))(
        '%s names the assistant "Ever SI"',
        (_locale, messages) => {
            for (const key of NAMING_KEYS) expect(read(messages, key), key).toBe('Ever SI');
            for (const key of MENTIONING_KEYS)
                expect(read(messages, key), key).toContain('Ever SI');
            const disclosure = read(messages, 'dashboard.aiChat.disclosure');
            expect(typeof disclosure, 'disclosure').toBe('string');
            expect(disclosure as string).toContain('SI');
        },
    );

    it('says what is true about keeping the conversation (no 30-day claim: Ever Works keeps it until deleted)', () => {
        const en = bundles.find((bundle) => bundle.locale === 'en')?.messages ?? {};
        expect(read(en, 'dashboard.aiChat.disclosure')).toBe(
            "You're chatting with Ever's SI assistant. It can make mistakes. We keep this conversation until you delete it.",
        );
    });
});
