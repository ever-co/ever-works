import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

const nav = vi.hoisted(() => ({ pathname: '/' }));

vi.mock('@/i18n/navigation', () => ({
    usePathname: () => nav.pathname,
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

import { SaveAccountStrip } from './SaveAccountStrip';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-21T22:00:00.000Z');

function renderStrip(expiresAt: string | null) {
    const errors: unknown[] = [];
    const utils = render(
        <NextIntlClientProvider
            locale="en"
            messages={messages}
            timeZone="UTC"
            onError={(e) => errors.push(e)}
        >
            <SaveAccountStrip expiresAt={expiresAt} />
        </NextIntlClientProvider>,
    );
    return { ...utils, errors };
}

describe('SaveAccountStrip', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        nav.pathname = '/';
    });
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('says the account is temporary and links to the save page', () => {
        const { errors } = renderStrip(new Date(NOW + 50 * HOUR).toISOString());

        const strip = screen.getByRole('status');
        expect(strip).toHaveTextContent(
            "You're using a temporary account. Sign up to keep your Works.",
        );
        expect(screen.getByRole('link', { name: 'Save my account' })).toHaveAttribute(
            'href',
            '/save-account',
        );
        expect(errors).toEqual([]);
    });

    it('prints the real time left: days and hours', () => {
        renderStrip(new Date(NOW + (2 * 24 + 23.5) * HOUR).toISOString());

        expect(screen.getByTestId('save-account-strip-time')).toHaveTextContent(
            'Deleted in 2 days 23 h',
        );
    });

    it('prints hours under a day, and "less than an hour" at the end', () => {
        const { unmount } = renderStrip(new Date(NOW + 5.2 * HOUR).toISOString());
        expect(screen.getByTestId('save-account-strip-time')).toHaveTextContent('Deleted in 5 h');
        unmount();

        renderStrip(new Date(NOW - HOUR).toISOString());
        expect(screen.getByTestId('save-account-strip-time')).toHaveTextContent(
            'Deleted in less than an hour',
        );
    });

    it('prints no countdown when the expiry is unknown, and stays', () => {
        renderStrip(null);

        expect(screen.getByRole('status')).toBeInTheDocument();
        expect(screen.queryByTestId('save-account-strip-time')).toBeNull();
    });

    it('has no close button: it goes away only once the account is saved', () => {
        renderStrip(new Date(NOW + 50 * HOUR).toISOString());

        expect(screen.queryByRole('button')).toBeNull();
    });

    it('drops its own action on the save page, where the form is the action', () => {
        nav.pathname = '/save-account';
        renderStrip(new Date(NOW + 50 * HOUR).toISOString());

        expect(screen.getByRole('status')).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Save my account' })).toBeNull();
    });
});
