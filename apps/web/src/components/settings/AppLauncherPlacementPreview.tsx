import type { AppLauncherPlacement } from '@/lib/app-launcher/placement';
import { EverMark } from '@/components/app-launcher/EverMark';

/**
 * A wireframe of the dashboard with the App Launcher in one of its three
 * positions (shared Ever shell, A3), for the picture tiles in Settings. The
 * geometry is Ever Teams' (`core/components/common/app-switcher-preview.tsx`),
 * so the same choice looks the same in both products; the colours are this
 * app's tokens. It follows the active theme: it shows a position, not a palette.
 */

const VIEW_WIDTH = 290;
const VIEW_HEIGHT = 156;
const PANEL_TOP = 6;
const PANEL_RIGHT = 284;
const TOP_BAR_HEIGHT = 20;
const SIDEBAR_WIDTH = 64;
const PANEL_GAP = 6;
const PANEL_X = SIDEBAR_WIDTH + PANEL_GAP;
const RAIL_WIDTH = 22;
const NAV_BAR_WIDTHS = [40, 32, 44, 28, 36];
const MENU_BAR_WIDTHS = [26, 20, 30, 18];
const RAIL_TILE_COUNT = 5;
const MARK_SIZE = 11;
const STROKE = { strokeWidth: 0.75 };

const SURFACE = 'fill-surface dark:fill-surface-dark';
const PANEL = 'fill-white stroke-border dark:fill-surface-dark dark:stroke-border-dark';
const INK_15 = 'fill-text/15 dark:fill-text-dark/15';
const INK_10 = 'fill-text/10 dark:fill-text-dark/10';
const HAIRLINE = 'fill-none stroke-border dark:stroke-border-dark';

/**
 * The Ever mark sits at the top of the sidebar in every position (A2/A3): it
 * opens the launcher in `sidebar`, and is a plain mark otherwise. `header`
 * draws the top bar's grid icon; `rail` draws the column of app icons.
 */
const LAYOUTS = {
    sidebar: { sidebarX: 0, panelX: PANEL_X, hasRail: false, grid: null, menu: { x: 8, y: 24 } },
    header: {
        sidebarX: 0,
        panelX: PANEL_X,
        hasRail: false,
        grid: { x: 272, y: 16 },
        menu: { x: 216, y: 27 },
    },
    rail: {
        sidebarX: RAIL_WIDTH,
        panelX: RAIL_WIDTH + PANEL_X,
        hasRail: true,
        grid: null,
        menu: null,
    },
} as const;

type Point = Readonly<{ x: number; y: number }>;

function Mark({ x, y }: Point) {
    const half = MARK_SIZE / 2;
    return (
        <EverMark spinning={false} x={x - half} y={y - half} width={MARK_SIZE} height={MARK_SIZE} />
    );
}

/** The top bar's 2×2 grid icon. */
function GridGlyph({ x, y }: Point) {
    const cell = 3.6;
    const gap = 1.4;
    const start = -(cell + gap / 2);
    return (
        <g className="fill-text/70 dark:fill-text-dark/70">
            {[0, 1].flatMap((row) =>
                [0, 1].map((column) => (
                    <rect
                        key={`${row}-${column}`}
                        x={x + start + column * (cell + gap)}
                        y={y + start + row * (cell + gap)}
                        width={cell}
                        height={cell}
                        rx={0.9}
                    />
                )),
            )}
        </g>
    );
}

function FloatingMenu({ x, y }: Point) {
    return (
        <g>
            <rect x={x} y={y} width={62} height={44} rx={5} className={PANEL} {...STROKE} />
            {MENU_BAR_WIDTHS.map((barWidth, index) => {
                const rowY = y + 6 + index * 9.5;
                return (
                    <g key={barWidth}>
                        <rect x={x + 6} y={rowY} width={5} height={5} rx={1.4} className={INK_15} />
                        <rect
                            x={x + 14}
                            y={rowY + 1}
                            width={barWidth}
                            height={3}
                            rx={1.5}
                            className={INK_15}
                        />
                    </g>
                );
            })}
            <circle cx={x + 55} cy={y + 8.5} r={2.2} className="fill-primary" />
        </g>
    );
}

