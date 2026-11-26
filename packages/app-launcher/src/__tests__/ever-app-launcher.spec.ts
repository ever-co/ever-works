import type { AppLauncherItem, AppLauncherListResponse } from '@ever-works/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	EVER_APP_LAUNCHER_TAG,
	EverAppLauncher,
	PANEL_TILE_COLUMNS_MIN_WIDTH,
	PANEL_TILE_COLUMNS_MAX,
	PANEL_TILE_COLUMNS_MIN
} from '../ever-app-launcher.js';
import { EVER_APP_LAUNCHER_STYLES } from '../styles.js';

/**
 * T12 / plan §6.2–§6.3 — `<ever-app-launcher>` in host-fed mode.
 *
 * Acceptance evidence in this file: ACC-11-02 (sections and columns),
 * ACC-11-03 (6 skeleton tiles at 88 px), ACC-11-06 (**You're here** is not a
 * link), ACC-11-08 (an unsafe address is never opened), ACC-11-23 (the opened
 * address equals the stored one exactly), ACC-11-29 (keyboard + focus trap +
 * `Esc`), ACC-11-40 (a cancelled activation opens nothing) and ACC-11-48 (both
 * empty states, the `:empty-action` detail, and that the element never
 * navigates on its own).
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function item(partial: Partial<AppLauncherItem> & { key: string }): AppLauncherItem {
	return {
		kind: 'platform',
		section: 'platforms',
		name: partial.key,
		url: 'https://example.com',
		host: 'example.com',
		visible: true,
		pinned: false,
		pinOrder: null,
		order: 0,
		manageState: 'listed',
		...partial
	};
}

function response(
	items: AppLauncherItem[],
	meta: Partial<AppLauncherListResponse['meta']> = {}
): AppLauncherListResponse {
	return {
		items,
		meta: {
			environment: 'production',
			catalogVersion: 'v1.0.0',
			catalogAvailable: true,
			scopeKey: 'personal',
			worksTotal: items.filter((entry) => entry.kind === 'work').length,
			// FR-63's `{count}`: the eligible total, which is not `items.length`
			// once a response is capped. A host that renders the whole fixture
			// passes the same number it handed in.
			total: items.length,
			truncated: false,
			pinLimit: 6,
			appWorksAvailable: true,
			...meta
		}
	};
}

const EVER_WORKS = item({ key: 'platform:ever-works', name: 'Ever Works', current: true, order: 0 });
const GAUZY = item({ key: 'platform:ever-gauzy', name: 'Ever Gauzy', order: 1 });
const TEAMS = item({ key: 'platform:ever-teams', name: 'Ever Teams', status: 'beta', order: 2 });
const CAL = item({
	key: 'work:cal',
	kind: 'work',
	section: 'works',
	name: 'Cal',
	host: 'cal.example.com',
	url: 'https://cal.example.com',
	order: 0
});
const UMAMI = item({
	key: 'work:umami',
	kind: 'work',
	section: 'works',
	name: 'Umami',
	host: 'stats.example.com',
	url: 'https://stats.example.com',
	chip: 'deploying',
	order: 1
});
const DOCS = item({
	key: 'work:docs',
	kind: 'work',
	section: 'works',
	name: 'Docs',
	host: 'docs.example.com',
	url: 'https://docs.example.com',
	chip: 'lastDeployFailed',
	order: 2
});
const PINNED_CAL = item({ ...CAL, section: 'pinned', pinned: true, pinOrder: 0 });

const FULL_PANEL = response([PINNED_CAL, EVER_WORKS, GAUZY, TEAMS, UMAMI, DOCS]);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class ResizeObserverStub {
	static instances: ResizeObserverStub[] = [];

	readonly callback: ResizeObserverCallback;
	observed: Element[] = [];

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		ResizeObserverStub.instances.push(this);
	}

	observe(target: Element): void {
		this.observed.push(target);
	}

	unobserve(): void {}

	disconnect(): void {
		this.observed = [];
	}

	/** Pretend the observed panel just became `width` CSS pixels wide. */
	emit(width: number): void {
		this.callback(
			[{ contentRect: { width } } as unknown as ResizeObserverEntry],
			this as unknown as ResizeObserver
		);
	}

	static latest(): ResizeObserverStub {
		const latest = ResizeObserverStub.instances.at(-1);
		if (!latest) throw new Error('the element never created a ResizeObserver');
		return latest;
	}
}

async function mount(props: Partial<EverAppLauncher> = {}): Promise<EverAppLauncher> {
	const element = document.createElement(EVER_APP_LAUNCHER_TAG) as EverAppLauncher;
	Object.assign(element, props);
	document.body.appendChild(element);
	await element.updateComplete;
	return element;
}

function shadow(element: EverAppLauncher): ShadowRoot {
	const root = element.shadowRoot;
	if (!root) throw new Error('the element did not render a shadow root');
	return root;
}

function query<T extends Element>(element: EverAppLauncher, selector: string): T | null {
	return shadow(element).querySelector<T>(selector);
}

function queryAll<T extends Element>(element: EverAppLauncher, selector: string): T[] {
	return Array.from(shadow(element).querySelectorAll<T>(selector));
}

function tiles(element: EverAppLauncher): HTMLElement[] {
	return queryAll<HTMLElement>(element, '.tile');
}

function sectionNames(element: EverAppLauncher): string[] {
	return queryAll<HTMLElement>(element, '[data-section]')
		.filter((node) => node.classList.contains('section'))
		.map((node) => node.dataset.section ?? '');
}

function focused(element: EverAppLauncher): Element | null {
	const root = shadow(element);
	return (root.activeElement as Element | null) ?? (document.activeElement as Element | null);
}

function once<T extends Event>(target: EventTarget, type: string): Promise<T> {
	return new Promise((resolve) => {
		target.addEventListener(type, (event) => resolve(event as T), { once: true });
	});
}

