import type { AppLauncherListResponse } from '@ever-works/contracts';

/**
 * The Ever app switcher's two host-side facts (in-app switcher brief, 2026-11-26):
 * the translated one line under each Ever app, and where **+ Add** leads.
 *
 * Same list, order and lines in every Ever app and site (homelab
 * `docs/brand/EVER-SITES-UNIFIED-CHROME.md` §4 and §4b). Keep the copies in sync.
 * The catalog (`ever-works/platforms` `platforms.json`) carries the English line
 * as each entry's `description`; this file only swaps in the person's language.
 */

/** Ever Platform's id in the catalog. Its address is where **+ Add** leads. */
export const EVER_PLATFORM_CATALOG_ID = 'app-ever-co';

/**
 * Catalog id → the key of its line in `dashboard.appLauncher` of
 * `apps/web/messages/*.json` (a flat key: the block holds no nested groups). An
 * id that is not listed keeps the catalog's own English `description`.
 */
export const EVER_APP_LINE_KEYS = {
    'app-ever-co': 'linePlatform',
    'ever-works': 'lineWorks',
    'ever-teams': 'lineTeams',
    'ever-gauzy': 'lineGauzy',
    'ever-rec': 'lineRec',
    'ever-traduora': 'lineTraduora',
    'ever-demand': 'lineDemand',
    'ever-tech': 'lineTech',
} as const;

export type EverAppLineKey = (typeof EVER_APP_LINE_KEYS)[keyof typeof EVER_APP_LINE_KEYS];

const PLATFORM_KEY_PREFIX = 'platform:';

/** `platform:ever-works` → `lineWorks`; a Work, or an Ever app without a translated line → `null`. */
export function everAppLineKey(itemKey: string): EverAppLineKey | null {
    if (!itemKey.startsWith(PLATFORM_KEY_PREFIX)) return null;
    const catalogId = itemKey.slice(PLATFORM_KEY_PREFIX.length);
    return Object.prototype.hasOwnProperty.call(EVER_APP_LINE_KEYS, catalogId)
        ? EVER_APP_LINE_KEYS[catalogId as keyof typeof EVER_APP_LINE_KEYS]
        : null;
}

/**
 * The list with each known Ever app's line in the person's language. Works and
 * unknown catalog entries are passed through untouched, and so is the list
 * itself when nothing changes.
 */
export function withTranslatedLines(
    data: AppLauncherListResponse | null,
    translate: (key: EverAppLineKey) => string,
): AppLauncherListResponse | null {
    if (data === null) return null;
    let changed = false;
    const items = data.items.map((item) => {
        if (item.kind !== 'platform') return item;
        const lineKey = everAppLineKey(item.key);
        if (lineKey === null) return item;
        const description = translate(lineKey);
        if (description === item.description) return item;
        changed = true;
        return { ...item, description };
    });
    return changed ? { ...data, items } : data;
}

/**
 * **+ Add** (S7): `<Ever Platform address in this environment>/apps?add=app`,
 * read from the catalog entry the registry resolved for this environment —
 * hidden or not, since hiding Ever Platform from the list does not remove the
 * place where apps are added. `null` (no row) when the list has no Ever
 * Platform address: an installation without an Ever Platform shows nothing
 * Ever-specific.
 */
export function addAppUrlFrom(data: AppLauncherListResponse | null): string | null {
    const platform = data?.items.find(
        (item) => item.key === `${PLATFORM_KEY_PREFIX}${EVER_PLATFORM_CATALOG_ID}`,
    );
    if (!platform || typeof platform.url !== 'string') return null;
    try {
        const base = new URL(platform.url);
        if (base.protocol !== 'https:') return null;
        return new URL('/apps?add=app', base).toString();
    } catch {
        return null;
    }
}
