import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { JobRuntimeDegradedBanner } from './JobRuntimeDegradedBanner';

describe('JobRuntimeDegradedBanner', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it('renders when the job runtime is KNOWN to be unconfigured', async () => {
        render(<JobRuntimeDegradedBanner configured={false} />);
        await waitFor(() =>
            expect(screen.getByTestId('job-runtime-degraded-banner')).toBeInTheDocument(),
        );
        expect(screen.getByText('title')).toBeInTheDocument();
    });

    it('renders no link to an Ever host on a self-hosted install', async () => {
        // jsdom serves this suite from a non-Ever origin, like a self-hosted
        // install. The Ever-hosted case is JobRuntimeDegradedBanner.hosted.unit.spec.tsx.
        expect(window.location.hostname).not.toMatch(/(^|\.)ever\.works$/);
        const { container } = render(<JobRuntimeDegradedBanner configured={false} />);
        await waitFor(() =>
            expect(screen.getByTestId('job-runtime-degraded-banner')).toBeInTheDocument(),
        );
        expect(screen.queryByTestId('job-runtime-banner-docs-link')).toBeNull();
        const hrefs = Array.from(container.querySelectorAll('[href]')).map((el) =>
            el.getAttribute('href'),
        );
        expect(hrefs.filter((href) => href?.includes('ever.works'))).toEqual([]);
    });

    it('renders nothing when configured or unknown (never speculates)', () => {
        const { rerender } = render(<JobRuntimeDegradedBanner configured={true} />);
        expect(screen.queryByTestId('job-runtime-degraded-banner')).toBeNull();
        rerender(<JobRuntimeDegradedBanner configured={null} />);
        expect(screen.queryByTestId('job-runtime-degraded-banner')).toBeNull();
    });

    it('dismiss hides it and persists across mounts', async () => {
        const { unmount } = render(<JobRuntimeDegradedBanner configured={false} />);
        await waitFor(() =>
            expect(screen.getByTestId('job-runtime-degraded-banner')).toBeInTheDocument(),
        );
        fireEvent.click(screen.getByTestId('job-runtime-banner-dismiss'));
        expect(screen.queryByTestId('job-runtime-degraded-banner')).toBeNull();

        unmount();
        render(<JobRuntimeDegradedBanner configured={false} />);
        // Hydration effect reads localStorage — stays hidden, no flash.
        await waitFor(() => expect(screen.queryByTestId('job-runtime-degraded-banner')).toBeNull());
    });
});
