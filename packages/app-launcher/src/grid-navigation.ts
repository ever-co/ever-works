/**
 * The panel grid's pure keyboard model — spec §6.6's "Panel grid" rows, with the
 * panel's geometry passed in so the model itself never touches the DOM.
 *
 * Spec: FR-39 (arrows move one tile / one row, `Home` and `End` jump, a letter
 * jumps to the next name starting with it) and FR-40 (`Esc` and the focus trap
 * belong to the element, not here). Acceptance: ACC-11-29.
 *
 * Two asymmetries, both straight out of the spec rather than taste:
 *
 *  - **Arrows clamp.** §6.6 says "Previous / next tile" and "Tile above /
 *    below" and gives no wrap-around, so `←` on the first tile stays on the
 *    first tile.
 *  - **Typeahead wraps.** T11 names wrap-around, so `c` from the last tile
 *    lands on the first name starting with `c`.
 *
 * A grid whose geometry is unknown (`count` or `columns` not positive) answers
 * `null` for every key: refusing to move is the safe reading of "we do not know
 * how big this grid is", and the element only ever passes 2 or 3 (FR-3).
 */

/** The keys of §6.6's "Panel grid" rows, and only those. */
export const GRID_NAVIGATION_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'] as const;

/** A key {@link nextGridIndex} owns. */
export type GridNavigationKey = (typeof GRID_NAVIGATION_KEYS)[number];

/**
 * The keys of §6.6's "Control" row: open the panel and focus the first tile.
 * `Spacebar` is the legacy spelling some browsers still report; `' '` is the
 * modern one, and both mean Space.
 */
export const CONTROL_OPEN_KEYS = ['Enter', ' ', 'Spacebar', 'ArrowDown'] as const;

/** Whether `key` is one of §6.6's grid keys. */
export function isGridNavigationKey(key: string): key is GridNavigationKey {
	return (GRID_NAVIGATION_KEYS as readonly string[]).includes(key);
}

/** Whether `key` is one of §6.6's "Control" open keys. */
export function isControlOpenKey(key: string): boolean {
	return (CONTROL_OPEN_KEYS as readonly string[]).includes(key);
}

/** One printable ASCII letter, which is what §6.6's "a letter" means. */
const TYPEAHEAD_KEY = /^[a-zA-Z]$/;

/** Whether `key` is a single letter {@link typeaheadIndex} can search for. */
export function isTypeaheadKey(key: string): boolean {
	return TYPEAHEAD_KEY.test(key);
}

/** Everything the model needs to answer one key press. */
export interface GridNavigationInput {
	/** The pressed key, `KeyboardEvent.key`. */
	key: string;
	/** The tile that currently has focus; `-1` or an out-of-range value is normalised. */
	index: number;
	/** The panel's column count (FR-3: 3 at ≥ 360 px, else 2). */
	columns: number;
	/** How many tiles the grid holds. */
	count: number;
}

/** `value`, truncated to an integer, or `0` when it is not a finite number. */
function toFiniteInteger(value: number): number {
	return Number.isFinite(value) ? Math.trunc(value) : 0;
}

/**
 * The index the grid should move to for `key`, or `null` when this model does
 * not own the key (or has no grid to move in).
 *
 * `index` is normalised into `0…count - 1` first, so a stale index left behind
 * by a re-render still moves relative to a real tile.
 */
export function nextGridIndex(input: GridNavigationInput): number | null {
	const { key, index, columns, count } = input;
	if (count <= 0) return null;
	if (columns <= 0) return null;
	if (!isGridNavigationKey(key)) return null;

	const last = count - 1;
	const current = Math.min(Math.max(toFiniteInteger(index), 0), last);

	if (key === 'Home') return 0;
	if (key === 'End') return last;
	if (key === 'ArrowLeft') return Math.max(current - 1, 0);
	if (key === 'ArrowRight') return Math.min(current + 1, last);

	const step = Math.max(1, Math.trunc(columns));
	return key === 'ArrowDown' ? Math.min(current + step, last) : Math.max(current - step, 0);
}

