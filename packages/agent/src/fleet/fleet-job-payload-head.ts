/**
 * Reading two ids out of the HEAD of a fleet job's stored payload.
 *
 * A node's run statistics need, for each finished `agent-task` job, the run
 * and task ids its payload carries. The payload is executor input — the
 * instructions, the workspace, the checks — and can weigh a hundred
 * kilobytes; a node can finish two thousand jobs in a week. Parsing each
 * whole document for two short strings, in SQL or anywhere else, costs in
 * proportion to bytes nobody needs (PR #3131 second review, N2: 11 to 13
 * seconds a read on Postgres at 128 KB a payload), and one stored value
 * that is not a JSON document, or holds a `\u0000` escape Postgres' JSON
 * type refuses, failed the whole read (N5).
 *
 * So the read takes a bounded PREFIX of the text (`SUBSTR`, which Postgres
 * answers without decompressing the rest of a TOASTed value) and this
 * module reads the ids out of it. That is enough because of where the ids
 * are: `FleetRunRouterService.enqueueAgentTask` builds the payload as
 * `{ taskId, agentId, userId, runId, … }`, `JSON.stringify` keeps insertion
 * order, and four ids fit in the first two hundred characters. A spec at
 * the router pins that (`fleet-agent-task-model-cli-dispatch.spec.ts`), so
 * a change of order fails there rather than silently here.
 *
 * A payload whose ids are NOT in the head (written by something else, or
 * not a document at all) reads as "no id": the job is then judged by its
 * own status, exactly as a job whose body the retention purge removed.
 */

/** How many characters of a stored payload the run-statistics read looks at. */
export const FLEET_JOB_PAYLOAD_HEAD_CHARS = 512;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

function isWhitespace(code: number): boolean {
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * The string values of some TOP-LEVEL members of a JSON object, read from a
 * prefix of its text. Null for a wanted key that is not there, is not a JSON
 * string, or lies beyond (or across) the end of the prefix.
 *
 * It answers what `JSON.parse(whole)[key]` would for a string member that
 * sits wholly inside the prefix — a member inside a nested object or array
 * is never mistaken for a top-level one, and text inside a string value
 * (`"…\"runId\":\"x\"…"`) is never mistaken for a member. Where the document
 * repeats a key, the FIRST occurrence wins (`JSON.stringify` never writes
 * one twice).
 *
 * One pass over at most the prefix, no backtracking, and it never throws:
 * text that is not an object, or stops making sense, simply ends the read
 * with what was found so far.
 */
export function readLeadingJsonStringMembers<K extends string>(
    head: unknown,
    wanted: readonly K[],
): Record<K, string | null> {
    const found = {} as Record<K, string | null>;
    for (const key of wanted) found[key] = null;
    if (typeof head !== 'string' || wanted.length === 0) return found;

    const text = head;
    const end = text.length;
    let at = 0;
    const settled = new Set<string>();

    const skipWhitespace = (): void => {
        while (at < end && isWhitespace(text.charCodeAt(at))) at += 1;
    };
    /** Moves past a string token that starts at `at`; false when it does not close inside the prefix. */
    const skipString = (): boolean => {
        at += 1;
        while (at < end) {
            const code = text.charCodeAt(at);
            if (code === BACKSLASH) {
                at += 2;
                continue;
            }
            at += 1;
            if (code === QUOTE) return true;
        }
        return false;
    };
    const decode = (from: number, to: number): string | null => {
        try {
            const value: unknown = JSON.parse(text.slice(from, to));
            return typeof value === 'string' ? value : null;
        } catch {
            return null;
        }
    };

    skipWhitespace();
    if (at >= end || text.charCodeAt(at) !== OPEN_BRACE) return found;
    at += 1;

    for (;;) {
        skipWhitespace();
        if (at >= end || text.charCodeAt(at) !== QUOTE) return found;
        const keyFrom = at;
        if (!skipString() || at > end) return found;
        const key = decode(keyFrom, at);
        skipWhitespace();
        if (at >= end || text.charCodeAt(at) !== COLON) return found;
        at += 1;
        skipWhitespace();
        if (at >= end) return found;

        const isWanted =
            key !== null && (wanted as readonly string[]).includes(key) && !settled.has(key);
        const first = text.charCodeAt(at);
        if (first === QUOTE) {
            const valueFrom = at;
            if (!skipString() || at > end) return found;
            if (isWanted) {
                settled.add(key);
                found[key as K] = decode(valueFrom, at);
            }
        } else if (first === OPEN_BRACE || first === OPEN_BRACKET) {
            // A nested structure: skipped whole, strings inside it included.
            let depth = 0;
            let closed = false;
            while (at < end) {
                const code = text.charCodeAt(at);
                if (code === QUOTE) {
                    if (!skipString() || at > end) return found;
                    continue;
                }
                at += 1;
                if (code === OPEN_BRACE || code === OPEN_BRACKET) {
                    depth += 1;
                } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
                    depth -= 1;
                    if (depth === 0) {
                        closed = true;
                        break;
                    }
                }
            }
            if (!closed) return found;
            // Present, and not a string: the key is settled as "no id".
            if (isWanted) settled.add(key);
        } else {
            // A number, `true`, `false` or `null`.
            while (at < end) {
                const code = text.charCodeAt(at);
                if (code === COMMA || code === CLOSE_BRACE || isWhitespace(code)) break;
                at += 1;
            }
            if (isWanted) settled.add(key);
        }
        if (settled.size === wanted.length) return found;

        skipWhitespace();
        if (at >= end || text.charCodeAt(at) !== COMMA) return found;
        at += 1;
    }
}