async function open(element: EverAppLauncher, via: 'trigger' | 'api' = 'trigger'): Promise<void> {
	const opened = once(element, 'ever-app-launcher:open');
	if (via === 'api') element.show();
	else query<HTMLElement>(element, '.trigger')?.click();
	await opened;
	await element.updateComplete;
}

async function close(element: EverAppLauncher): Promise<void> {
	const closed = once(element, 'ever-app-launcher:close');
	element.hide();
	await closed;
	await element.updateComplete;
}

function keydown(target: EventTarget, key: string, shiftKey = false): void {
	target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, composed: true }));
}

let openSpy: ReturnType<typeof vi.fn>;

/**
 * The last click as the page saw it once the element had answered: a window
 * listener runs after the tile's own (bubble phase), records whether the
 * element stopped the anchor's navigation, and then stops it itself so the
 * test page never navigates away.
 */
let lastClick: { defaultPrevented: boolean; href: string | null } | null = null;
function recordClick(event: Event): void {
	const anchor = event.composedPath().find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
	lastClick = { defaultPrevented: event.defaultPrevented, href: anchor?.getAttribute('href') ?? null };
	event.preventDefault();
}

beforeEach(() => {
	ResizeObserverStub.instances = [];
	vi.stubGlobal('ResizeObserver', ResizeObserverStub);
	openSpy = vi.fn(() => null);
	vi.spyOn(window, 'open').mockImplementation(openSpy as unknown as typeof window.open);
	lastClick = null;
	window.addEventListener('click', recordClick);
});

