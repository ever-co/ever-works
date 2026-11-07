import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import messages from '../../../messages/en.json';
import { buildGitHubLinks, buildLearnMoreLinks, isEverOwnedUrl } from '@/lib/about-info';
import { AboutView, type AboutViewProps } from './AboutView';

vi.mock('@/components/logos', () => ({
    LogoEverWorkImage: () => <span data-testid="logo" />,
}));

const WEB = {
    version: '0.1.0',
    shortSha: '7e26619',
    gitRef: 'develop',
    buildTime: '2026-11-07T10:00:00Z',
    commitUrl:
        'https://github.com/ever-co/ever-works/commit/7e26619aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

function props(overrides: Partial<AboutViewProps> = {}): AboutViewProps {
    return {
        web: WEB,
        api: { ...WEB },
        sync: 'in-sync',
        buildMode: 'production',
        environment: 'dev',
        apiAddress: 'https://api-dev.ever.works/api',
        github: buildGitHubLinks(undefined),
        learnMore: buildLearnMoreLinks({ webUrl: 'https://app-dev.ever.works' }),
        ...overrides,
    };
}

function renderView(overrides: Partial<AboutViewProps> = {}) {
    const errors: unknown[] = [];
    const utils = render(
        <NextIntlClientProvider
            locale="en"
            messages={messages}
            timeZone="UTC"
            onError={(e) => errors.push(e)}
        >
            <AboutView {...props(overrides)} />
        </NextIntlClientProvider>,
    );
    return { ...utils, errors };
}

describe('AboutView', () => {
    it('renders the product card with the licence link, and no missing translations', () => {
        const { errors } = renderView();

        expect(screen.getByRole('heading', { level: 1, name: 'About' })).toBeInTheDocument();
        const product = screen.getByTestId('about-product');
        expect(within(product).getByText(/The Workshop for AI/)).toBeInTheDocument();
        const license = screen.getByTestId('about-link-license');
        expect(license).toHaveTextContent('AGPL-3.0');
        expect(license).toHaveAttribute(
            'href',
            'https://github.com/ever-co/ever-works/blob/develop/LICENSE',
        );
        expect(license).toHaveAttribute('target', '_blank');
        expect(license).toHaveAttribute('rel', 'noopener noreferrer');
        expect(errors).toEqual([]);
    });

    it('shows both builds with a commit link and the In sync indicator', () => {
        renderView();

        const web = screen.getByTestId('about-build-web');
        expect(within(web).getByText('Web app')).toBeInTheDocument();
        expect(within(web).getByText('7e26619')).toBeInTheDocument();
        expect(within(web).getByText('v0.1.0')).toBeInTheDocument();
        expect(within(web).getByText('From develop')).toBeInTheDocument();
        expect(
            within(web).getByRole('link', { name: 'View commit 7e26619 on GitHub' }),
        ).toHaveAttribute('href', WEB.commitUrl);
        expect(within(screen.getByTestId('about-build-api')).getByText('API')).toBeInTheDocument();

        const sync = screen.getByTestId('about-sync');
        expect(sync).toHaveTextContent('In sync');
        expect(sync).toHaveAttribute('data-state', 'in-sync');
    });

    it('says when the builds differ, and hides the indicator when it cannot tell', () => {
        const { unmount } = renderView({ sync: 'different' });
        expect(screen.getByTestId('about-sync')).toHaveTextContent('Different builds');
        unmount();

        renderView({ sync: 'unknown', api: null });
        expect(screen.queryByTestId('about-sync')).not.toBeInTheDocument();
        expect(
            within(screen.getByTestId('about-build-api')).getByText(
                'The API did not report its version.',
            ),
        ).toBeInTheDocument();
    });

    it('lists the environment: build mode, environment name and API address', () => {
        renderView();

        const env = screen.getByTestId('about-environment');
        expect(within(env).getByText('Production')).toBeInTheDocument();
        expect(within(env).getByText('Development (dev)')).toBeInTheDocument();
        expect(screen.getByTestId('about-api-address')).toHaveTextContent(
            'https://api-dev.ever.works/api',
        );
    });

    it('says Not available when the environment or API address is unknown', () => {
        renderView({ environment: null, apiAddress: null, buildMode: 'development' });

        const env = screen.getByTestId('about-environment');
        expect(within(env).getAllByText('Not available')).toHaveLength(2);
        expect(within(env).getByText('Development')).toBeInTheDocument();
        expect(screen.queryByTestId('about-copy-api-address')).not.toBeInTheDocument();
    });

    it('copies the API address and confirms it', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        renderView();

        const button = screen.getByTestId('about-copy-api-address');
        expect(button).toHaveAccessibleName('Copy API address');
        await act(async () => {
            fireEvent.click(button);
        });
        expect(writeText).toHaveBeenCalledWith('https://api-dev.ever.works/api');
        expect(button).toHaveAccessibleName('Copied');
    });

    it('links to the website, docs, company and every GitHub page in a new tab', () => {
        renderView();

        const expected: Array<[string, string]> = [
            ['about-link-website', 'https://ever.works'],
            ['about-link-docs', 'https://docs.ever.works'],
            ['about-link-company', 'https://ever.co'],
            ['about-link-repository', 'https://github.com/ever-co/ever-works'],
            ['about-link-releases', 'https://github.com/ever-co/ever-works/releases'],
            ['about-link-issues', 'https://github.com/ever-co/ever-works/issues'],
            ['about-link-pull-requests', 'https://github.com/ever-co/ever-works/pulls'],
            [
                'about-link-contributors',
                'https://github.com/ever-co/ever-works/graphs/contributors',
            ],
            [
                'about-link-contributing',
                'https://github.com/ever-co/ever-works/blob/develop/.github/CONTRIBUTING.MD',
            ],
        ];
        for (const [testId, href] of expected) {
            const link = screen.getByTestId(testId);
            expect(link).toHaveAttribute('href', href);
            expect(link).toHaveAttribute('target', '_blank');
            expect(link.getAttribute('aria-label')).toMatch(/\(opens in a new tab\)$/);
        }
    });

    it('renders no link to an Ever host on a self-hosted install (egress audit rule)', () => {
        const { container } = renderView({
            // The egress audit runs the self-hosting compose file at this address.
            learnMore: buildLearnMoreLinks({
                webUrl: 'http://ever-works-web:3000',
                companyOwnerWebsite: 'https://ever.works',
            }),
            apiAddress: null,
            environment: null,
        });

        expect(screen.queryByTestId('about-learn-more')).not.toBeInTheDocument();
        const everHrefs = [...container.querySelectorAll('[href]')]
            .map((element) => element.getAttribute('href'))
            .filter((href) => isEverOwnedUrl(href));
        expect(everHrefs).toEqual([]);
        // Control: the hosted render does link to Ever hosts, so the filter above can see them.
        const hosted = renderView();
        const hostedEverHrefs = [...hosted.container.querySelectorAll('[href]')].filter((element) =>
            isEverOwnedUrl(element.getAttribute('href')),
        );
        expect(hostedEverHrefs).toHaveLength(3);
    });

    it("shows a self-hosted operator's own site under its own name", () => {
        renderView({
            learnMore: buildLearnMoreLinks({
                webUrl: 'https://works.acme.test',
                companyOwnerWebsite: 'https://acme.test',
                companyOwnerName: 'Acme Inc.',
            }),
        });

        const link = screen.getByTestId('about-link-company');
        expect(link).toHaveAttribute('href', 'https://acme.test');
        expect(link).toHaveTextContent('Acme Inc.');
        expect(screen.queryByTestId('about-link-website')).not.toBeInTheDocument();
        expect(screen.queryByTestId('about-link-docs')).not.toBeInTheDocument();
    });
});
