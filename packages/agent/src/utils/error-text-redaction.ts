import { redactSecrets } from '@ever-works/contracts';

/**
 * Redaction for generation error text and generation logs.
 *
 * These strings are shown to the Work's owner (`generateStatus.error`, `warnings`, `recentLogs`,
 * the history's `errorMessage` and `logs`), and on app.ever.works that owner can be an anonymous
 * visitor. Provider errors are relayed verbatim since the stream-error fix, and some providers echo
 * the key they refused: OpenAI's "Incorrect API key provided: sk-proj-****…wxyz", a header dump with
 * "Bearer …", a masked tail like "…a1B2". A platform key's head or tail must never reach a visitor.
 *
 * On top of the shared secret scanner (`redactSecrets`, full keys of known formats), this removes:
 * credentials in URLs; masked or partial keys with a known prefix (`sk-`, `tvly-`, `ghp_`, …); full
 * Tavily keys; `Bearer`/`Basic` credentials; masked key tails; long hex runs and long mixed-case
 * base64 runs. The human-readable text stays as it was.
 *
 * These broader rules are for error and log text only. The shared scanner also cleans generated
 * content and hard-rejects authored files, where a commit SHA or a long identifier is legitimate.
 *
 * Every pattern is linear on hostile input: no pattern can retry a long run from each offset.
 */

const REDACTED = '[redacted secret]';

// `scheme://user:password@` — matched from `://` (not the scheme) so a long run of scheme
// characters is not retried from every offset; the scheme is then read backwards from `://`.
const URL_USERINFO_RE = /:\/\/[^/\s:@]+:[^/\s@]+@/g;
const URL_SCHEME_CHAR_RE = /^[a-z0-9+.-]$/i;
const URL_SCHEME_LETTER_RE = /^[a-z]$/i;

// A key with a known prefix that contains a mask (`*`, `…` or `...`): `sk-proj-****wxyz`,
// `sk-…a1B2`, `sk-or-v1-0a1b...9f8e`, `tvly-****WXYZ`, `gho_****9z8Y`. The mask and the
// characters around it are disjoint sets, so the repetition cannot match the same text two ways.
const MASKED_PREFIXED_KEY_RE =
    /\b(?:(?:sk|rk|tvly|fc|ghp|gho|ghs|ghu|ghr|github_pat|glpat|xox[abpr]|hf|npm|pat)[-_]|AIza)[A-Za-z0-9_-]*(?:\*+|…+|\.{3,})(?:[A-Za-z0-9_-]+(?:\*+|…+|\.{3,}))*[A-Za-z0-9_-]*/g;

// A full Tavily key (`tvly-…`, `tvly-dev-…`): not one of the shared scanner's formats.
const TAVILY_KEY_RE = /\btvly-[A-Za-z0-9_-]{10,}/g;

// `Bearer <credential>` / `Basic <credential>`; the scheme word stays so the sentence still reads.
// Every credential is removed, however short (the text can reach an anonymous visitor), except the
// prose words that commonly follow the scheme name ("Bearer token missing", "Basic auth is …").
const AUTH_SCHEME_RE = /\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]+)/g;
const AUTH_SCHEME_PROSE = new Set([
    'auth',
    'authentication',
    'authorization',
    'credential',
    'credentials',
    'header',
    'is',
    'or',
    'realm',
    'scheme',
    'token',
    'tokens',
]);

// An asterisk-masked tail (`****ab12`): never prose, so always removed. The run may only start
// where the previous character is not `*`, so a long star run is tried from one offset only.
const STAR_MASKED_TAIL_RE = /(?<!\*)\*{3,}[A-Za-z0-9_-]{2,8}\b/g;

// An ellipsis-masked tail (`…a1B2`, `...9f8e`): removed only when the text talks about a key,
// since "loading...done" is prose.
const ELLIPSIS_MASKED_TAIL_RE = /(?:…|(?<!\.)\.{3})[A-Za-z0-9_-]{2,8}\b/g;
const KEY_WORD_RE =
    /\b(?:api[\s_-]?keys?|keys?|tokens?|secrets?|credentials?|passwords?|authorization)\b/i;

