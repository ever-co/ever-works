import { sanitizePrompt } from '@/lib/utils/sanitize';

/**
 * EW-617 — the hand-off from the ever.works home page.
 *
 * The home-page prompt box sends the visitor to
 * `app.ever.works/onboarding#prompt=…&corrId=…[&type=…][&attachments=…][&repos=…]`
 * (a fragment, so the prompt never reaches a server log). `?prompt=` in the
 * query is the older form and still accepted.
 *
 * `type` is the chip the visitor picked under the box ("Directory Website",
 * "Blog", …). It is removed from the URL and, where it names a generated
 * Work kind, sent to quick-create as that kind.
 */
export interface PromptHandoff {
    /** Sanitised and bounded to the 5000 characters the API accepts. */
    readonly prompt: string;
    /** The Work kind for the chip the visitor picked, when it has one. */
    readonly kind?: HandoffWorkKind;
    /** The same URL with the consumed keys removed, for `history.replaceState`. */
    readonly cleanedHref: string;
}

export type HandoffWorkKind = 'website' | 'landing-page' | 'blog' | 'directory' | 'awesome-repo';

const CONSUMED_KEYS = ['prompt', 'corrId', 'type'] as const;
/** `/onboarding`, optionally locale-prefixed (`/en/onboarding`) or with a trailing slash. */
const ONBOARDING_PATH = /^(?:\/[a-z]{2}(?:-[A-Za-z]{2})?)?\/onboarding\/?$/;
const PROMPT_MAX_LENGTH = 5000;

/**
 * Home-page chip → Work kind. Only chips that name a generated kind the
 * create path offers are mapped; every other chip (`knowledge-base`, `store`,
 * `mission`, `idea`, and `company`, which only the Register-Company flow may
 * set) leaves the kind to the platform default. `repo` and `app` are not
 * home-page chips and need a repository URL, so they are never set from here.
 */
const KIND_BY_LANDING_TYPE: Readonly<Record<string, HandoffWorkKind>> = {
    website: 'website',
    'landing-page': 'landing-page',
    landing: 'landing-page',
    blog: 'blog',
    'directory-website': 'directory',
    directory: 'directory',
    'awesome-repo': 'awesome-repo',
};

const KIND_LABELS: Readonly<Record<HandoffWorkKind, string>> = {
    website: 'Website',
    'landing-page': 'Landing page',
    blog: 'Blog',
    directory: 'Directory website',
    'awesome-repo': 'Awesome repo',
};

export function landingTypeToWorkKind(
    type: string | null | undefined,
): HandoffWorkKind | undefined {
    if (typeof type !== 'string') return undefined;
    const key = type.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(KIND_BY_LANDING_TYPE, key)
        ? KIND_BY_LANDING_TYPE[key]
        : undefined;
}

export function workKindLabel(kind: HandoffWorkKind | undefined): string | undefined {
    return kind ? KIND_LABELS[kind] : undefined;
}

/**
 * Reads the hand-off from a full URL. `null` when there is no usable prompt,
 * or when the URL is not the onboarding page — the dashboard can auto-open the
 * wizard on any page, and pages such as `/tasks/new?prompt=…` own their
 * `prompt`. The wizard then opens as it always did. `corrId` is removed here
 * but read by the wizard itself when it mounts.
 */
export function readPromptHandoff(href: string): PromptHandoff | null {
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        return null;
    }
    if (!ONBOARDING_PATH.test(url.pathname)) return null;

    const hash = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
    const read = (key: string) => url.searchParams.get(key) ?? hash.get(key);

    const prompt = sanitizePrompt(read('prompt') ?? '', PROMPT_MAX_LENGTH);
    if (!prompt) return null;

    const kind = landingTypeToWorkKind(read('type'));

    for (const key of CONSUMED_KEYS) {
        url.searchParams.delete(key);
        hash.delete(key);
    }
    const remainingHash = hash.toString();
    url.hash = remainingHash ? `#${remainingHash}` : '';

    return {
        prompt,
        ...(kind ? { kind } : {}),
        cleanedHref: url.toString(),
    };
}
