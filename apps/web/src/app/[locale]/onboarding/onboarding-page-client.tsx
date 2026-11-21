'use client';

import { useCallback, useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { EverWorksOnboardingWizard } from '@/components/onboarding/EverWorksOnboardingWizard';
import { OnboardingTransition } from '@/components/onboarding/OnboardingTransition';
import type { StartedWork } from '@/components/onboarding/generation-console';
import type { OnboardingCatalogResponse, OnboardingStateResponse } from '@ever-works/contracts/api';
import type { UserPlugin } from '@/lib/api/plugins';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import type { GitProviderConnectionInfo } from '@/lib/api/plugins-capabilities/git-providers';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';

interface Props {
    initialState: OnboardingStateResponse;
    catalog: OnboardingCatalogResponse;
    plugins: ReadonlyArray<UserPlugin>;
    initialConnections: Record<string, OAuthConnectionInfo | GitProviderConnectionInfo | null>;
    initialDeviceAuthStatuses: Record<string, PluginDeviceAuthStatus | null>;
}

type Leaving = { readonly to: 'dashboard' } | { readonly to: 'work'; readonly name: string };

export function OnboardingPageClient(props: Props) {
    const router = useRouter();
    // The wizard is forced open regardless of works count / prior dismissal.
    // This standalone page is an explicit "start onboarding" surface — that is
    // the fix for the logged-in-WITH-works case (the owner's 404), with NO edit
    // to the dashboard auto-open logic. It closes only to leave the page, and
    // then this says where to while the next page loads.
    const [leaving, setLeaving] = useState<Leaving | null>(null);

    const handleClose = useCallback(() => {
        setLeaving({ to: 'dashboard' });
        // Anonymous users hold a valid session, so the dashboard renders for them too.
        router.push(ROUTES.DASHBOARD);
    }, [router]);

    const handleOpenWork = useCallback(
        (work: StartedWork, href: string) => {
            setLeaving({ to: 'work', name: work.name });
            router.push(href);
        },
        [router],
    );

    if (leaving) {
        return (
            <main className="min-h-screen bg-surface dark:bg-surface-dark">
                {leaving.to === 'work' ? (
                    <OnboardingTransition
                        title={`Opening ${leaving.name}…`}
                        description="Your Work is being generated — its progress and log continue on the Work page. The first load can take a few seconds."
                    />
                ) : (
                    <OnboardingTransition
                        title="Opening your dashboard…"
                        description="Loading your account. The first load can take a few seconds."
                    />
                )}
            </main>
        );
    }

    // The wizard reads #prompt/#corrId/#type from window.location.hash on
    // mount, opens the prompt-first quick start, then strips the hash — no
    // extra wiring needed here.
    return (
        <main className="min-h-screen bg-surface dark:bg-surface-dark">
            <EverWorksOnboardingWizard
                open
                initialState={props.initialState}
                catalog={props.catalog}
                plugins={props.plugins}
                initialConnections={props.initialConnections}
                initialDeviceAuthStatuses={props.initialDeviceAuthStatuses}
                onClose={handleClose}
                onOpenWork={handleOpenWork}
            />
        </main>
    );
}
