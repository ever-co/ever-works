'use client';

export interface OnboardingTransitionProps {
    readonly title: string;
    readonly description: string;
}

/**
 * Full-page loading state shown while the app routes away from /onboarding.
 *
 * The next page (the new Work, or the dashboard) is server-rendered behind
 * the whole dashboard layout and has no `loading.tsx`, so the first load can
 * take several seconds. The wizard used to unmount first, which left an empty
 * page for that whole time.
 */
export function OnboardingTransition({ title, description }: OnboardingTransitionProps) {
    return (
        <div
            className="min-h-screen grid place-items-center bg-surface dark:bg-surface-dark px-6"
            data-testid="onboarding-transition"
        >
            <div
                className="flex max-w-sm flex-col items-center gap-4 text-center"
                role="status"
                aria-live="polite"
            >
                <div
                    aria-hidden
                    className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-text dark:border-border-dark dark:border-t-white"
                />
                <p className="text-base font-medium text-text dark:text-text-dark">{title}</p>
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{description}</p>
            </div>
        </div>
    );
}