/**
 * One section of the panel, as the keyboard sees it: how many tiles it holds and
 * how many sit side by side. **Ever apps** is a list of rows (`columns: 1`);
 * **Pinned** and **Your apps** are tile grids.
 */
export interface NavigationSection {
	count: number;
	columns: number;
}

/** {@link nextSectionedIndex}'s input: the key, the focused tile and the sections in DOM order. */
export interface SectionedNavigationInput {
	key: string;
	/** The focused tile's index in the panel's flat order; normalised like {@link nextGridIndex}'s. */
	index: number;
	sections: readonly NavigationSection[];
}

/**
 * {@link nextGridIndex} for a panel whose sections each start on a new line and
 * may lay out differently (a list of rows above a tile grid).
 *
 * `ArrowLeft` / `ArrowRight` / `Home` / `End` move through the flat order, as in
 * one grid. `ArrowDown` / `ArrowUp` move one visual line inside a section and,
 * from its last / first line, to the nearest tile of the next / previous
 * non-empty section, keeping the column where that section has one. Past the
 * last line of the panel `ArrowDown` lands on the last tile, and past the first
 * `ArrowUp` on the first — the edges {@link nextGridIndex} has.
 */
export function nextSectionedIndex(input: SectionedNavigationInput): number | null {
	const sections = input.sections
		.map((section) => ({
			count: Math.max(0, toFiniteInteger(section.count)),
			columns: Math.max(1, toFiniteInteger(section.columns))
		}))
		.filter((section) => section.count > 0);
	const count = sections.reduce((sum, section) => sum + section.count, 0);
	if (count <= 0) return null;
	const { key } = input;
	if (!isGridNavigationKey(key)) return null;

	const last = count - 1;
	const current = Math.min(Math.max(toFiniteInteger(input.index), 0), last);

	if (key === 'Home') return 0;
	if (key === 'End') return last;
	if (key === 'ArrowLeft') return Math.max(current - 1, 0);
	if (key === 'ArrowRight') return Math.min(current + 1, last);

	// The section that holds `current`, and where each section starts.
	const starts: number[] = [];
	let at = 0;
	for (const section of sections) {
		starts.push(at);
		at += section.count;
	}
	let sectionIndex = 0;
	while (sectionIndex < sections.length - 1 && current >= starts[sectionIndex + 1]) sectionIndex += 1;

	const section = sections[sectionIndex];
	const start = starts[sectionIndex];
	const local = current - start;
	const column = local % section.columns;
	const line = Math.floor(local / section.columns);
	const lastLine = Math.floor((section.count - 1) / section.columns);

	if (key === 'ArrowDown') {
		if (line < lastLine) return start + Math.min(local + section.columns, section.count - 1);
		const next = sections[sectionIndex + 1];
		if (next === undefined) return last;
		return starts[sectionIndex + 1] + Math.min(column, next.columns - 1, next.count - 1);
	}

	if (line > 0) return start + local - section.columns;
	const previous = sections[sectionIndex - 1];
	if (previous === undefined) return 0;
	const previousStart = starts[sectionIndex - 1];
	const previousLastLineStart = Math.floor((previous.count - 1) / previous.columns) * previous.columns;
	return previousStart + Math.min(previousLastLineStart + column, previous.count - 1);
}

/**
 * The index of the next tile whose name starts with `key`, wrapping past the end
 * of the grid, or `null` when no other tile matches.
 *
 * The search starts **strictly after** `from` and covers every other tile
 * exactly once, so it can never report a move to the tile the person is already
 * on — pressing the letter of the tile you are on with no other match does
 * nothing rather than re-focusing it.
 *
 * Matching is case-insensitive; a tile with an empty name is skipped.
 */
export function typeaheadIndex(names: readonly string[], from: number, key: string): number | null {
	if (!isTypeaheadKey(key)) return null;
	if (names.length === 0) return null;

	const last = names.length - 1;
	const current = Math.min(Math.max(toFiniteInteger(from), 0), last);
	const letter = key.toLowerCase();

	for (let offset = 1; offset <= last; offset += 1) {
		const candidate = (current + offset) % names.length;
		const name = names[candidate];
		if (name && name.toLowerCase().startsWith(letter)) return candidate;
	}

	return null;
}
