/**
 * Render budgets measured on the PARSED tree (PR #3137, second closure check).
 *
 * A text pre-check cannot know what the parser builds: a GFM table goes on
 * over lines without pipes, inside a quote or a list item, and stops only
 * where the parser says so (a "```x`" line is not a fence, "#x" is not a
 * heading). Guessing that from the text let a 3.6 KB description through
 * that took 10.2 s to render (85,100 padded cells).
 *
 * So the renderer parses once, and before the tree is turned into HTML — the
 * step where table rows are padded to the header's width, with a per-row
 * sibling search — the remark plugin {@link remarkRenderBudget} walks the
 * tree and counts exactly what will be built: every table's rows × its column
 * count (what the HTML step pads to), node counts by kind, depth, links and
 * images. Over a budget it throws {@link MarkdownBudgetError}; the renderer
 * catches that and shows the escaped plain text instead. The text pre-check
 * in `markdown-limits` stays only for what is expensive or unsafe to PARSE.
 *
 * Pure (no React); the walk is iterative, so no tree is deep enough to
 * overflow the stack here.
 */

/** The parts of an mdast node the walk reads. */
export interface MarkdownTreeNode {
    type: string;
    children?: MarkdownTreeNode[];
    /** `table` only: one entry per column of the delimiter row. */
    align?: ReadonlyArray<unknown> | null;
    position?: { end?: { offset?: number; line?: number } } | null;
}

export interface MarkdownTreeCounts {
    /** Every node, the root included. */
    nodes: number;
    /** Deepest node (the root is depth 0). */
    depth: number;
    /** Block nodes: paragraphs, headings, rules, quotes, lists, items, code, tables, … */
    blocks: number;
    listItems: number;
    tables: number;
    /** Rows of the longest table: the HTML step does a sibling search per row. */
    tableRows: number;
    /** Σ over tables of rows × columns: the cells the HTML step builds, padding included. */
    tableCells: number;
    /** Links, link references and footnote references. */
    links: number;
    /** Images and image references. */
    images: number;
    /** Estimated render cost (jsdom client render), from {@link NODE_COST_MS}. */
    estimatedMs: number;
}

export type MarkdownTreeBudgets = Omit<MarkdownTreeCounts, 'estimatedMs'> & {
    estimatedMs: number;
};

const BLOCK_TYPES = new Set([
    'paragraph',
    'heading',
    'thematicBreak',
    'blockquote',
    'list',
    'listItem',
    'code',
    'html',
    'definition',
    'footnoteDefinition',
    'table',
]);

/**
 * Measured cost of building and rendering one node of a kind, in milliseconds
 * (jsdom client render on the development machine). Table cells are priced
 * per PADDED cell. Kinds not listed cost {@link DEFAULT_NODE_COST_MS}.
 */
export const NODE_COST_MS: Readonly<Record<string, number>> = {
    paragraph: 0.25,
    heading: 0.4,
    thematicBreak: 0.12,
    blockquote: 0.12,
    list: 0.1,
    listItem: 0.35,
    code: 0.2,
    html: 0.01,
    definition: 0.02,
    footnoteDefinition: 0.3,
    table: 0.3,
    tableRow: 0.4,
    tableCell: 0.15,
    text: 0.015,
    emphasis: 0.06,
    strong: 0.06,
    delete: 0.06,
    inlineCode: 0.06,
    break: 0.15,
    link: 0.3,
    linkReference: 0.3,
    footnoteReference: 0.3,
    image: 0.4,
    imageReference: 0.4,
};
export const DEFAULT_NODE_COST_MS = 0.05;
/** Per character of the source (text content, attributes). */
export const CHARACTER_COST_MS = 0.0025;
/** Per source line: the tokenizer's per-line work (setext headings, line breaks, deep prefixes). */
export const LINE_COST_MS = 0.08;

/** Budgets for descriptions. */
export const BLOCK_TREE_BUDGETS: MarkdownTreeBudgets = {
    nodes: 6_000,
    depth: 100,
    blocks: 600,
    listItems: 500,
    tables: 200,
    tableRows: 300,
    tableCells: 1_000,
    links: 400,
    images: 100,
    estimatedMs: 250,
};

