/**
 * Carry the server's change to a document body over to the text an editor
 * holds, when the two touched different lines.
 *
 * `base` is the body the editor's text started from, `theirs` the body the
 * server holds now, `ours` the editor's current text. The case it is for: a
 * rename of another document rewrote the links in this one (`theirs`), while
 * someone was typing elsewhere in it (`ours`). A link rewrite changes lines in
 * place and never adds or removes one, so each changed line of `base` is found
 * in `ours` and replaced by its new text.
 *
 * Every changed line is located in the ORIGINAL `ours` before anything is
 * replaced, each exactly once and each at its own line, and then all are
 * replaced together. Replacing them one after another would let one change's
 * new text be taken for a later change's old text (`A→B`, `B→C` turned an
 * untouched `A` into `C`).
 *
 * `null` — nothing merged — when the server added or removed lines, when a
 * changed line is not in `ours` exactly once (the editor changed it too, or
 * it repeats), when two changes land on one line, or when too many lines
 * changed to be a link rewrite. The caller then keeps the editor's text and
 * lets the person choose.
 */
export function mergeLineChanges(base: string, theirs: string, ours: string): string | null {
    if (theirs === base) return ours;
    if (ours === base) return theirs;
    const baseLines = base.split('\n');
    const theirLines = theirs.split('\n');
    if (baseLines.length !== theirLines.length) return null;

    const changes: Array<[from: string, to: string]> = [];
    for (let i = 0; i < baseLines.length; i += 1) {
        if (baseLines[i] !== theirLines[i]) changes.push([baseLines[i], theirLines[i]]);
    }
    if (changes.length > MAX_MERGED_LINES) return null;

    const ourLines = ours.split('\n');
    const targets = new Map<number, string>();
    for (const [from, to] of changes) {
        let at = -1;
        for (let j = 0; j < ourLines.length; j += 1) {
            if (ourLines[j] !== from) continue;
            if (at !== -1) return null;
            at = j;
        }
        if (at === -1 || targets.has(at)) return null;
        targets.set(at, to);
    }
    return ourLines.map((line, j) => targets.get(j) ?? line).join('\n');
}

/** More changed lines than a rename's link rewrite makes in one document: not merged. */
const MAX_MERGED_LINES = 200;
