import { describe, expect, it } from 'vitest';
import {
    BLOCK_TREE_BUDGETS,
    MarkdownBudgetError,
    MarkdownMeasured,
    measureMarkdownTree,
    remarkMeasureOnly,
    remarkRenderBudget,
    treeBudgetReason,
    type MarkdownTreeNode,
} from './markdown-tree-budget';

const text = (): MarkdownTreeNode => ({ type: 'text' });
const cell = (): MarkdownTreeNode => ({ type: 'tableCell', children: [text()] });
const row = (cells: number): MarkdownTreeNode => ({
    type: 'tableRow',
    children: Array.from({ length: cells }, cell),
});
const table = (columns: number, rowCells: number[]): MarkdownTreeNode => ({
    type: 'table',
    align: Array.from({ length: columns }, () => null),
    children: rowCells.map(row),
});
const root = (...children: MarkdownTreeNode[]): MarkdownTreeNode => ({ type: 'root', children });

describe('measureMarkdownTree', () => {
    it('counts the cells the HTML step builds: rows × the delimiter row width, padding included', () => {
        // The review's bypass: a 50-column header and pipe-less rows of one cell each.
        const counts = measureMarkdownTree(
            root(table(50, [50, ...Array.from({ length: 1700 }, () => 1)])),
        );
        expect(counts.tables).toBe(1);
        expect(counts.tableRows).toBe(1701);
        expect(counts.tableCells).toBe(1701 * 50);
        expect(treeBudgetReason(counts, BLOCK_TREE_BUDGETS)).toBe('tableRows');
    });

    it('takes the wider of the delimiter row and any row', () => {
        const counts = measureMarkdownTree(root(table(2, [2, 40, 1])));
        expect(counts.tableCells).toBe(3 * 40);
    });

    it('adds up cells across tables, wherever they sit (quotes, list items)', () => {
        const quoted: MarkdownTreeNode = {
            type: 'blockquote',
            children: [table(10, [10, 10, 10])],
        };
        const listed: MarkdownTreeNode = {
            type: 'list',
            children: [{ type: 'listItem', children: [table(10, [10, 10])] }],
        };
        const counts = measureMarkdownTree(root(quoted, listed));
        expect(counts.tables).toBe(2);
        expect(counts.tableCells).toBe(30 + 20);
        expect(counts.tableRows).toBe(3);
        expect(counts.listItems).toBe(1);
    });

    it('refuses many small tables over the document total', () => {
        const tables = Array.from({ length: 70 }, () => table(5, [5, 5, 5, 5, 5]));
        const counts = measureMarkdownTree(root(...tables));
        expect(counts.tableRows).toBe(5);
        expect(counts.tableCells).toBe(70 * 25);
        expect(treeBudgetReason(counts, BLOCK_TREE_BUDGETS)).toBe('tableCells');
    });

    it('counts depth, blocks, links and images', () => {
        const tree = root(
            { type: 'heading', children: [text()] },
            {
                type: 'paragraph',
                children: [
                    { type: 'link', children: [{ type: 'emphasis', children: [text()] }] },
                    { type: 'image' },
                    { type: 'imageReference' },
                    { type: 'linkReference', children: [text()] },
                ],
            },
        );
        const counts = measureMarkdownTree(tree);
        expect(counts.blocks).toBe(2);
        expect(counts.links).toBe(2);
        expect(counts.images).toBe(2);
        expect(counts.depth).toBe(4); // root > paragraph > link > emphasis > text
    });

    it('walks a tree 100,000 levels deep without overflowing the stack', () => {
        let node: MarkdownTreeNode = text();
        for (let i = 0; i < 100_000; i++) node = { type: 'emphasis', children: [node] };
        const counts = measureMarkdownTree(root(node));
        expect(counts.depth).toBe(100_001);
        expect(counts.depth).toBeGreaterThan(BLOCK_TREE_BUDGETS.depth);
        expect(treeBudgetReason(counts, BLOCK_TREE_BUDGETS)).not.toBeNull();
    });
});

describe('the remark plugins', () => {
    it('remarkRenderBudget throws a MarkdownBudgetError over budget and passes under it', () => {
        const check = remarkRenderBudget(BLOCK_TREE_BUDGETS);
        expect(() => check(root({ type: 'paragraph', children: [text()] }))).not.toThrow();
        try {
            check(
                root(
                    table(
                        50,
                        Array.from({ length: 40 }, () => 1),
                    ),
                ),
            );
            throw new Error('expected a budget error');
        } catch (error) {
            expect(error).toBeInstanceOf(MarkdownBudgetError);
            expect((error as MarkdownBudgetError).reason).toBe('tableCells');
        }
    });

    it('remarkMeasureOnly always stops with the counts', () => {
        expect(() => remarkMeasureOnly()(root())).toThrow(MarkdownMeasured);
    });
});