/** Budgets for one inline field (a DoD criterion); a Goal shows up to 50. */
export const INLINE_TREE_BUDGETS: MarkdownTreeBudgets = {
    nodes: 300,
    depth: 60,
    blocks: 10,
    listItems: 0,
    tables: 0,
    tableRows: 0,
    tableCells: 0,
    links: 12,
    images: 10,
    estimatedMs: 8,
};

/** Count what the HTML step will build from this tree. Linear, iterative. */
export function measureMarkdownTree(root: MarkdownTreeNode): MarkdownTreeCounts {
    const counts: MarkdownTreeCounts = {
        nodes: 0,
        depth: 0,
        blocks: 0,
        listItems: 0,
        tables: 0,
        tableRows: 0,
        tableCells: 0,
        links: 0,
        images: 0,
        estimatedMs:
            (root.position?.end?.offset ?? 0) * CHARACTER_COST_MS +
            (root.position?.end?.line ?? 0) * LINE_COST_MS,
    };
    const stack: Array<[MarkdownTreeNode, number]> = [[root, 0]];
    while (stack.length > 0) {
        const [node, depth] = stack.pop() as [MarkdownTreeNode, number];
        counts.nodes++;
        if (depth > counts.depth) counts.depth = depth;
        const { type } = node;
        if (type !== 'tableRow' && type !== 'tableCell') {
            counts.estimatedMs += NODE_COST_MS[type] ?? DEFAULT_NODE_COST_MS;
        }
        if (BLOCK_TYPES.has(type)) counts.blocks++;
        if (type === 'listItem') counts.listItems++;
        else if (type === 'link' || type === 'linkReference' || type === 'footnoteReference') {
            counts.links++;
        } else if (type === 'image' || type === 'imageReference') counts.images++;
        else if (type === 'table') {
            const rows = node.children ?? [];
            // The HTML step pads (or cuts) every row to the delimiter row's
            // width; count the larger of that and the widest row.
            let columns = node.align?.length ?? 0;
            for (const row of rows) columns = Math.max(columns, row.children?.length ?? 0);
            counts.tables++;
            counts.tableRows = Math.max(counts.tableRows, rows.length);
            counts.tableCells += rows.length * columns;
            counts.estimatedMs +=
                rows.length * (NODE_COST_MS.tableRow ?? 0) +
                rows.length * columns * (NODE_COST_MS.tableCell ?? 0);
        }
        const children = node.children;
        if (children) {
            for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], depth + 1]);
        }
    }
    return counts;
}

export type MarkdownTreeLimitReason = keyof MarkdownTreeBudgets;

/** The first budget the counts break, or null. */
export function treeBudgetReason(
    counts: MarkdownTreeCounts,
    budgets: MarkdownTreeBudgets,
): MarkdownTreeLimitReason | null {
    for (const key of Object.keys(budgets) as MarkdownTreeLimitReason[]) {
        if (counts[key] > budgets[key]) return key;
    }
    return null;
}

/** Thrown by {@link remarkRenderBudget}; the renderer shows plain text instead. */
export class MarkdownBudgetError extends Error {
    constructor(
        readonly reason: MarkdownTreeLimitReason,
        readonly counts: MarkdownTreeCounts,
    ) {
        super(`Markdown over its render budget: ${reason}`);
        this.name = 'MarkdownBudgetError';
    }
}

/**
 * remark plugin: walk the parsed tree and stop — before it is turned into
 * HTML — when it is over a budget.
 */
export function remarkRenderBudget(budgets: MarkdownTreeBudgets) {
    return (tree: MarkdownTreeNode) => {
        const counts = measureMarkdownTree(tree);
        const reason = treeBudgetReason(counts, budgets);
        if (reason) throw new MarkdownBudgetError(reason, counts);
    };
}

/** Thrown by {@link remarkMeasureOnly}: carries the counts out of a parse. */
export class MarkdownMeasured extends Error {
    constructor(readonly counts: MarkdownTreeCounts) {
        super('Markdown measured');
        this.name = 'MarkdownMeasured';
    }
}

/** remark plugin: measure the parsed tree and stop there (parse + walk, no HTML). */
export function remarkMeasureOnly() {
    return (tree: MarkdownTreeNode) => {
        throw new MarkdownMeasured(measureMarkdownTree(tree));
    };
}
