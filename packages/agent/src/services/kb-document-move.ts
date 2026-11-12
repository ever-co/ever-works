/**
 * Moving (renaming) a Work's Knowledge Base document — the pure parts.
 *
 * `KnowledgeBaseService.moveDocument` owns the write; this module holds what
 * it and the git mirror share and what is worth testing without a database:
 *
 *  - the path a document may move to ({@link KB_MOVE_PATH_PATTERN}),
 *  - the retired-path marker the mirror uses to remove the old files
 *    ({@link KB_MIRROR_RETIRED_PATHS_KEY}),
 *  - the rewrite of the links other documents' bodies carry to the old path
 *    ({@link rewriteKbDocumentLinks}).
 */

/**
 * Where a document may move: a class folder, any sub-folders, then a file
 * name ending in `.md`, each segment starting with a letter or digit and
 * using only letters, digits, `-`, `_` and `.`.
 *
 * Stricter than create on purpose: these are the characters every way of
 * pointing at a document recognises — the `[[path]]` wikilink renderer
 * (`wikilink-md.ts`), `@kb:` mentions (`kb-mention-parser.ts`) and `kb:`
 * citations (`kb-citation-parser.ts`). A document moved to a path with a
 * space in it could no longer be linked to. The class-folder and traversal
 * rules are `KnowledgeBaseGitMirrorService.validateRelativeKbPath`, the ones
 * create applies.
 */
export const KB_MOVE_PATH_PATTERN =
    /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*\.md$/;

/**
 * The key under `work_knowledge_documents.metadata` (the entity's extension
 * dict, as for `lastContentWrite`) listing the paths a document was moved
 * away from, most recent last.
 *
 * Written in the same compare-and-set write as the new `path`, so it can
 * never disagree with the row. Every mirror run of the document removes the
 * files still sitting at those paths (unless another document holds the path
 * now) in the same commit that writes the new ones — so a mirror run that is
 * lost (a queue outage, retries exhausted, an older worker) is repaired by
 * the next one instead of leaving the document in the repository twice.
 * Never cleared: removing an absent file is a no-op.
 */
export const KB_MIRROR_RETIRED_PATHS_KEY = 'mirrorRetiredPaths';

/** How many retired paths a document keeps (the oldest drop first). */
export const KB_MIRROR_RETIRED_PATHS_MAX = 20;

/** The retired paths recorded on a document's `metadata` (strings only, de-duplicated). */
export function retiredPathsOf(metadata: unknown): string[] {
    if (!metadata || typeof metadata !== 'object') return [];
    const raw = (metadata as Record<string, unknown>)[KB_MIRROR_RETIRED_PATHS_KEY];
    if (!Array.isArray(raw)) return [];
    const paths = raw.filter((p): p is string => typeof p === 'string' && p.length > 0);
    return [...new Set(paths)].slice(-KB_MIRROR_RETIRED_PATHS_MAX);
}

/**
 * The retired paths after a move from `fromPath` to `toPath`: `fromPath`
 * joins the list, and `toPath` leaves it (moving back to a path the document
 * once had must not make the mirror delete its own files).
 */
export function nextRetiredPaths(metadata: unknown, fromPath: string, toPath: string): string[] {
    const kept = retiredPathsOf(metadata).filter((p) => p !== fromPath && p !== toPath);
    return [...kept, fromPath].slice(-KB_MIRROR_RETIRED_PATHS_MAX);
}

/** Kebab slug of a document path: its last segment without `.md`, lower-cased (as create derives it). */
export function slugOfKbPath(path: string): string {
    const last = path.split('/').pop() ?? path;
    return last.replace(/\.md$/i, '').toLowerCase();
}

export interface KbLinkRewriteInput {
    /** The Work both documents belong to (links to another Work's document are left alone). */
    readonly workId: string;
    readonly oldPath: string;
    readonly newPath: string;
}

export interface KbLinkRewriteResult {
    readonly body: string;
    /** How many links were rewritten. */
    readonly rewritten: number;
}

const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
/** The renderer's wikilink grammar (`apps/web/.../kb/wikilink-md.ts`): `[[path]]` or `[[Label|path]]`. */
const WIKILINK_RE = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Code fences and inline code spans: links inside them are sample syntax, never rewritten. */
function codeRanges(source: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    for (const re of [FENCE_RE, INLINE_CODE_RE]) {
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(source)) !== null) {
            ranges.push([match.index, match.index + match[0].length]);
        }
    }
    return ranges;
}

function inCode(ranges: Array<[number, number]>, index: number): boolean {
    return ranges.some(([start, end]) => index >= start && index < end);
}

/** The path as the workbench editor writes it into an href: each segment URI-encoded. */
function encodedPath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Rewrite, in one document body, every link that points at `oldPath` in
 * `workId` so it points at `newPath`. The three forms the editors write:
 *
 *  - `[[oldPath]]` — the KB editor and the tree's "Copy wikilink",
 *  - `[[Label|oldPath]]` — the KB editor's labelled wikilink (the label is kept),
 *  - `/works/<workId>/kb/<oldPath>` — the workbench editor's Markdown link
 *    (`[Title](/works/…/kb/…)`), also inside an absolute URL.
 *
 * A link to a longer path (`oldPath.bak`, `oldPath/x`) and anything inside a
 * code fence or an inline code span is left as it was, as the renderer
 * leaves it. `@kb:` mentions and `kb:` citations are not links a body
 * carries (they are chat and agent-output formats) and are not touched.
 */
export function rewriteKbDocumentLinks(
    body: string,
    input: KbLinkRewriteInput,
): KbLinkRewriteResult {
    const { workId, oldPath, newPath } = input;
    if (!body || !oldPath || oldPath === newPath) return { body, rewritten: 0 };

    let rewritten = 0;

    // Pass 1 — wikilinks. `replace` hands each match its offset in the
    // string being scanned, so the code ranges are of that same string.
    const wikiCode = codeRanges(body);
    const afterWikilinks = body.replace(
        WIKILINK_RE,
        (full: string, first: string, second: string | undefined, offset: number) => {
            if (inCode(wikiCode, offset)) return full;
            if (second === undefined) {
                if (first.trim() !== oldPath) return full;
                rewritten += 1;
                return `[[${first.replace(oldPath, () => newPath)}]]`;
            }
            if (second.trim() !== oldPath) return full;
            rewritten += 1;
            return `[[${first}|${second.replace(oldPath, () => newPath)}]]`;
        },
    );

    // Pass 2 — Markdown / URL links into this Work's KB route. The path must
    // end where the URL does (`)`, whitespace, a fragment or query, a quote,
    // `>` or `]`), so `brand/voice.md` never matches `brand/voice.md.bak`.
    const prefix = `/works/${encodeURIComponent(workId)}/kb/`;
    const variants = [...new Set([oldPath, encodedPath(oldPath)])].map(escapeRegExp);
    const urlRe = new RegExp(
        `${escapeRegExp(prefix)}(?:${variants.join('|')})(?=$|[)\\s#?"'<>\\]])`,
        'g',
    );
    const urlCode = codeRanges(afterWikilinks);
    const replacement = `${prefix}${encodedPath(newPath)}`;
    const afterUrls = afterWikilinks.replace(urlRe, (full: string, offset: number) => {
        if (inCode(urlCode, offset)) return full;
        rewritten += 1;
        return replacement;
    });

    return { body: afterUrls, rewritten };
}
