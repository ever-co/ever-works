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

/**
 * The renderer's wikilink grammar (`apps/web/.../kb/wikilink-md.ts`): `[[path]]` or `[[Label|path]]`.
 *
 * `[` is excluded from both parts as well as `]`: without it a line of
 * thousands of `[` made every one of them start a scan to the end of the
 * line (a quadratic match, seconds per body), and a move scans every
 * document of the Work. No path can hold `[` ({@link KB_MOVE_PATH_PATTERN}).
 */
const WIKILINK_RE = /\[\[([^[\]\n|]+?)(?:\|([^[\]\n]+?))?\]\]/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
/** A fence opener: up to three spaces, then three or more backticks or tildes. */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

type Range = readonly [start: number, end: number];

/**
 * Fenced code blocks: ``` or ~~~, closed by a fence of the same character at
 * least as long, or running to the end of the body when never closed (as
 * CommonMark and the editors' markdown-it have it). One pass over the lines,
 * so a body full of openers costs no more than its length.
 *
 * HTML comments are NOT code: the workbench editor renders Markdown with
 * HTML off, so a `<!-- … -->` is shown as text and the links in it work. A
 * link in one is rewritten like any other (it keeps pointing at the
 * document), and a stray `<!--` can never hide the links after it.
 */
function blockRanges(source: string): Range[] {
    const ranges: Range[] = [];
    let offset = 0;
    let fence: { char: string; length: number; start: number } | null = null;
    while (offset <= source.length) {
        const newline = source.indexOf('\n', offset);
        const end = newline === -1 ? source.length : newline;
        const line = source.slice(offset, end);
        const opener = FENCE_OPEN_RE.exec(line);
        if (fence) {
            if (
                opener &&
                opener[1][0] === fence.char &&
                opener[1].length >= fence.length &&
                line.slice(opener[0].length).trim() === ''
            ) {
                ranges.push([fence.start, end]);
                fence = null;
            }
        } else if (
            opener &&
            !(opener[1][0] === '`' && line.slice(opener[0].length).includes('`'))
        ) {
            fence = { char: opener[1][0], length: opener[1].length, start: offset };
        }
        if (newline === -1) break;
        offset = newline + 1;
    }
    if (fence) ranges.push([fence.start, source.length]);
    return ranges;
}

/** Sort and merge `ranges` into disjoint ones, so a binary search answers "inside one?". */
function mergeRanges(ranges: Range[]): Range[] {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [start, end] of sorted) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1]) {
            last[1] = Math.max(last[1], end);
        } else {
            merged.push([start, end]);
        }
    }
    return merged;
}

/** Whether `index` falls inside one of the disjoint, sorted `ranges` (binary search). */
function inRanges(ranges: readonly Range[], index: number): boolean {
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        const [start, end] = ranges[mid];
        if (index < start) high = mid - 1;
        else if (index >= end) low = mid + 1;
        else return true;
    }
    return false;
}

/**
 * Every part of `source` whose links are sample syntax, never rewritten:
 * fenced code blocks, and inline code spans outside them. Disjoint and
 * sorted, for {@link inRanges}.
 */
function codeRanges(source: string): Range[] {
    const blocks = mergeRanges(blockRanges(source));
    const ranges: Range[] = [...blocks];
    INLINE_CODE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_CODE_RE.exec(source)) !== null) {
        if (!inRanges(blocks, match.index)) {
            ranges.push([match.index, match.index + match[0].length]);
        }
    }
    return mergeRanges(ranges);
}

/** The path as the workbench editor writes it into an href: each segment URI-encoded. */
function encodedPath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Where a link's path ends: the end of the body, whitespace, `)`, `]`, `|`
 * (a table cell), a fragment or query, a quote or `>` — or sentence
 * punctuation (`.`, `,`, `;`, `:`, `!`) followed by one of those. So
 * `brand/voice.md.` at the end of a sentence is a link to `brand/voice.md`,
 * while `brand/voice.md.bak` is not.
 */
