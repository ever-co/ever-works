/**
 * Work slugs on the web side — isomorphic (no server-only imports), shared by
 * the Create-Work form (client) and its server action so both derive the SAME
 * slug from a name.
 *
 * A slug becomes the Work's repository names (`<slug>-website`, `<slug>-data`)
 * and must match `CreateWorkDto.slug` / `QuickCreateWorkDto.slug`:
 * `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
 *
 * The old derivation kept only `a-z0-9`, so a name with no Latin letters —
 * "Инструменты ИИ", "远程团队工具", "أدوات" — produced an EMPTY slug and the
 * create failed with "Failed to generate valid Work data". The form's own
 * example prompts did this in 10 of its 21 locales. Now:
 *   1. accents are stripped (é → e) and Cyrillic / Greek are transliterated;
 *   2. a name with nothing left (CJK, Arabic, Hebrew, Devanagari, Thai,
 *      Hangul…) gets `work-<hash of the name>` — stable, so the browser and the
 *      server agree, and still editable in the form.
 */

/** The slug contract of `CreateWorkDto` / `QuickCreateWorkDto`. */
export const WORK_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Longest slug derived automatically. GitHub caps repository names at 100
 * characters and the longest suffix the platform appends is `-website` (8).
 */
export const GENERATED_WORK_SLUG_MAX_LENGTH = 60;

// Cyrillic (Russian, Ukrainian, Bulgarian, Serbian…) and Greek, lowercase.
const TRANSLITERATION: Record<string, string> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    ґ: 'g',
    д: 'd',
    ђ: 'dj',
    е: 'e',
    ё: 'yo',
    є: 'ye',
    ж: 'zh',
    з: 'z',
    ѕ: 'dz',
    и: 'i',
    і: 'i',
    ї: 'yi',
    й: 'y',
    ј: 'j',
    к: 'k',
    л: 'l',
    љ: 'lj',
    м: 'm',
    н: 'n',
    њ: 'nj',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    ћ: 'c',
    у: 'u',
    ў: 'u',
    ф: 'f',
    х: 'h',
    ц: 'ts',
    ч: 'ch',
    џ: 'dz',
    ш: 'sh',
    щ: 'sht',
    ъ: 'a',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
    α: 'a',
    β: 'v',
    γ: 'g',
    δ: 'd',
    ε: 'e',
    ζ: 'z',
    η: 'i',
    θ: 'th',
    ι: 'i',
    κ: 'k',
    λ: 'l',
    μ: 'm',
    ν: 'n',
    ξ: 'x',
    ο: 'o',
    π: 'p',
    ρ: 'r',
    σ: 's',
    ς: 's',
    τ: 't',
    υ: 'y',
    φ: 'f',
    χ: 'ch',
    ψ: 'ps',
    ω: 'o',
};

function transliterate(value: string): string {
    let out = '';
    for (const char of value) {
        out += TRANSLITERATION[char] ?? char;
    }
    return out;
}

/**
 * Normalize text to slug characters: lowercase ASCII letters and digits joined
 * by single hyphens. Accents are stripped and Cyrillic / Greek transliterated;
 * every other character becomes a separator. May return `''`.
 */
export function slugifyForWork(value: string): string {
    const lower = value
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase();
    return transliterate(lower)
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/** FNV-1a (32-bit) of the string, base 36 — short, stable, dependency-free. */
function stableHash(value: string): string {
    let hash = 0x811c9dc5;
    for (const char of value) {
        hash ^= char.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36).padStart(7, '0');
}

/** Cut a slug to `max` characters without leaving a trailing hyphen. */
export function truncateWorkSlug(slug: string, max = GENERATED_WORK_SLUG_MAX_LENGTH): string {
    return slug.slice(0, max).replace(/-+$/g, '');
}

/**
 * The slug a Work NAME gets: its {@link slugifyForWork} form, cut to
 * {@link GENERATED_WORK_SLUG_MAX_LENGTH}, or `work-<hash>` when nothing of the
 * name survives. `''` only for a blank name.
 */
export function workSlugFromName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) {
        return '';
    }
    const slug = truncateWorkSlug(slugifyForWork(trimmed));
    return slug || `work-${stableHash(trimmed)}`;
}

/**
 * The slug the onboarding wizard's "Generate now" quick-create sends: the
 * prompt's slug cut to 40 characters, plus a random suffix so two users typing
 * the same prompt do not collide.
 *
 * It used to cut AFTER joining with hyphens and keep a trailing one, so a prompt
 * whose 40th character was a space produced `…tooling--abc123`, which
 * `QuickCreateWorkDto` refuses (7 of the 54 example prompts) — and a retry
 * failed the same way, since only the suffix changed.
 */
export function quickCreateSlugFromPrompt(
    prompt: string,
    suffix: string = Math.random().toString(36).slice(2, 8),
): string {
    const base = truncateWorkSlug(slugifyForWork(prompt), 40);
    const safeSuffix = slugifyForWork(suffix) || 'x';
    return base ? `${base}-${safeSuffix}` : `quick-${safeSuffix}`;
}

/**
 * Is a slug the user TYPED longer than a derived one may be? The API's slug
 * rule has no length cap, so an over-long slug was accepted and the create
 * failed late, at repository creation (`<slug>-website` past GitHub's
 * 100-character name limit). The Create-Work form holds a typed slug to
 * {@link GENERATED_WORK_SLUG_MAX_LENGTH}, the cap a derived slug already gets,
 * so both follow one rule.
 */
export function isWorkSlugTooLong(slug: string): boolean {
    return slug.length > GENERATED_WORK_SLUG_MAX_LENGTH;
}

/** Does `slug` satisfy the API's slug contract? */
export function isValidWorkSlug(slug: string | null | undefined): slug is string {
    return typeof slug === 'string' && WORK_SLUG_PATTERN.test(slug);
}
