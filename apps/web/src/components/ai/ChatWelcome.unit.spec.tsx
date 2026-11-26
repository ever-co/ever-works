import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Shared Ever shell, A7: the assistant's first screen names it "Ever SI" and
 * carries the disclosure line.
 */

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

import { ChatWelcome } from './ChatWelcome';

describe('ChatWelcome', () => {
    it('titles the panel and shows the disclosure line', () => {
        render(<ChatWelcome onSuggestion={vi.fn()} />);
        expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
            'dashboard.aiChat.welcomeTitle',
        );
        expect(screen.getByTestId('ever-si-disclosure')).toHaveTextContent(
            'dashboard.aiChat.disclosure',
        );
    });
});