// One maximal run of key characters, classified in `redactLongRun`.
const LONG_RUN_RE = /[A-Za-z0-9+/=_-]{24,}/g;
const HEX_RE = /^[0-9a-fA-F]{32,}$/;

function redactUrlCredentials(text: string): string {
    return text.replace(URL_USERINFO_RE, (userinfo: string, offset: number) => {
        for (let at = offset - 1; at >= 0 && URL_SCHEME_CHAR_RE.test(text[at]); at -= 1) {
            if (URL_SCHEME_LETTER_RE.test(text[at])) return '://***:***@';
        }
        return userinfo;
    });
}

/**
 * A long run is a secret when one of its `-`/`_`/`/` segments is 32+ hex characters with a digit
 * (a raw hex key, `fc-<32 hex>`, a signature: random hex of that length has a digit all but always,
 * while a letters-only run such as "aaaa…" is not a key), or when it mixes upper case, lower case and
 * digits with a segment of 16+ characters (base64/base62 keys). Slugs, repository paths and UUIDs
 * have neither.
 */
function redactLongRun(run: string): string {
    const segments = run.split(/[-_/]/);
    if (segments.some((segment) => HEX_RE.test(segment) && /\d/.test(segment))) return REDACTED;
    const mixed = /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run);
    if (mixed && segments.some((segment) => segment.length >= 16)) return REDACTED;
    return run;
}

/** Error or log text with every key-like substring replaced by `[redacted secret]`. */
export function redactErrorText(text: string): string {
    if (!text) return text;

    let out = redactUrlCredentials(text);
    out = out.replace(MASKED_PREFIXED_KEY_RE, REDACTED);
    out = out.replace(TAVILY_KEY_RE, REDACTED);
    out = out.replace(AUTH_SCHEME_RE, (whole, scheme: string, space: string, credential: string) =>
        AUTH_SCHEME_PROSE.has(credential.toLowerCase()) ? whole : `${scheme}${space}${REDACTED}`,
    );
    out = redactSecrets(out).cleaned;
    out = out.replace(STAR_MASKED_TAIL_RE, REDACTED);
    if (KEY_WORD_RE.test(out)) {
        out = out.replace(ELLIPSIS_MASKED_TAIL_RE, REDACTED);
    }
    out = out.replace(LONG_RUN_RE, redactLongRun);
    return out;
}

type GenerationText = {
    error?: unknown;
    errorMessage?: unknown;
    warnings?: unknown;
    recentLogs?: unknown;
    logs?: unknown;
};

function redactStrings(list: unknown): unknown {
    if (!Array.isArray(list)) return list;
    let changed = false;
    const next = list.map((value) => {
        if (typeof value !== 'string') return value;
        const redacted = redactErrorText(value);
        if (redacted !== value) changed = true;
        return redacted;
    });
    return changed ? next : list;
}

function redactLogMessages(list: unknown): unknown {
    if (!Array.isArray(list)) return list;
    let changed = false;
    const next = list.map((entry) => {
        const message = (entry as { message?: unknown } | null)?.message;
        if (typeof message !== 'string') return entry;
        const redacted = redactErrorText(message);
        if (redacted === message) return entry;
        changed = true;
        return { ...(entry as object), message: redacted };
    });
    return changed ? next : list;
}

/**
 * The same object with `error`/`errorMessage`, every `warnings` string and every `recentLogs`/`logs`
 * message passed through {@link redactErrorText}. Returns the input itself when nothing changed, so
 * callers that compare by reference keep working.
 */
export function redactGenerationText<T extends GenerationText | null | undefined>(value: T): T {
    if (!value || typeof value !== 'object') return value;

    const updates: Partial<GenerationText> = {};
    for (const key of ['error', 'errorMessage'] as const) {
        const text = value[key];
        if (typeof text === 'string') {
            const redacted = redactErrorText(text);
            if (redacted !== text) updates[key] = redacted;
        }
    }
    const warnings = redactStrings(value.warnings);
    if (warnings !== value.warnings) updates.warnings = warnings;
    for (const key of ['recentLogs', 'logs'] as const) {
        const logs = redactLogMessages(value[key]);
        if (logs !== value[key]) updates[key] = logs;
    }

    return Object.keys(updates).length ? ({ ...value, ...updates } as T) : value;
}
