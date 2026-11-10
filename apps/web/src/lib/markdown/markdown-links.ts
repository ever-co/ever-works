import { safeHttpsUrl, safeWebUrl } from '@/lib/utils/safe-link';

/**
 * URL policy for Markdown that users and agents write into record
 * descriptions (Missions, Goals, Tasks, Teams, Works, Ideas, Agents).
 *
 * Links: `http(s):` (opened in a new tab), `mailto:`, in-page `#anchors` and
 * same-origin paths (`/missions/…`, `./x`, `../x`). Everything else —
 * `javascript:`, `vbscript:`, `data:`, `file:`, unknown schemes, embedded
 * credentials, `//other-host` — is refused and the label renders as text.
 *
 * Images: `https:` or a same-origin path only, so a description cannot pull
 * a plain-http or `data:` image into the page.
 *
 * Pure and client-safe; shared by the renderer and its tests.
 */

export interface MarkdownHref {
    href: string;
    /** An absolute web URL: opened in a new tab with `rel="noopener noreferrer"`. */
    external: boolean;
}

function sameOriginPath(value: string): string | null {
    // The browser drops tabs and newlines before it resolves a URL, so
    // `/\thost` would become `//host` — another host, not a path.
    const resolved = value.replace(/[\t\n\r]/g, '');
    if (resolved.startsWith('//') || resolved.startsWith('/\\')) return null;
    return value;
}

export function resolveMarkdownHref(raw: string | null | undefined): MarkdownHref | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value) return null;

    if (value.startsWith('#')) return { href: value, external: false };
    if (value.startsWith('/')) {
        const path = sameOriginPath(value);
        return path ? { href: path, external: false } : null;
    }
    if (value.startsWith('./') || value.startsWith('../')) {
        return { href: value, external: false };
    }
    if (/^mailto:[^\s]+$/i.test(value)) {
        try {
            return new URL(value).protocol === 'mailto:' ? { href: value, external: false } : null;
        } catch {
            return null;
        }
    }
    const web = safeWebUrl(value);
    return web ? { href: web, external: true } : null;
}

export function resolveMarkdownImageSrc(raw: string | null | undefined): string | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value) return null;
    if (value.startsWith('/')) return sameOriginPath(value);
    return safeHttpsUrl(value);
}
