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
 * "Blog", …). It used to be ignored, which is why the address bar kept showing
 * `#type=directory-website` after the wizard had stripped the rest.
 */
export interface PromptHandoff {
    /** Sanitised and bounded to the 5000 characters the API accepts. */
    readonly prompt: string;
    /** The home page's funnel id, when it is a plain token. */
    readonly correlationId?: string;
    /** The Work kind for the chip the visitor picked, when it has one. */
    readonly kind?: HandoffWorkKind;
    /** The same URL with the consumed keys removed, for `history.replaceState`. */
    readonly cleanedHref: string;
}

export type HandoffWorkKind = 'website' | 'landing-page' | 'blog' | 'directory' | 'awesome-repo';

const CONSUMED_KEYS = ['prompt', 'corrId', 'type'] as const;
const CORRELATION_ID = /^[A-Za-z0-9_-]{8,64}$/;
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
 * Reads the hand-off from a full URL. `null` when there is no usable prompt —
 * the wizard then opens as it always did.
 */
export function readPromptHandoff(href: string): PromptHandoff | null {
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        return null;
    }

    const hash = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
    const read = (key: string) => url.searchParams.get(key) ?? hash.get(key);

    const prompt = sanitizePrompt(read('prompt') ?? '', PROMPT_MAX_LENGTH);
    if (!prompt) return null;

    const corrId = read('corrId');
    const kind = landingTypeToWorkKind(read('type'));

    for (const key of CONSUMED_KEYS) {
        url.searchParams.delete(key);
        hash.delete(key);
    }
    const remainingHash = hash.toString();
    url.hash = remainingHash ? `#${remainingHash}` : '';

    return {
        prompt,
        ...(corrId && CORRELATION_ID.test(corrId) ? { correlationId: corrId } : {}),
        ...(kind ? { kind } : {}),
        cleanedHref: url.toString(),
    };
}
