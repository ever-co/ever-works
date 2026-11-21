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
    /** The home page's funnel id, when it is a plain token. */
    readonly correlationId?: string;
    /** The same URL with the consumed keys removed, for `history.replaceState`. */
    readonly cleanedHref: string;
}

const CONSUMED_KEYS = ['prompt', 'corrId', 'type'] as const;
const CORRELATION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const PROMPT_MAX_LENGTH = 5000;

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

    for (const key of CONSUMED_KEYS) {
        url.searchParams.delete(key);
        hash.delete(key);
    }
    const remainingHash = hash.toString();
    url.hash = remainingHash ? `#${remainingHash}` : '';

    return {
        prompt,
        ...(corrId && CORRELATION_ID.test(corrId) ? { correlationId: corrId } : {}),
        cleanedHref: url.toString(),
    };
}
