'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { toast } from 'sonner';
import {
    APP_LAUNCHER_PLACEMENTS,
    useAppLauncherPlacement,
    writeAppLauncherPlacement,
    type AppLauncherPlacement,
} from '@/lib/app-launcher/placement';
import { useMounted } from '@/lib/hooks/use-mounted';
import { cn } from '@/lib/utils/cn';
import { AppLauncherPlacementPreview } from './AppLauncherPlacementPreview';

const LABEL_KEYS = {
    sidebar: 'placementSidebar',
    header: 'placementHeader',
    rail: 'placementRail',
} as const;

/**
 * Where the App Launcher's shortcut sits (shared Ever shell, A3): three picture
 * tiles, **Sidebar**, **Top bar** and **Left rail**, saved as you pick, in this
 * browser only (the same key Ever Teams uses). Radio semantics: one fieldset,
 * one name, arrow keys move between the tiles.
 */
export function AppLauncherPlacementTiles({ className }: { className?: string }) {
    const t = useTranslations('dashboard.settings.appLauncher');
    const name = useId();
    // The server render cannot know the stored choice: no tile is marked until
    // the client has read it, so the first paint never shows a wrong one.
    const mounted = useMounted();
    const placement = useAppLauncherPlacement();

    const pick = (choice: AppLauncherPlacement) => {
        try {
            writeAppLauncherPlacement(choice);
        } catch {
            toast.error(t('placementSaveFailed'));
        }
    };

    return (
        <section
            aria-labelledby={`${name}-title`}
            className={cn('space-y-3', className)}
            data-testid="app-launcher-placement"
        >
            <div className="space-y-1">
                <h2
                    id={`${name}-title`}
                    className="text-sm font-medium text-text dark:text-text-dark"
                >
                    {t('placementTitle')}
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    {t('placementDescription')}
                </p>
            </div>
            <fieldset className="grid grid-cols-3 gap-3">
                <legend className="sr-only">{t('placementTitle')}</legend>
                {APP_LAUNCHER_PLACEMENTS.map((choice) => {
                    const isPicked = mounted && placement === choice;
                    return (
                        <label key={choice} className="flex min-w-0 cursor-pointer flex-col gap-2">
                            <input
                                type="radio"
                                name={name}
                                value={choice}
                                checked={isPicked}
                                onChange={() => pick(choice)}
                                className="peer sr-only"
                                data-testid={`app-launcher-placement-${choice}`}
                            />
                            <span
                                className={cn(
                                    'relative block overflow-hidden rounded-lg transition-shadow',
                                    'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary',
                                    isPicked
                                        ? 'ring-2 ring-primary'
                                        : 'ring-1 ring-border dark:ring-border-dark',
                                )}
                            >
                                <AppLauncherPlacementPreview
                                    placement={choice}
                                    className="block h-auto w-full"
                                />
                                {isPicked && (
                                    <span
                                        aria-hidden="true"
                                        className="absolute bottom-1.5 left-1.5 inline-flex size-4 items-center justify-center rounded-full bg-primary text-white"
                                    >
                                        <Check className="size-3" strokeWidth={2.5} />
                                    </span>
                                )}
                            </span>
                            <span className="truncate text-sm font-medium text-text dark:text-text-dark">
                                {t(LABEL_KEYS[choice])}
                            </span>
                        </label>
                    );
                })}
            </fieldset>
        </section>
    );
}
