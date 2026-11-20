import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { useTranslations: enUseTranslations };
});
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

import { DemoStrip } from './DemoStrip';

const SIGN_UP = 'https://app.ever.works/register';
const HOUR = 3_600_000;

function renderStrip(overrides: Partial<React.ComponentProps<typeof DemoStrip>> = {}) {
    return render(
        <DemoStrip
            signUpUrl={SIGN_UP}
            expiresAt={new Date(Date.now() + 23.5 * HOUR).toISOString()}
            aiQuotaExhausted={false}
            recordedGoalHref="/goals/g-1"
            {...overrides}
        />,
    );
}

describe('DemoStrip', () => {
    afterEach(() => cleanup());

    it('prints the verbatim copy with "Click here to Sign Up" as the link', () => {
        renderStrip();

        const strip = screen.getByRole('status');
        expect(strip.textContent).toContain(
            'You are using a demo account. Finding our software useful? Click here to Sign Up and start using for free!',
        );
        const link = screen.getByRole('link', { name: 'Click here to Sign Up' });
        expect(link).toHaveAttribute('href', SIGN_UP);
        expect(link).toHaveAttribute('target', '_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('shows the hours left, rounded down (+23.5 h is 23 h)', () => {
        renderStrip();

        expect(screen.getByText('Demo workspace expires in 23 h')).toBeInTheDocument();
    });

    it.each([[0.5 * HOUR], [-HOUR]])(
        'shows "less than 1 h" for %i ms left, never 0 or negative',
        (offset) => {
            renderStrip({ expiresAt: new Date(Date.now() + offset).toISOString() });

            expect(screen.getByText('Demo workspace expires in less than 1 h')).toBeInTheDocument();
        },
    );

    it('shows the quota line, linked to the recorded Goal, only when live AI is used up', () => {
        const { rerender } = renderStrip();
        expect(screen.queryByText(/Live AI is used up/)).not.toBeInTheDocument();

        rerender(
            <DemoStrip
                signUpUrl={SIGN_UP}
                expiresAt={new Date(Date.now() + 5 * HOUR).toISOString()}
                aiQuotaExhausted
                recordedGoalHref="/goals/g-1"
            />,
        );

        const quota = screen.getByRole('link', {
            name: 'Live AI is used up for today — explore the recorded examples',
        });
        expect(quota).toHaveAttribute('href', '/goals/g-1');
    });

    it('renders the quota line as plain text when the recorded Goal is gone', () => {
        renderStrip({ aiQuotaExhausted: true, recordedGoalHref: null });

        expect(
            screen.getByText('Live AI is used up for today — explore the recorded examples'),
        ).toBeInTheDocument();
        expect(screen.getAllByRole('link')).toHaveLength(1);
    });

    it('cannot be dismissed', () => {
        renderStrip();

        expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
});
