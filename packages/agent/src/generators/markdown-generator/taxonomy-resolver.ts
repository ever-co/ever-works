import type { Identifiable } from '@ever-works/contracts';

/**
 * Loose comparison key for a taxonomy value (category / tag id or name).
 *
 * Lowercases, folds accents, and collapses every run of characters that is
 * not a letter or digit (spaces, `&`, punctuation, hyphens) into a single
 * `-`. So the display name `Cloud & DevOps MCP Servers`, the variant
 * `Cloud Devops Mcp Servers` and the id `cloud-devops-mcp-servers` all map to
 * `cloud-devops-mcp-servers`.
 */
export function normalizeTaxonomyKey(value: unknown): string {
    return String(value ?? '')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Maps the raw category / tag values found on items to the canonical entries
 * of `categories.yml` / `tags.yml`.
 *
 * Items written by different generators (or by hand) refer to a category
 * either by its id (`data-access-integration-mcp-servers`) or by a display
 * name, often with drifting case and punctuation (`Data Access Integration MCP
 * Servers`, `Cloud & Devops Mcp Servers`). Treating every unknown string as a
 * new category made the README repeat the same section many times, so a value
 * is resolved in this order:
 *
 * 1. exact id match;
 * 2. loose match ({@link normalizeTaxonomyKey}) against the entries' names,
 *    then against their ids (names win when both would match);
 * 3. only when nothing matches, an ad-hoc `{ id: value, name: value }` entry,
 *    registered so that later variants of the same value resolve to it.
 */
export class TaxonomyResolver<T extends Identifiable> {
    private readonly byId = new Map<string, T>();
    private readonly byKey = new Map<string, T>();

    constructor(entries: readonly T[] = []) {
        const valid = (entries ?? []).filter(
            (entry): entry is T => !!entry && typeof entry.id === 'string' && entry.id !== '',
        );

        for (const entry of valid) {
            if (!this.byId.has(entry.id)) {
                this.byId.set(entry.id, entry);
            }
        }
        // Names first so that, on a clash, a value that reads like a display
        // name goes to the entry with that name.
        for (const entry of valid) {
            this.indexKey(normalizeTaxonomyKey(entry.name), entry);
        }
        for (const entry of valid) {
            this.indexKey(normalizeTaxonomyKey(entry.id), entry);
        }
    }

    /** Canonical entry for `id`, if one is known (loaded or ad-hoc). */
    get(id: string): T | undefined {
        return this.byId.get(id);
    }

    /**
     * Resolve a raw value (a string id / name, or an inline `{ id, name }`
     * object) to its canonical entry, registering an ad-hoc one when nothing
     * matches.
     */
    resolve(value: string | T): T {
        if (value && typeof value === 'object') {
            const known =
                this.byId.get(value.id) ??
                this.byKey.get(normalizeTaxonomyKey(value.id)) ??
                this.byKey.get(normalizeTaxonomyKey(value.name));
            if (known) {
                return known;
            }
            return this.register(value);
        }

        const raw = String(value ?? '');
        const known = this.byId.get(raw) ?? this.byKey.get(normalizeTaxonomyKey(raw));
        if (known) {
            return known;
        }
        return this.register({ id: raw, name: raw } as T);
    }

    private register(entry: T): T {
        this.byId.set(entry.id, entry);
        this.indexKey(normalizeTaxonomyKey(entry.id), entry);
        this.indexKey(normalizeTaxonomyKey(entry.name), entry);
        return entry;
    }

    private indexKey(key: string, entry: T) {
        if (key && !this.byKey.has(key)) {
            this.byKey.set(key, entry);
        }
    }
}