afterEach(() => {
	window.removeEventListener('click', recordClick);
	document.body.innerHTML = '';
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('<ever-app-launcher>', () => {
	describe('the control (FR-1, FR-38, ACC-11-01)', () => {
		it('exposes that it opens a menu, whether it is expanded, and what it controls', async () => {
			const element = await mount({ data: FULL_PANEL });
			const trigger = query<HTMLElement>(element, '.trigger');
			const panel = query<HTMLElement>(element, '.panel');

			expect(trigger).not.toBeNull();
			expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
			expect(trigger?.getAttribute('aria-expanded')).toBe('false');
			expect(trigger?.getAttribute('aria-controls')).toBe(panel?.id);
			expect(panel?.id).toBeTruthy();
			expect(trigger?.getAttribute('aria-label')).toBe('App Launcher');
			expect(trigger?.getAttribute('title')).toBe('Ever apps and your apps');
		});

		it('opens on click, reports aria-expanded, and focuses the first tile', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);

			expect(query<HTMLElement>(element, '.trigger')?.getAttribute('aria-expanded')).toBe('true');
			expect(query<HTMLElement>(element, '.panel')?.hasAttribute('hidden')).toBe(false);
			expect(focused(element)).toBe(tiles(element)[0]);
		});

		it('opens from the keyboard with ArrowDown on the control (spec §6.6)', async () => {
			const element = await mount({ data: FULL_PANEL });
			const opened = once(element, 'ever-app-launcher:open');
			keydown(query<HTMLElement>(element, '.trigger') as EventTarget, 'ArrowDown');
			await opened;
			await element.updateComplete;
			expect(focused(element)).toBe(tiles(element)[0]);
		});

		it('closes on a second click of the control', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			await close(element);
			expect(query<HTMLElement>(element, '.panel')?.hasAttribute('hidden')).toBe(true);
			expect(query<HTMLElement>(element, '.trigger')?.getAttribute('aria-expanded')).toBe('false');
		});
	});

	describe('show() and hide() (plan §6.2)', () => {
		it('show() opens the panel and dispatches a bubbled, composed :open', async () => {
			const element = await mount({ data: FULL_PANEL });
			const seen = once<CustomEvent>(document, 'ever-app-launcher:open');
			element.show();
			const event = await seen;

			expect(event.bubbles).toBe(true);
			expect(event.composed).toBe(true);
			expect(query<HTMLElement>(element, '.panel')?.hasAttribute('hidden')).toBe(false);
		});

		it('show() moves focus into the panel, show({ focus: false }) leaves it where it was', async () => {
			const outside = document.createElement('input');
			document.body.appendChild(outside);
			const element = await mount({ data: FULL_PANEL });

			outside.focus();
			const opened = once<CustomEvent>(document, 'ever-app-launcher:open');
			element.show({ focus: false });
			await opened;
			expect(query<HTMLElement>(element, '.panel')?.hasAttribute('hidden')).toBe(false);
			expect(document.activeElement).toBe(outside);

			element.hide();
			await element.updateComplete;
			await new Promise((resolve) => setTimeout(resolve, 0));
			const reopened = once<CustomEvent>(document, 'ever-app-launcher:open');
			element.show();
			await reopened;
			expect(document.activeElement).toBe(element);
			outside.remove();
		});

		it('hide() closes the panel and dispatches :close', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			const seen = once<CustomEvent>(document, 'ever-app-launcher:close');
			element.hide();
			const event = await seen;
			expect(event.bubbles).toBe(true);
			expect(event.composed).toBe(true);
			expect(query<HTMLElement>(element, '.panel')?.hasAttribute('hidden')).toBe(true);
		});

		it('is idempotent — a second show() does not dispatch a second :open', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			const listener = vi.fn();
			element.addEventListener('ever-app-launcher:open', listener);
			element.show();
			await element.updateComplete;
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe('sections and order (FR-2, ACC-11-02)', () => {
		it('renders Pinned, Ever apps, Your apps and Manage apps in that order', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);

			expect(sectionNames(element)).toEqual(['pinned', 'platforms', 'works']);

			const panel = query<HTMLElement>(element, '.panel') as HTMLElement;
			const headings = queryAll<HTMLElement>(element, '.section-heading').map((node) => node.textContent?.trim());
			expect(headings).toEqual(['Pinned', 'Ever apps', 'Your apps']);

			const manage = query<HTMLElement>(element, '.manage');
			expect(manage?.textContent?.trim()).toBe('Manage apps');
			// The footer link is last: every heading precedes it.
			for (const heading of queryAll<HTMLElement>(element, '.section-heading')) {
				expect(heading.compareDocumentPosition(manage as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			}
			// Every tile opens in this tab (owner, 2026-11-26), so the footer no
			// longer says "Opens in a new tab".
			expect(panel.textContent).toContain('You may need to sign in.');
			expect(panel.textContent).not.toContain('new tab');
		});

		it('omits the Pinned row when nothing is pinned', async () => {
			const element = await mount({ data: response([EVER_WORKS, GAUZY, CAL]) });
			await open(element);
			expect(sectionNames(element)).toEqual(['platforms', 'works']);
			expect(query<HTMLElement>(element, '.section[data-section="pinned"]')).toBeNull();
		});

		it('names every group for assistive technology', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			for (const section of queryAll<HTMLElement>(element, '.section')) {
				expect(section.getAttribute('role')).toBe('group');
				const labelledBy = section.getAttribute('aria-labelledby');
				expect(labelledBy).toBeTruthy();
				expect(query<HTMLElement>(element, `#${labelledBy}`)?.textContent?.trim()).toBeTruthy();
			}
			expect(query<HTMLElement>(element, '.panel')?.getAttribute('role')).toBe('menu');
		});
	});

	describe('columns (FR-3, ACC-11-02)', () => {
		it('lays out 3 columns at 1280 px and 2 at 340 px', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);

			const observer = ResizeObserverStub.latest();
			observer.emit(1280);
			await element.updateComplete;
			expect(query<HTMLElement>(element, '.grid')?.dataset.columns).toBe('3');
			expect(query<HTMLElement>(element, '.grid')?.style.gridTemplateColumns).toContain('repeat(3');

			observer.emit(340);
			await element.updateComplete;
			expect(query<HTMLElement>(element, '.grid')?.dataset.columns).toBe('2');
			expect(query<HTMLElement>(element, '.grid')?.style.gridTemplateColumns).toContain('repeat(2');
		});

		it('feeds the column count to the keyboard model of the Your apps grid', async () => {
			const extra = item({ ...CAL, key: 'work:extra', name: 'Extra', order: 3 });
			// Tiles: [Ever Works (row), Cal, Umami, Docs, Extra] — one row, then a grid of four.
			const element = await mount({ data: response([EVER_WORKS, CAL, UMAMI, DOCS, extra]) });
			await open(element);
			const observer = ResizeObserverStub.latest();
			const panel = query<HTMLElement>(element, '.panel') as EventTarget;

			observer.emit(1280);
			await element.updateComplete;
			keydown(panel, 'Home');
			keydown(panel, 'ArrowDown');
			expect(focused(element), 'the row above steps into the grid').toBe(tiles(element)[1]);
			keydown(panel, 'ArrowDown');
			expect(focused(element), '3 columns').toBe(tiles(element)[4]);

			observer.emit(340);
			await element.updateComplete;
			keydown(panel, 'Home');
			keydown(panel, 'ArrowDown');
			keydown(panel, 'ArrowDown');
			expect(focused(element), '2 columns').toBe(tiles(element)[3]);
		});

		it('moves one Ever apps row per arrow, whatever the column count', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			ResizeObserverStub.latest().emit(1280);
			await element.updateComplete;
			const panel = query<HTMLElement>(element, '.panel') as EventTarget;

			// [Cal (pinned), Ever Works, Ever Gauzy, Ever Teams (rows), Umami, Docs]
			keydown(panel, 'ArrowDown');
			expect(focused(element)).toBe(tiles(element)[1]);
			keydown(panel, 'ArrowDown');
			expect(focused(element)).toBe(tiles(element)[2]);
			keydown(panel, 'ArrowDown');
			expect(focused(element)).toBe(tiles(element)[3]);
			keydown(panel, 'ArrowDown');
			expect(focused(element), 'from the last row into Your apps').toBe(tiles(element)[4]);
			keydown(panel, 'ArrowUp');
			expect(focused(element), 'and back to the last row').toBe(tiles(element)[3]);
		});

		it('ignores a zero-width report so the first paint is never 2 columns by accident', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			ResizeObserverStub.latest().emit(0);
			await element.updateComplete;
			expect(query<HTMLElement>(element, '.grid')?.dataset.columns).toBe(String(PANEL_TILE_COLUMNS_MAX));
		});

		it('states its breakpoints once', () => {
			expect(PANEL_TILE_COLUMNS_MIN_WIDTH).toBe(360);
			expect(PANEL_TILE_COLUMNS_MAX).toBe(3);
			expect(PANEL_TILE_COLUMNS_MIN).toBe(2);
		});
	});

	describe('loading (FR-5, ACC-11-03)', () => {
		it('renders 6 skeleton tiles that share the real tile height', async () => {
			const element = await mount({ loading: true });
			await open(element);

			const skeletons = queryAll<HTMLElement>(element, '.tile.skeleton');
			expect(skeletons).toHaveLength(6);
			for (const skeleton of skeletons) {
				expect(skeleton.classList.contains('tile')).toBe(true);
				expect(skeleton.getAttribute('aria-hidden')).toBe('true');
			}
			expect(EVER_APP_LAUNCHER_STYLES).toContain('--ever-app-launcher-tile-height: 88px');
			expect(EVER_APP_LAUNCHER_STYLES).toContain('height: var(--ever-app-launcher-tile-height)');
		});

		it('keeps rendering the cached list when a refresh is in flight (FR-6)', async () => {
			const element = await mount({ data: FULL_PANEL, loading: true });
			await open(element);
			expect(queryAll<HTMLElement>(element, '.tile.skeleton')).toHaveLength(0);
			expect(queryAll<HTMLElement>(element, '.tile')).toHaveLength(6);
		});
	});

	describe('tiles (FR-30, FR-41, ACC-11-23)', () => {
		it('renders menu items as plain anchors that open in the same tab, with no referrer', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);

			const cal = queryAll<HTMLAnchorElement>(element, 'a.tile').find(
				(anchor) => anchor.dataset.key === 'work:cal'
			);
			expect(cal).toBeTruthy();
			expect(cal?.getAttribute('role')).toBe('menuitem');
			// Same tab (owner, 2026-11-26): no `target`, no `rel` on any tile.
			expect(cal?.hasAttribute('target')).toBe(false);
			expect(cal?.hasAttribute('rel')).toBe(false);
			expect(cal?.getAttribute('referrerpolicy')).toBe('no-referrer');
			for (const anchor of queryAll<HTMLAnchorElement>(element, '.panel a')) {
				expect(anchor.hasAttribute('target'), anchor.dataset.key ?? anchor.className).toBe(false);
			}
			expect(cal?.getAttribute('href')).toBe('https://cal.example.com');
		});

		it('shows chips as text, never as colour alone (FR-41)', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);

			const chipOf = (key: string) =>
				Array.from(shadow(element).querySelectorAll<HTMLElement>('.tile'))
					.find((tile) => tile.dataset.key === key)
					?.querySelector('.chip')
					?.textContent?.trim();

			expect(chipOf('platform:ever-teams')).toBe('Beta');
			expect(chipOf('platform:ever-works')).toBe("You're here");
			expect(chipOf('work:umami')).toBe('Deploying');
			expect(chipOf('work:docs')).toBe('Last deploy failed');
			expect(chipOf('work:cal')).toBeUndefined();
		});

		it('renders the Work host under the name', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			const cal = queryAll<HTMLElement>(element, '.tile').find((tile) => tile.dataset.key === 'work:cal');
			expect(cal?.textContent).toContain('cal.example.com');
		});

		it('renders You\u2019re here as a non-link (FR-13, ACC-11-06)', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);

			const current = queryAll<HTMLElement>(element, '.tile').find(
				(tile) => tile.dataset.key === 'platform:ever-works'
			);
			expect(current?.tagName).not.toBe('A');
			expect(current?.hasAttribute('href')).toBe(false);
			expect(current?.getAttribute('aria-current')).toBe('page');

			// Enter closes the panel instead of opening a tab (spec §6.6).
			const closed = once(element, 'ever-app-launcher:close');
			current?.click();
			await closed;
			expect(openSpy).not.toHaveBeenCalled();
		});

		it('never opens an address FR-32 refuses (ACC-11-08, belt and braces)', async () => {
			const unsafe = item({
				key: 'work:unsafe',
				kind: 'work',
				section: 'works',
				name: 'Unsafe',
				url: 'javascript:alert(1)',
				host: 'evil.example.com'
			});
			const element = await mount({ data: response([unsafe]) });
			await open(element);

			const tile = queryAll<HTMLElement>(element, '.tile').find(
				(candidate) => candidate.dataset.key === 'work:unsafe'
			);
			expect(tile?.tagName).not.toBe('A');
			expect(tile?.getAttribute('aria-disabled')).toBe('true');
			tile?.click();
			expect(openSpy).not.toHaveBeenCalled();
		});

		it('renders a soon platform with a Soon chip, as an inert tile that is never activated (FR-9)', async () => {
			const demand = item({
				key: 'platform:ever-demand',
				name: 'Ever Demand',
				status: 'soon',
				url: 'https://demand.example.com',
				host: 'demand.example.com',
				order: 3
			});
			const element = await mount({ data: response([EVER_WORKS, GAUZY, TEAMS, demand, CAL]) });
			await open(element);

			const tile = queryAll<HTMLElement>(element, '.tile').find(
				(candidate) => candidate.dataset.key === 'platform:ever-demand'
			);
			expect(tile, 'the soon platform is listed').toBeTruthy();
			expect(tile?.tagName).not.toBe('A');
			expect(tile?.hasAttribute('href')).toBe(false);
			expect(tile?.getAttribute('aria-disabled')).toBe('true');
			expect(tile?.getAttribute('tabindex')).toBe('-1');
			const chip = tile?.querySelector<HTMLElement>('.chip');
			expect(chip?.textContent?.trim()).toBe('Soon');
			expect(chip?.dataset.chip).toBe('soon');
			// The chip replaces the host line, as every other chip does.
			expect(tile?.textContent).not.toContain('demand.example.com');

			// Neither a click nor Enter activates it: no event, no tab.
			const activations: Event[] = [];
			element.addEventListener('ever-app-launcher:item-activate', (event) => activations.push(event));
			tile?.click();
			if (tile) keydown(tile, 'Enter');
			expect(activations).toHaveLength(0);
			expect(openSpy).not.toHaveBeenCalled();
		});

		it('takes the Soon chip from the host strings like every other chip (FR-42)', async () => {
			const demand = item({ key: 'platform:ever-demand', name: 'Ever Demand', status: 'soon' });
			const element = await mount({ data: response([EVER_WORKS, demand]), strings: { chipSoon: 'Bientôt' } });
			await open(element);

			const chip = queryAll<HTMLElement>(element, '.tile')
				.find((candidate) => candidate.dataset.key === 'platform:ever-demand')
				?.querySelector('.chip');
			expect(chip?.textContent?.trim()).toBe('Bientôt');
		});

		it('hides items the registry marked not visible', async () => {
			const hidden = item({ key: 'work:hidden', kind: 'work', section: 'works', visible: false });
			const element = await mount({ data: response([EVER_WORKS, CAL, hidden]) });
			await open(element);
			expect(queryAll<HTMLElement>(element, '.tile').map((tile) => tile.dataset.key)).toEqual([
				'platform:ever-works',
				'work:cal'
			]);
		});
	});

	describe('activation (FR-30, ACC-11-23, ACC-11-40)', () => {
		it('lets the anchor open the stored address exactly, in the same tab (owner, 2026-11-26)', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);

			const cal = queryAll<HTMLElement>(element, '.tile').find((tile) => tile.dataset.key === 'work:cal');
			cal?.click();

			// The element did not stop the link's own navigation, and opened no window.
			expect(lastClick).toEqual({ defaultPrevented: false, href: 'https://cal.example.com' });
			expect(openSpy).not.toHaveBeenCalled();
		});

		it('dispatches a cancellable item-activate carrying key, kind, url, position and pinned', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);

			const seen = once<CustomEvent>(element, 'ever-app-launcher:item-activate');
			const umami = queryAll<HTMLElement>(element, '.tile').find((tile) => tile.dataset.key === 'work:umami');
			umami?.click();
			const event = await seen;

			expect(event.cancelable).toBe(true);
			expect(event.bubbles).toBe(true);
			expect(event.composed).toBe(true);
			expect(event.detail).toEqual({
				key: 'work:umami',
				kind: 'work',
				url: 'https://stats.example.com',
				position: 4,
				pinned: false
			});
		});

		it('reports a pinned item as pinned even when it is not in the pinned row', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			const seen = once<CustomEvent>(element, 'ever-app-launcher:item-activate');
			queryAll<HTMLElement>(element, '.tile')[0].click();
			const event = await seen;
			expect(event.detail.pinned).toBe(true);
			expect(event.detail.position).toBe(0);
		});

		it('opens nothing when the host cancels item-activate (ACC-11-40)', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			element.addEventListener('ever-app-launcher:item-activate', (event) => event.preventDefault());

			const cal = queryAll<HTMLElement>(element, '.tile').find((tile) => tile.dataset.key === 'work:cal');
			cal?.click();

			expect(lastClick?.defaultPrevented, 'the link navigation is stopped').toBe(true);
			expect(openSpy).not.toHaveBeenCalled();
			// The panel stays open: a cancelled activation is not a close.
			expect(query<HTMLElement>(element, '.panel')?.hasAttribute('hidden')).toBe(false);
		});
	});

	describe('Ever apps rows (in-app switcher brief S3, S4)', () => {
		it('draws each Ever app as a row: logo tile, name and one line, never the host', async () => {
			const platform = item({
				key: 'platform:app-ever-co',
				name: 'Ever Platform',
				description: 'One account for every Ever app',
				url: 'https://app.ever.co',
				host: 'app.ever.co'
			});
			const element = await mount({ data: response([EVER_WORKS, platform, CAL]) });
			await open(element);

			const row = tiles(element).find((tile) => tile.dataset.key === 'platform:app-ever-co');
			expect(row?.classList.contains('row')).toBe(true);
			expect(row?.querySelector('.tile-icon')).not.toBeNull();
			expect(row?.querySelector('.tile-name')?.textContent?.trim()).toBe('Ever Platform');
			expect(row?.querySelector('.tile-line')?.textContent?.trim()).toBe('One account for every Ever app');
			expect(row?.textContent).not.toContain('app.ever.co');
			// A Work keeps its grid tile and its host.
			const cal = tiles(element).find((tile) => tile.dataset.key === 'work:cal');
			expect(cal?.classList.contains('row')).toBe(false);
			expect(cal?.querySelector('.tile-line')?.textContent?.trim()).toBe('cal.example.com');
		});

		it('keeps the chip next to the name and the line under it', async () => {
			const teams = item({ ...TEAMS, description: 'Work and project management' });
			const element = await mount({ data: response([EVER_WORKS, teams]) });
			await open(element);
			const row = tiles(element).find((tile) => tile.dataset.key === 'platform:ever-teams');
			expect(row?.querySelector('.tile-title .chip')?.textContent?.trim()).toBe('Beta');
			expect(row?.querySelector('.tile-line')?.textContent?.trim()).toBe('Work and project management');
			expect(row?.textContent).not.toContain('example.com');
		});

		it('shows no host for an Ever app that has no line', async () => {
			const element = await mount({ data: response([EVER_WORKS, GAUZY]) });
			await open(element);
			const row = tiles(element).find((tile) => tile.dataset.key === 'platform:ever-gauzy');
			expect(row?.querySelector('.tile-line')).toBeNull();
			expect(row?.textContent).not.toContain('example.com');
		});

		it('styles the logo tile white in both themes, with a hairline ring', () => {
			expect(EVER_APP_LAUNCHER_STYLES).toContain('--ever-app-launcher-row-height: 48px');
			expect(EVER_APP_LAUNCHER_STYLES).toMatch(
				/\.row \.tile-icon,\s*\.add-app \.tile-icon \{[^}]*background: #ffffff;[^}]*box-shadow: inset 0 0 0 1px/
			);
		});
	});

	describe('+ Add (in-app switcher brief S7)', () => {
		const ADD_URL = 'https://app-dev.ever.co/apps?add=app';

		it('renders no row without an address', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			expect(query<HTMLElement>(element, '.add-app')).toBeNull();
		});

		it('renders no row for an address FR-32 refuses', async () => {
			const element = await mount({ data: FULL_PANEL, addAppUrl: 'javascript:alert(1)' });
			await open(element);
			expect(query<HTMLElement>(element, '.add-app')).toBeNull();
		});

		it('is the last row of Ever apps: a same-tab link with its label and accessible name', async () => {
			const element = await mount({ data: FULL_PANEL, addAppUrl: ADD_URL });
			await open(element);

			const add = query<HTMLAnchorElement>(element, '.add-app');
			expect(add).not.toBeNull();
			expect(add?.getAttribute('href')).toBe(ADD_URL);
			expect(add?.hasAttribute('target')).toBe(false);
			expect(add?.hasAttribute('rel')).toBe(false);
			expect(add?.getAttribute('role')).toBe('menuitem');
			expect(add?.textContent?.trim()).toBe('Add');
			expect(add?.getAttribute('aria-label')).toBe('Add your own apps in Ever Platform');
			expect(add?.getAttribute('title')).toBe('Add your own apps in Ever Platform');

			// Inside Ever apps, after its last row and before Your apps.
			expect(add?.closest('.section')?.getAttribute('data-section')).toBe('platforms');
			const rows = tiles(element).filter((tile) => tile.dataset.section === 'platforms');
			const lastRow = rows.at(-1) as HTMLElement;
			expect(lastRow.compareDocumentPosition(add as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			const works = query<HTMLElement>(element, '.section[data-section="works"]') as HTMLElement;
			expect((add as Node).compareDocumentPosition(works) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

			add?.click();
			expect(lastClick).toEqual({ defaultPrevented: false, href: ADD_URL });
			expect(openSpy).not.toHaveBeenCalled();
		});

		it('takes its label and name from the host strings (FR-42)', async () => {
			const element = await mount({
				data: FULL_PANEL,
				addAppUrl: ADD_URL,
				strings: { addApp: 'Ajouter', addAppLabel: 'Ajoutez vos propres apps dans Ever Platform' }
			});
			await open(element);
			const add = query<HTMLElement>(element, '.add-app');
			expect(add?.textContent?.trim()).toBe('Ajouter');
			expect(add?.getAttribute('aria-label')).toBe('Ajoutez vos propres apps dans Ever Platform');
		});

		it('is a Tab stop between the grid and Manage apps, and the arrows skip it', async () => {
			const element = await mount({ data: FULL_PANEL, addAppUrl: ADD_URL });
			await open(element);
			const panel = query<HTMLElement>(element, '.panel') as EventTarget;

			keydown(panel, 'Tab');
			expect(focused(element)).toBe(query<HTMLElement>(element, '.add-app'));

			keydown(panel, 'Shift', false);
			keydown(panel, 'Home');
			keydown(panel, 'End');
			expect(focused(element)).toBe(tiles(element).at(-1));
		});
	});

	describe('keyboard and focus (FR-39, FR-40, ACC-11-29)', () => {
		it('keeps exactly one tile in the tab order (roving tabindex)', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			const all = tiles(element);
			expect(all.filter((tile) => tile.tabIndex === 0)).toHaveLength(1);
			expect(all[0].tabIndex).toBe(0);
			expect(all.slice(1).every((tile) => tile.tabIndex === -1)).toBe(true);
		});

		it('moves focus and the roving tabindex with the arrow keys', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			const panel = query<HTMLElement>(element, '.panel') as EventTarget;

			keydown(panel, 'ArrowRight');
			expect(focused(element)).toBe(tiles(element)[1]);
			expect(tiles(element)[1].tabIndex).toBe(0);
			expect(tiles(element)[0].tabIndex).toBe(-1);

			keydown(panel, 'End');
			expect(focused(element)).toBe(tiles(element)[5]);

			keydown(panel, 'Home');
			expect(focused(element)).toBe(tiles(element)[0]);
		});

		it('jumps to the next tile by letter', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			keydown(query<HTMLElement>(element, '.panel') as EventTarget, 'u');
			expect(focused(element)).toBe(tiles(element)[4]);
		});

		it('traps Tab between the grid and Manage apps', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			const panel = query<HTMLElement>(element, '.panel') as EventTarget;
			const manage = query<HTMLElement>(element, '.manage') as HTMLElement;

			manage.focus();
			keydown(panel, 'Tab');
			expect(focused(element)).toBe(tiles(element)[0]);

			keydown(panel, 'Tab', true);
			expect(focused(element)).toBe(manage);
		});

		it('keeps the tab stop on an enabled tile while the arrow keys rest on a Soon tile (FR-9, FR-40)', async () => {
			const demand = item({ key: 'platform:ever-demand', name: 'Ever Demand', status: 'soon', order: 3 });
			const element = await mount({ data: response([EVER_WORKS, GAUZY, demand, CAL]) });
			await open(element);
			const panel = query<HTMLElement>(element, '.panel') as EventTarget;
			const manage = query<HTMLElement>(element, '.manage') as HTMLElement;
			const tileFor = (key: string) =>
				tiles(element).find((candidate) => candidate.dataset.key === key) as HTMLElement;

			keydown(panel, 'ArrowRight');
			keydown(panel, 'ArrowRight');
			await element.updateComplete;
			expect(focused(element)).toBe(tileFor('platform:ever-demand'));
			expect(tileFor('platform:ever-demand').tabIndex).toBe(-1);
			// The grid keeps exactly one tab stop, on the last enabled tile.
			expect(tiles(element).filter((tile) => tile.tabIndex === 0)).toEqual([tileFor('platform:ever-gauzy')]);

			// Tab leaves the grid for Manage apps, and Shift+Tab comes back to it.
			keydown(panel, 'Tab');
			expect(focused(element)).toBe(manage);
			keydown(panel, 'Tab', true);
			expect(focused(element)).toBe(tileFor('platform:ever-gauzy'));
		});

		it('never puts the tab stop on a Soon tile, even when it is the first tile', async () => {
			const demand = item({ key: 'platform:ever-demand', name: 'Ever Demand', status: 'soon', order: 0 });
			const element = await mount({ data: response([demand, GAUZY, CAL]) });
			await open(element);
			const stops = tiles(element).filter((tile) => tile.tabIndex === 0);
			expect(stops).toHaveLength(1);
			expect(stops[0].dataset.key).toBe('platform:ever-gauzy');
		});

		it('Esc closes the panel and returns focus to the control', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			const closed = once(element, 'ever-app-launcher:close');
			keydown(query<HTMLElement>(element, '.panel') as EventTarget, 'Escape');
			await closed;
			await element.updateComplete;

			expect(query<HTMLElement>(element, '.panel')?.hasAttribute('hidden')).toBe(true);
			expect(focused(element)).toBe(query<HTMLElement>(element, '.trigger'));
		});

		it('closes when a click lands outside the element', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			const closed = once(element, 'ever-app-launcher:close');
			document.body.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
			await closed;
			expect(query<HTMLElement>(element, '.panel')?.hasAttribute('hidden')).toBe(true);
		});
	});

	describe('errors (spec §6.2)', () => {
		it('keeps Ever apps when Your apps failed, with a retry that says which half failed', async () => {
			const element = await mount({ data: response([EVER_WORKS]), error: 'apps' });
			await open(element);

			expect(query<HTMLElement>(element, '.error[data-section="works"]')?.textContent?.trim()).toBe(
				"Your apps couldn't be loaded."
			);
			const retry = query<HTMLElement>(element, '.retry[data-section="works"]') as HTMLElement;
			expect(retry.textContent?.trim()).toBe('Try again');

			const seen = once<CustomEvent>(element, 'ever-app-launcher:retry');
			retry.click();
			const event = await seen;
			expect(event.detail).toEqual({ section: 'works' });
			expect(query<HTMLElement>(element, '.tile[data-key="platform:ever-works"]')).not.toBeNull();
		});

		it('renders the current platform plus the catalog error and a retry', async () => {
			const element = await mount({ data: response([EVER_WORKS]), error: 'catalog' });
			await open(element);

			expect(query<HTMLElement>(element, '.error[data-section="platforms"]')?.textContent?.trim()).toBe(
				"Ever apps couldn't be loaded."
			);
			// The message belongs to the panel's **Ever apps** section; the retry
			// reports the half that failed, which is `catalog`.
			const retry = query<HTMLElement>(element, '.retry[data-section="catalog"]') as HTMLElement;
			expect(retry).not.toBeNull();
			const seen = once<CustomEvent>(element, 'ever-app-launcher:retry');
			retry.click();
			expect((await seen).detail).toEqual({ section: 'catalog' });
		});
	});

	describe('empty states (FR-64, ACC-11-48)', () => {
		const noWorks = response([EVER_WORKS]);

		it('offers Create an App Work when App Works are available, and reports the choice', async () => {
			const element = await mount({ data: { ...noWorks, meta: { ...noWorks.meta, appWorksAvailable: true } } });
			await open(element);

			const button = query<HTMLElement>(element, '.empty-action') as HTMLElement;
			expect(button.textContent?.trim()).toBe('Create an App Work');
			expect(button.dataset.action).toBe('createAppWork');
			expect(shadow(element).textContent).toContain('Apps you deploy show up here.');

			const seen = once<CustomEvent>(element, 'ever-app-launcher:empty-action');
			const before = document.location.href;
			button.click();
			const event = await seen;

			expect(event.detail).toEqual({ action: 'createAppWork' });
			expect(event.bubbles).toBe(true);
			expect(event.composed).toBe(true);
			expect(openSpy).not.toHaveBeenCalled();
			expect(document.location.href).toBe(before);
		});

		it('offers Go to Works without App Works', async () => {
			const element = await mount({ data: { ...noWorks, meta: { ...noWorks.meta, appWorksAvailable: false } } });
			await open(element);

			const button = query<HTMLElement>(element, '.empty-action') as HTMLElement;
			expect(button.textContent?.trim()).toBe('Go to Works');
			expect(button.dataset.action).toBe('goToWorks');

			const seen = once<CustomEvent>(element, 'ever-app-launcher:empty-action');
			button.click();
			const event = await seen;

			expect(event.detail).toEqual({ action: 'goToWorks' });
			expect(openSpy).not.toHaveBeenCalled();
		});

		it('takes appWorksAvailable from meta when the host does not set the property', async () => {
			const element = await mount({ data: { ...noWorks, meta: { ...noWorks.meta, appWorksAvailable: false } } });
			await open(element);
			expect(query<HTMLElement>(element, '.empty-action')?.dataset.action).toBe('goToWorks');
		});

		it('lets the host property override meta in both directions', async () => {
			const element = await mount({
				data: { ...noWorks, meta: { ...noWorks.meta, appWorksAvailable: true } },
				appWorksAvailable: false
			});
			await open(element);
			expect(query<HTMLElement>(element, '.empty-action')?.dataset.action).toBe('goToWorks');

			element.appWorksAvailable = true;
			await element.updateComplete;
			expect(query<HTMLElement>(element, '.empty-action')?.dataset.action).toBe('createAppWork');
		});

		it('shows no empty state when Your apps has tiles', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			expect(query<HTMLElement>(element, '.empty-action')).toBeNull();
		});
	});

	/**
	 * FR-4's overflow row and ACC-11-14: with 140 exposed live Works the panel
	 * renders its 24 tiles **and** `View all 140`. The cap itself is the
	 * registry's (`orderLauncherItems`, APW-11 T4) — the element renders what it
	 * was handed and reads the real total from `meta.worksTotal`, which is the
	 * only number that can be right: counting what arrived would say "View all
	 * 24" and lead to a page showing the same 24.
	 */
	describe('the overflow row (FR-4, ACC-11-14)', () => {
		const works = (count: number): AppLauncherItem[] =>
			Array.from({ length: count }, (_value, index) =>
				item({
					key: `work:w${index}`,
					kind: 'work',
					section: 'works',
					name: `Work ${index}`,
					url: `https://work-${index}.example.com`,
					order: index
				})
			);

		it('renders View all {count} from meta.worksTotal, not from the tiles it received', async () => {
			const element = await mount({
				data: response(works(24), { worksTotal: 140 })
			});
			await open(element);

			const row = query<HTMLElement>(element, '.view-all');
			expect(row).not.toBeNull();
			expect(row?.textContent?.trim()).toBe('View all 140');
			expect(tiles(element)).toHaveLength(24);
		});

		it('reports the overflow through the SAME manage event, and never navigates', async () => {
			const element = await mount({ data: response(works(2), { worksTotal: 140 }) });
			await open(element);
			const before = document.location.href;
			const seen = once<CustomEvent>(element, 'ever-app-launcher:manage');

			(query<HTMLElement>(element, '.view-all') as HTMLElement).click();
			const event = await seen;

			// `section: 'works'` — the list the person asked to see more of.
			expect(event.detail).toEqual({ section: 'works' });
			expect(document.location.href).toBe(before);
		});

		it('renders no row when the scope holds nothing more than the panel shows', async () => {
			const element = await mount({ data: response(works(3), { worksTotal: 3 }) });
			await open(element);
			expect(query<HTMLElement>(element, '.view-all')).toBeNull();

			// …and none while the apps half failed, where the row would sit under an
			// error it cannot explain.
			const failed = await mount({ data: response(works(2), { worksTotal: 140 }), error: 'apps' });
			await open(failed);
			expect(query<HTMLElement>(failed, '.view-all')).toBeNull();
		});
	});

	describe('manage and sign-in events (plan §6.2)', () => {
		it('reports Manage apps without navigating itself', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);
			const before = document.location.href;
			const seen = once<CustomEvent>(element, 'ever-app-launcher:manage');
			(query<HTMLElement>(element, '.manage') as HTMLElement).click();
			const event = await seen;
			expect(event.detail).toEqual({});
			expect(document.location.href).toBe(before);
		});

		it('shows the S6 sign-in control only when the host offers one', async () => {
			const signedOut = await mount({ data: response([EVER_WORKS]), signInAvailable: false });
			await open(signedOut);
			expect(query<HTMLElement>(signedOut, '.sign-in')).toBeNull();

			const signedIn = await mount({ data: response([EVER_WORKS]), signInAvailable: true });
			await open(signedIn);
			const button = query<HTMLElement>(signedIn, '.sign-in') as HTMLElement;
			expect(button.textContent?.trim()).toBe('Sign in');
			const seen = once<CustomEvent>(signedIn, 'ever-app-launcher:sign-in');
			button.click();
			expect((await seen).detail).toEqual({});
		});
	});

	describe('host theming and strings (FR-42, FR-46)', () => {
		it('adds no style to the host document', async () => {
			const element = await mount({ data: FULL_PANEL });
			await open(element);

			expect(document.head.querySelectorAll('style')).toHaveLength(0);
			expect(document.body.querySelectorAll('style')).toHaveLength(0);

			const root = shadow(element);
			const adopted = (root as ShadowRoot & { adoptedStyleSheets?: unknown[] }).adoptedStyleSheets ?? [];
			expect(root.querySelectorAll('style').length + adopted.length).toBeGreaterThan(0);
		});

		it('documents its custom properties and the bottom sheet in the shadow styles', () => {
			for (const property of [
				'--ever-app-launcher-bg',
				'--ever-app-launcher-fg',
				'--ever-app-launcher-muted',
				'--ever-app-launcher-accent',
				'--ever-app-launcher-radius',
				'--ever-app-launcher-font'
			]) {
				expect(EVER_APP_LAUNCHER_STYLES).toContain(property);
			}
			// FR-3: a bottom sheet under a 640 px host viewport.
			expect(EVER_APP_LAUNCHER_STYLES).toContain('@media (max-width: 639.98px)');
			expect(EVER_APP_LAUNCHER_STYLES).toContain('position: fixed');
			expect(EVER_APP_LAUNCHER_STYLES).not.toContain(':root');
		});

		it('takes translated strings from the host, one string per element', async () => {
			const element = await mount({
				data: FULL_PANEL,
				strings: { manageLink: 'Apps verwalten', panelTitle: 'App-Starter' }
			});
			await open(element);
			expect(query<HTMLElement>(element, '.manage')?.textContent?.trim()).toBe('Apps verwalten');
			expect(query<HTMLElement>(element, '.panel-title')?.textContent?.trim()).toBe('App-Starter');
			// Everything the host did not override keeps the English default.
			expect(shadow(element).textContent).toContain('Pinned');
		});

		it('reflects the theme the host sets as a property, so the themed rules apply', async () => {
			// The `:host([theme=…])` rules read the ATTRIBUTE; hosts set the property
			// (plan §6.2). Without reflection the panel never left its light palette.
			const element = await mount({ theme: 'dark' });
			expect(element.getAttribute('theme')).toBe('dark');
			element.theme = 'light';
			await element.updateComplete;
			expect(element.getAttribute('theme')).toBe('light');
			expect(EVER_APP_LAUNCHER_STYLES).toContain(":host([theme='dark'])");
		});

		it('opens the panel on the side the host asks for, from 640 px up only', async () => {
			const element = await mount();
			expect(element.getAttribute('panel-position')).toBe('bottom-end');
			element.panelPosition = 'bottom-start';
			await element.updateComplete;
			expect(element.getAttribute('panel-position')).toBe('bottom-start');
			for (const position of ['bottom-start', 'right-start', 'right-end']) {
				expect(EVER_APP_LAUNCHER_STYLES).toContain(`:host([panel-position='${position}']) .panel`);
			}
			expect(EVER_APP_LAUNCHER_STYLES).toContain('@media (min-width: 640px)');
			// Logical sides: in a right-to-left page the sidebar and the rail are on the right.
			expect(EVER_APP_LAUNCHER_STYLES).toContain('inset-inline-start: calc(100% + 8px)');
			expect(EVER_APP_LAUNCHER_STYLES).not.toMatch(/left: calc\(100% \+ 8px\)/);
		});

		it('gives each section heading a whole row of the tile grid', () => {
			// Sections are `display: contents`; without this the heading takes a
			// tile's cell and pushes the tiles out of line.
			expect(EVER_APP_LAUNCHER_STYLES).toMatch(/\.section-heading,[^{]*\{\s*grid-column: 1 \/ -1;/);
		});

		it('lets the host put its own mark in the trigger, keeping the grid as the fallback', async () => {
			const element = await mount();
			const slot = query<HTMLSlotElement>(element, '.trigger slot[name="trigger-icon"]');
			expect(slot).not.toBeNull();
			// The fallback content is the 2×2 grid.
			expect(slot?.querySelectorAll('rect').length).toBe(4);
			const mark = document.createElement('span');
			mark.slot = 'trigger-icon';
			element.appendChild(mark);
			expect(slot?.assignedElements()).toEqual([mark]);
		});

		it('renders nothing but the control before it is opened', async () => {
			const element = await mount({ data: FULL_PANEL });
			expect(query<HTMLElement>(element, '.trigger')).not.toBeNull();
			expect(query<HTMLElement>(element, '.panel')?.hasAttribute('hidden')).toBe(true);
		});
	});
});
