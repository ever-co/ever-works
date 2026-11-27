'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import {
    THEME_PREFERENCES,
    setThemePreference,
    useThemePreference,
    type ThemePreference,
} from '@/lib/hooks/use-theme';
import { useMounted } from '@/lib/hooks/use-mounted';
import { cn } from '@/lib/utils/cn';

const LABEL_KEYS = {
    light: 'themeLight',
    dark: 'themeDark',
    system: 'themeSystem',
} as const;

/** Fixed palettes: a theme tile shows that theme whatever the page uses now. */
const PALETTES = {
    light: { page: '#fafafa', panel: '#ffffff', line: '#e4e4e7', ink: '#18181b' },
    dark: { page: '#09090b', panel: '#18181b', line: '#27272a', ink: '#fafafa' },
} as const;

/** Either palette: `as const` makes each a different literal type, so name the union, not `light`. */
type Palette = (typeof PALETTES)[keyof typeof PALETTES];

function WindowSketch({ palette, x }: { palette: Palette; x: number }) {
    return (
        <g transform={`translate(${x} 0)`}>
            <rect width={120} height={72} fill={palette.page} />
            <rect
                x={6}
                y={8}
                width={26}
                height={58}
                rx={3}
                fill={palette.panel}
                stroke={palette.line}
            />
            <rect
                x={36}
                y={8}
                width={78}
                height={58}
                rx={3}
                fill={palette.panel}
                stroke={palette.line}
            />
            {[16, 24, 32].map((y) => (
                <rect
                    key={y}
                    x={10}
                    y={y}
                    width={16}
                    height={3}
                    rx={1.5}
                    fill={palette.ink}
                    opacity={0.25}
                />
            ))}
            <rect x={42} y={16} width={40} height={4} rx={2} fill={palette.ink} opacity={0.35} />
            {[28, 38, 48].map((y) => (
                <rect
                    key={y}
                    x={42}
                    y={y}
                    width={66}
                    height={6}
                    rx={2}
                    fill={palette.ink}
                    opacity={0.1}
                />
            ))}
        </g>
    );
}

/** A small sketch of the app in each theme; System is split, light over dark. */
export function ThemePreview({
    preference,
    className,
}: {
    preference: ThemePreference;
    className?: string;
}) {
    const clipId = `theme-split-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
    return (
        <svg
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 120 72"
            className={className}
            data-testid={`theme-preview-${preference}`}
        >
            {preference === 'system' ? (
                <>
                    <defs>
                        <clipPath id={clipId}>
                            <polygon points="0,0 120,0 0,72" />
                        </clipPath>
                    </defs>
                    <WindowSketch palette={PALETTES.dark} x={0} />
                    <g clipPath={`url(#${clipId})`}>
                        <WindowSketch palette={PALETTES.light} x={0} />
                    </g>
                </>
            ) : (
                <WindowSketch palette={PALETTES[preference]} x={0} />
            )}
        </svg>
    );
}

/**
 * Theme (shared Ever shell, A4): the full choice as three tiles — Light, Dark,
 * System — next to the one-icon switch in the top bar, which keeps working and
 * picks Light or Dark.
 */
export function ThemePreferenceTiles() {
    const t = useTranslations('dashboard.settings.preferences');
    const name = useId();
    const mounted = useMounted();
    const preference = useThemePreference();

    return (
        <fieldset className="grid grid-cols-3 gap-3" data-testid="theme-preference">
            <legend className="sr-only">{t('themeTitle')}</legend>
            {THEME_PREFERENCES.map((choice) => {
                const isPicked = mounted && preference === choice;
                return (
                    <label key={choice} className="flex min-w-0 cursor-pointer flex-col gap-2">
                        <input
                            type="radio"
                            name={name}
                            value={choice}
                            checked={isPicked}
                            onChange={() => setThemePreference(choice)}
                            className="peer sr-only"
                            data-testid={`theme-preference-${choice}`}
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
                            <ThemePreview preference={choice} className="block h-auto w-full" />
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
    );
}
