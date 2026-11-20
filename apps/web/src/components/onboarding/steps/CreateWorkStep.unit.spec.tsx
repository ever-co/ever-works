import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/i18n/navigation', () => ({
    Link: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    } & Record<string, unknown>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

import { CreateWorkStep } from './CreateWorkStep';

describe('CreateWorkStep — "Generate now" refused by the provider gate', () => {
    it('shows every missing provider the API named, one per line', async () => {
        // What `quickCreateWorkAction` returns for the quick-create provider gate, thrown by the
        // wizard's `onQuickCreate` as `new Error(result.error)`.
        const message = [
            'One or more selected providers are not available.',
            'AI provider: Provider "openrouter" is not configured. Visit Settings → Plugins to set it up.',
            'Search: Provider "tavily" is not configured. Visit Settings → Plugins to set it up.',
        ].join('\n');
        const onQuickCreate = vi.fn().mockRejectedValue(new Error(message));
        const onLeave = vi.fn();

        render(
            <CreateWorkStep
                onLeave={onLeave}
                prompt="A directory of AI coding agents"
                onQuickCreate={onQuickCreate}
            />,
        );
        await userEvent.click(screen.getByTestId('onboarding-generate-now'));

        const alert = await screen.findByTestId('onboarding-generate-error');
        expect(alert.textContent).toBe(message);
        // The lines stay lines on screen (the paragraph keeps the API's line breaks).
        expect(alert.className).toContain('whitespace-pre-line');
        expect(alert.textContent).toContain('Provider "openrouter" is not configured');
        expect(alert.textContent).toContain('Provider "tavily" is not configured');
        // A refusal keeps the visitor on the step, so they can set the provider up and retry.
        expect(onLeave).not.toHaveBeenCalled();
    });
});
