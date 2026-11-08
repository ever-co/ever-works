/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://app.ever.works/en" }
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { JobRuntimeDegradedBanner } from './JobRuntimeDegradedBanner';

/**
 * Ever's own hosted app keeps the banner's link to the product documentation;
 * a self-hosted install does not (JobRuntimeDegradedBanner.unit.spec.tsx).
 */
describe("JobRuntimeDegradedBanner on Ever's hosted app", () => {
    it('links to docs.ever.works', async () => {
        expect(window.location.hostname).toBe('app.ever.works');
        render(<JobRuntimeDegradedBanner configured={false} />);
        const link = await screen.findByTestId('job-runtime-banner-docs-link');
        expect(link).toHaveAttribute('href', 'https://docs.ever.works/');
        expect(link).toHaveAttribute('target', '_blank');
        expect(link).toHaveTextContent('docsLink');
    });
});
