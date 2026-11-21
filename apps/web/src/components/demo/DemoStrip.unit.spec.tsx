import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
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

    /**
     * The hours left are read from the clock while rendering, so the server's HTML and the
     * client's first render can disagree when an hour boundary passes between them (here
     * "3 h" on the server, "2 h" at hydration). That must not be a hydration error.
     */
    describe('hydration across an hour boundary', () => {
        const EXPIRES_AT = '2026-11-21T12:00:00.000Z';

        afterEach(() => {
            vi.useRealTimers();
            document.body.innerHTML = '';
        });

        it('hydrates the server HTML without a mismatch', async () => {
            const strip = (
                <DemoStrip
                    signUpUrl={SIGN_UP}
                    expiresAt={EXPIRES_AT}
                    aiQuotaExhausted={false}
                    recordedGoalHref={null}
                />
            );
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(new Date('2026-11-21T08:59:59.900Z'));
            const html = renderToString(strip);
            expect(html).toContain('Demo workspace expires in 3 h');

            const container = document.createElement('div');
            container.innerHTML = html;
            document.body.appendChild(container);
            vi.setSystemTime(new Date('2026-11-21T09:00:00.100Z'));
            const onRecoverableError = vi.fn();
            const consoleErrors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            let root: ReturnType<typeof hydrateRoot> | undefined;
            await act(async () => {
                root = hydrateRoot(container, strip, { onRecoverableError });
            });

            expect(onRecoverableError).not.toHaveBeenCalled();
            expect(consoleErrors).not.toHaveBeenCalled();
            consoleErrors.mockRestore();
            act(() => root?.unmount());
        });
    });
});