const URL_PATH_END = String.raw`(?=$|[)\s#?"'<>\]|]|[.,;:!](?:$|[)\s"'<>\]|]))`;

/**
 * Rewrite, in one document body, every link that points at `oldPath` in
 * `workId` so it points at `newPath`. The three forms the editors write:
 *
 *  - `[[oldPath]]` — the KB editor and the tree's "Copy wikilink",
 *  - `[[Label|oldPath]]` — the KB editor's labelled wikilink (the label is kept),
 *  - `/works/<workId>/kb/<oldPath>` — the workbench editor's Markdown link
 *    (`[Title](/works/…/kb/…)`), also inside an absolute URL, and a bare URL
 *    ending a sentence or a table cell.
 *
 * Left as they were, as the renderer leaves them: a link to a longer path
 * (`oldPath.bak`, `oldPath/x`), and anything inside a fenced code block
 * (``` or ~~~, also one never closed) or an inline code span. An indented
 * code block is NOT recognised (telling one from a list item's continuation
 * needs the whole Markdown parse); the editors write fences. A link inside
 * an HTML comment IS rewritten (see {@link blockRanges}). `@kb:` mentions and
 * `kb:` citations are not links a body carries (they are chat and
 * agent-output formats) and are not touched.
 *
 * Linear in the body's length: a body that does not contain the old path at
 * all is returned untouched without a scan, and no pattern can backtrack
 * across a line (a move scans every document of the Work, so one planted
 * body must not be able to stall it).
 */
export function rewriteKbDocumentLinks(
    body: string,
    input: KbLinkRewriteInput,
): KbLinkRewriteResult {
    const { workId, oldPath, newPath } = input;
    if (!body || !oldPath || oldPath === newPath) return { body, rewritten: 0 };
    const encodedOld = encodedPath(oldPath);
    if (!body.includes(oldPath) && !body.includes(encodedOld)) return { body, rewritten: 0 };

    let rewritten = 0;

    // Pass 1 — wikilinks. `replace` hands each match its offset in the
    // string being scanned, so the code ranges are of that same string.
    const wikiCode = codeRanges(body);
    const afterWikilinks = body.replace(
        WIKILINK_RE,
        (full: string, first: string, second: string | undefined, offset: number) => {
            if (inRanges(wikiCode, offset)) return full;
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
    // end where the URL does ({@link URL_PATH_END}), so `brand/voice.md`
    // never matches `brand/voice.md.bak`.
    const prefix = `/works/${encodeURIComponent(workId)}/kb/`;
    const variants = [...new Set([oldPath, encodedOld])].map(escapeRegExp);
    const urlRe = new RegExp(
        `${escapeRegExp(prefix)}(?:${variants.join('|')})${URL_PATH_END}`,
        'g',
    );
    const urlCode = codeRanges(afterWikilinks);
    const replacement = `${prefix}${encodedPath(newPath)}`;
    const afterUrls = afterWikilinks.replace(urlRe, (full: string, offset: number) => {
        if (inRanges(urlCode, offset)) return full;
        rewritten += 1;
        return replacement;
    });

    return { body: afterUrls, rewritten };
}

/** The class folder a document path starts with (`brand/voice.md` → `brand`): its class. */
export function classFolderOfKbPath(path: string): string {
    return path.split('/')[0] ?? '';
}

/**
 * The paths that would clash with a document at `path` as files and folders
 * do on disk (the git mirror writes each document as a file under its
 * path): every parent of it as a document (`brand/guide.md` for
 * `brand/guide.md/voice.md`). Documents NESTED under `path` are the other
 * half (`path` + `/`), matched by prefix in the repository.
 */
export function kbPathParents(path: string): string[] {
    const segments = path.split('/');
    const parents: string[] = [];
    for (let i = 1; i < segments.length; i += 1) {
        parents.push(segments.slice(0, i).join('/'));
    }
    return parents;
}
