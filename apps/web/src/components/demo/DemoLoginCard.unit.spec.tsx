import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    startDemo: vi.fn(),
    push: vi.fn(),
    getToken: vi.fn(),
}));

vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { useTranslations: enUseTranslations };
});
vi.mock('@/app/actions/demo/start-demo', () => ({ startDemo: mocks.startDemo }));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: mocks.push, refresh: vi.fn() }),
    Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('@/components/onboarding/use-turnstile', () => ({
    useTurnstile: () => ({ getToken: mocks.getToken, ready: true }),
}));

import { DemoLoginCard } from './DemoLoginCard';

describe('DemoLoginCard', () => {
    beforeEach(() => {
        mocks.startDemo.mockReset();
        mocks.push.mockReset();
        mocks.getToken.mockReset();
        mocks.getToken.mockResolvedValue('');
    });
    afterEach(() => cleanup());

    it('renders the title, button, TTL note and the sample link', () => {
        render(<DemoLoginCard ttlHours={24} expired={false} />);
        expect(screen.getByText('Try Ever Works — no sign-up needed')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Start the demo' })).toBeInTheDocument();
        expect(
            screen.getByText(
                'Your private demo workspace is deleted after 24 hours. AI runs on free models and may be slower.',
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByRole('link', { name: /See a site Ever Works generated/ }),
        ).toHaveAttribute('href', 'https://dir.ever.works');
        expect(screen.queryByText(/expired/)).not.toBeInTheDocument();
    });

    it('shows the expired notice for the expired variant', () => {
        render(<DemoLoginCard ttlHours={24} expired />);
        expect(
            screen.getByText('Your demo workspace expired — start a new one'),
        ).toBeInTheDocument();
    });

    it('two quick clicks start exactly one sandbox, and the button is disabled while pending', async () => {
        let resolve!: (v: { success: true; href: string }) => void;
        mocks.startDemo.mockReturnValue(new Promise((r) => (resolve = r)));
        render(<DemoLoginCard ttlHours={24} expired={false} />);
        const button = screen.getByRole('button', { name: 'Start the demo' });

        fireEvent.click(button);
        fireEvent.click(button);
        fireEvent.click(button);

        await waitFor(() => expect(mocks.startDemo).toHaveBeenCalledTimes(1));
        expect(button).toBeDisabled();

        await act(async () => resolve({ success: true, href: '/' }));
        await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/'));
        expect(mocks.startDemo).toHaveBeenCalledTimes(1);
    });

    it("lands in the sandbox's Organization, where its seeded Goals and Missions live", async () => {
        mocks.startDemo.mockResolvedValue({
            success: true,
            href: '/org/acme-labs-demo-0a1b2c3d/dashboard',
        });
        render(<DemoLoginCard ttlHours={24} expired={false} />);
        fireEvent.click(screen.getByRole('button', { name: 'Start the demo' }));
        await waitFor(() =>
            expect(mocks.push).toHaveBeenCalledWith('/org/acme-labs-demo-0a1b2c3d/dashboard'),
        );
    });

    it('passes the turnstile token, and none when there is none', async () => {
        mocks.getToken.mockResolvedValue('tok');
        mocks.startDemo.mockResolvedValue({ success: true, href: '/dashboard' });
        render(<DemoLoginCard ttlHours={24} expired={false} />);
        fireEvent.click(screen.getByRole('button', { name: 'Start the demo' }));
        await waitFor(() => expect(mocks.startDemo).toHaveBeenCalledWith({ captchaToken: 'tok' }));
        await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/dashboard'));
    });

    it('sends no token when Turnstile yields an empty one', async () => {
        mocks.startDemo.mockResolvedValue({ success: true, href: '/dashboard' });
        render(<DemoLoginCard ttlHours={24} expired={false} />);
        fireEvent.click(screen.getByRole('button', { name: 'Start the demo' }));
        await waitFor(() =>
            expect(mocks.startDemo).toHaveBeenCalledWith({ captchaToken: undefined }),
        );
        await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/dashboard'));
    });

    it('shows the full message and re-enables the button on a full result', async () => {
        mocks.startDemo.mockResolvedValue({ success: false, reason: 'full', error: 'x' });
        render(<DemoLoginCard ttlHours={24} expired={false} />);
        fireEvent.click(screen.getByRole('button', { name: 'Start the demo' }));
        expect(
            await screen.findByText(
                'The demo is full right now — please try again in a few minutes.',
            ),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Start the demo' })).not.toBeDisabled();
        expect(mocks.push).not.toHaveBeenCalled();
    });

    it('allows a retry after a failure (the guard is released)', async () => {
        mocks.startDemo.mockResolvedValue({ success: false, reason: 'error', error: 'x' });
        render(<DemoLoginCard ttlHours={24} expired={false} />);
        fireEvent.click(screen.getByRole('button', { name: 'Start the demo' }));
        await screen.findByRole('alert');
        fireEvent.click(screen.getByRole('button', { name: 'Start the demo' }));
        await waitFor(() => expect(mocks.startDemo).toHaveBeenCalledTimes(2));
    });
});
