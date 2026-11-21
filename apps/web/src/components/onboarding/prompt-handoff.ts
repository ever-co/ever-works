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
 * "Blog", …). It is consumed and removed from the URL — it used to stay behind
 * as `#type=directory-website` — but not mapped onto a Work kind: item
 * generation is not kind-aware yet, so that mapping waits for product sign-off
 * and quick-create keeps the platform default kind.
 */
export interface PromptHandoff {
    /** Sanitised and bounded to the 5000 characters the API accepts. */
    readonly prompt: string;
    /** The same URL with the consumed keys removed, for `history.replaceState`. */
    readonly cleanedHref: string;
}

const CONSUMED_KEYS = ['prompt', 'corrId', 'type'] as const;
/** `/onboarding`, optionally locale-prefixed (`/en/onboarding`) or with a trailing slash. */
const ONBOARDING_PATH = /^(?:\/[a-z]{2}(?:-[A-Za-z]{2})?)?\/onboarding\/?$/;
const PROMPT_MAX_LENGTH = 5000;

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

    for (const key of CONSUMED_KEYS) {
        url.searchParams.delete(key);
        hash.delete(key);
    }
    const remainingHash = hash.toString();
    url.hash = remainingHash ? `#${remainingHash}` : '';

    return {
        prompt,
        cleanedHref: url.toString(),
    };
}