function Rail() {
    return (
        <g>
            <rect
                x={0}
                y={11.5}
                width={2}
                height={6}
                rx={1}
                className="fill-text dark:fill-text-dark"
            />
            {Array.from({ length: RAIL_TILE_COUNT }, (_, index) => (
                <rect
                    key={index}
                    x={6.5}
                    y={10 + index * 13}
                    width={9}
                    height={9}
                    rx={2.5}
                    className={
                        index === 0
                            ? 'fill-text/60 dark:fill-text-dark/60'
                            : 'fill-text/25 dark:fill-text-dark/25'
                    }
                />
            ))}
        </g>
    );
}

function SidebarColumn({ x }: Readonly<{ x: number }>) {
    const switcherX = x + 22;
    return (
        <g>
            <rect x={switcherX} y={10} width={34} height={10} rx={3} className={INK_15} />
            {NAV_BAR_WIDTHS.map((barWidth, index) => (
                <rect
                    key={barWidth}
                    x={x + 8}
                    y={32 + index * 10}
                    width={barWidth}
                    height={4}
                    rx={2}
                    className={INK_10}
                />
            ))}
        </g>
    );
}

function PagePanel({ x, leavesRoomForMark }: Readonly<{ x: number; leavesRoomForMark: boolean }>) {
    const width = PANEL_RIGHT - x;
    const topBarY = PANEL_TOP + TOP_BAR_HEIGHT;
    const pillsEnd = leavesRoomForMark ? PANEL_RIGHT - 22 : PANEL_RIGHT - 10;
    const rowWidth = width - 20;
    const rowYs = [topBarY + 10, topBarY + 36, topBarY + 62, topBarY + 88];
    return (
        <g>
            <rect
                x={x}
                y={PANEL_TOP}
                width={width}
                height={144}
                rx={7}
                className={PANEL}
                {...STROKE}
            />
            <rect
                x={x}
                y={topBarY}
                width={width}
                height={0.75}
                className="fill-border dark:fill-border-dark"
            />
            <rect x={x + 10} y={PANEL_TOP + 8} width={36} height={4} rx={2} className={INK_15} />
            <rect
                x={pillsEnd - 56}
                y={PANEL_TOP + 5.5}
                width={26}
                height={9}
                rx={4.5}
                className={HAIRLINE}
                {...STROKE}
            />
            <rect
                x={pillsEnd - 26}
                y={PANEL_TOP + 5.5}
                width={26}
                height={9}
                rx={4.5}
                className={HAIRLINE}
                {...STROKE}
            />
            {rowYs.map((rowY) => (
                <g key={rowY}>
                    <rect
                        x={x + 10}
                        y={rowY}
                        width={rowWidth}
                        height={20}
                        rx={5}
                        className={HAIRLINE}
                        {...STROKE}
                    />
                    <rect
                        x={x + 18}
                        y={rowY + 8}
                        width={rowWidth * 0.35}
                        height={4}
                        rx={2}
                        className={INK_10}
                    />
                </g>
            ))}
        </g>
    );
}

export function AppLauncherPlacementPreview({
    placement,
    className,
}: Readonly<{ placement: AppLauncherPlacement; className?: string }>) {
    const layout = LAYOUTS[placement];
    return (
        <svg
            aria-hidden="true"
            focusable="false"
            className={className}
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            data-testid={`app-launcher-placement-preview-${placement}`}
        >
            <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} className={SURFACE} />
            {layout.hasRail && <Rail />}
            <SidebarColumn x={layout.sidebarX} />
            <PagePanel x={layout.panelX} leavesRoomForMark={placement === 'header'} />
            <Mark x={layout.sidebarX + 13} y={15} />
            {layout.grid && <GridGlyph x={layout.grid.x} y={layout.grid.y} />}
            {layout.menu && <FloatingMenu x={layout.menu.x + layout.sidebarX} y={layout.menu.y} />}
        </svg>
    );
}
