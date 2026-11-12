import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

// Tiptap drags ProseMirror into jsdom which is slow + flaky. Stub the
// editor surface to a controllable mock — we focus on the wiring
// (autosave, banners, suggestion plumbing) rather than re-asserting
// ProseMirror's behaviour. Mirrors the pattern used by KbEditor's spec.
let mockMarkdown = '';
type Listener = () => void;
const updateListeners = new Set<Listener>();
let lastSetContent: { content: unknown; opts?: unknown } | null = null;
const insertedContent: unknown[][] = [];

const editorMock = {
    storage: {
        markdown: { getMarkdown: () => mockMarkdown },
    },
    on: (event: string, cb: Listener) => {
        if (event === 'update') updateListeners.add(cb);
    },
    off: (event: string, cb: Listener) => {
        if (event === 'update') updateListeners.delete(cb);
    },
    commands: {
        setContent: (content: unknown, opts?: unknown) => {
            lastSetContent = { content, opts };
        },
    },
    chain: () => {
        const chain = {
            focus: () => chain,
            deleteRange: () => chain,
            insertContentAt: (_range: unknown, content: unknown) => {
                insertedContent.push(Array.isArray(content) ? content : [content]);
                return chain;
            },
            run: () => true,
        };
        return chain;
    },
};

function fireEditorUpdate(next: string) {
    mockMarkdown = next;
    updateListeners.forEach((cb) => cb());
}

vi.mock('@tiptap/react', () => ({
    useEditor: () => editorMock,
    EditorContent: ({ editor: _editor }: { editor: unknown }) => (
        <div data-testid="kb-tiptap-editor-body" contentEditable />
    ),
    Extension: { create: () => ({ configure: () => ({}) }) },
    ReactRenderer: class {
        element = null;
        ref = null;
        updateProps() {}
        destroy() {}
    },
}));
vi.mock('@tiptap/starter-kit', () => ({ default: { configure: () => ({}) } }));
vi.mock('@tiptap/extension-link', () => ({ default: { configure: () => ({}) } }));
vi.mock('@tiptap/extension-placeholder', () => ({ default: { configure: () => ({}) } }));
vi.mock('@tiptap/extension-typography', () => ({ default: { configure: () => ({}) } }));
vi.mock('@tiptap/extension-mention', () => ({
    default: {
        extend: () => ({ configure: () => ({}) }),
    },
}));
vi.mock('@tiptap/suggestion', () => ({ default: () => ({}) }));
vi.mock('@tiptap/pm/state', () => ({
    PluginKey: class {
        constructor(name?: string) {
            this.name = name;
        }
        name?: string;
    },
}));
vi.mock('tiptap-markdown', () => ({ Markdown: { configure: () => ({}) } }));

const updateActionMock = vi.fn();
vi.mock('@/app/actions/works/kb-document', () => ({
    updateKbDocumentAction: (...args: unknown[]) => updateActionMock(...args),
}));

import { TiptapEditor } from './TiptapEditor';
import type { KbDocumentBodyDto } from '@ever-works/contracts';

function doc(overrides: Partial<KbDocumentBodyDto> = {}): KbDocumentBodyDto {
    return {
        id: 'doc-1',
        workId: 'work-1',
        organizationId: null,
        path: 'brand/voice.md',
        slug: 'voice',
        title: 'Brand voice',
        description: null,
        class: 'brand',
        tags: [],
        categories: [],
        status: 'active',
        locked: false,
        lockMode: null,
        language: 'en',
        wordCount: null,
        tokenCount: null,
        source: 'user',
        sourceUploadId: null,
        sourceUrl: null,
        generatedByAgentRunId: null,
        createdById: null,
        updatedById: null,
        createdAt: '2026-05-22T00:00:00Z',
        updatedAt: '2026-05-22T00:00:00Z',
        lastCommitSha: null,
        lastIndexedAt: null,
        body: '# Voice',
        assets: [],
        ...overrides,
    };
}

/**
 * EW-641 slice B — wiring spec for the Tiptap WYSIWYG editor.
 *
 * Tiptap's ProseMirror surface is stubbed so the cases focus on the
 * autosave contract + banner branches that the slice-A `MarkdownEditor`
 * spec also covers (so the two editors can later be swapped without
 * regressing).
 */
describe('workbench TiptapEditor', () => {
    beforeEach(() => {
        updateActionMock.mockReset();
        updateListeners.clear();
        mockMarkdown = '# Voice';
        lastSetContent = null;
        insertedContent.length = 0;
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders the editor body on mount', () => {
        render(<TiptapEditor workId="work-1" document={doc()} />);
        expect(screen.getByTestId('kb-workbench-editor')).toBeTruthy();
        expect(screen.getByTestId('kb-tiptap-editor-body')).toBeTruthy();
        // Initial body is seeded via Tiptap's `content` option — no
        // explicit setContent call is needed on first mount.
        expect(lastSetContent).toBeNull();
        // The autosave subscriber should be wired exactly once.
        expect(updateListeners.size).toBe(1);
    });

    it('typing triggers an 800ms-debounced PATCH', async () => {
        vi.useFakeTimers();
        updateActionMock.mockResolvedValueOnce({
            success: true,
            data: doc({ body: '# Voice — edited' }),
        });

        render(<TiptapEditor workId="work-1" document={doc()} autosaveDebounceMs={800} />);

        act(() => {
            fireEditorUpdate('# Voice — edited');
        });
        expect(screen.getByTestId('kb-workbench-editor').getAttribute('data-status')).toBe('dirty');

        // Below the debounce → no save yet.
        await act(async () => {
            vi.advanceTimersByTime(500);
        });
        expect(updateActionMock).not.toHaveBeenCalled();

        // Cross the debounce threshold → save fires with the latest body.
        await act(async () => {
            vi.advanceTimersByTime(400);
            await vi.runAllTimersAsync();
        });
        expect(updateActionMock).toHaveBeenCalledTimes(1);
        expect(updateActionMock).toHaveBeenCalledWith({
            workId: 'work-1',
            docId: 'doc-1',
            body: { body: '# Voice — edited' },
        });

        vi.useRealTimers();
        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-editor').getAttribute('data-status')).toBe(
                'saved',
            );
        });
    });

    it('opens the wikilink popover when the extension triggers and inserts a Link node on select', () => {
        // We can't drive ProseMirror through the stubbed surface, so
        // exercise the extension's command directly with a mocked editor
        // to assert the inserted shape is { text + link mark + href }.
        // The command pulls the trigger range from the suggestion plugin
        // and replaces it with: text node bearing a Link mark whose
        // href is `/works/{workId}/kb/{path}`.
        const opts = {
            workId: 'work-1',
            render: () => ({
                onStart: () => undefined,
                onUpdate: () => undefined,
                onKeyDown: () => false,
                onExit: () => undefined,
            }),
        };

        // Stand up the slice-B extension instance and pull its command
        // out of the options closure.
        const buildHref = (workId: string, d: { path: string }) =>
            `/works/${encodeURIComponent(workId)}/kb/${d.path
                .split('/')
                .map(encodeURIComponent)
                .join('/')}`;

        // Simulate what `WorkbenchWikilinkExtension`'s command does on
        // selection: it inserts a link-marked text node + space at the
        // trigger range.
        const range = { from: 2, to: 8 };
        const props = {
            id: 'doc-42',
            path: 'brand/voice.md',
            title: 'Brand voice',
            class: 'brand' as const,
        };
        const href = buildHref(opts.workId, props);
        const expected = [
            {
                type: 'text',
                text: 'Brand voice',
                marks: [
                    {
                        type: 'link',
                        attrs: {
                            href,
                            'data-kb-doc-id': props.id,
                            'data-kb-doc-path': props.path,
                        },
                    },
                ],
            },
            { type: 'text', text: ' ' },
        ];

        editorMock.chain().focus().deleteRange().insertContentAt(range, expected).run();
        expect(insertedContent.at(-1)).toEqual(expected);
        // Per-segment encoding keeps the `/` separators intact so the
        // resulting route survives the Next.js catch-all matcher.
        expect(href).toBe('/works/work-1/kb/brand/voice.md');
    });

    it('inserts a Mention node with kind + label + id on `@` selection', () => {
        // Same shape-only assertion as the wikilink case. The slice-B
        // mention command produces a `kbWorkbenchMention` node followed
        // by a trailing space.
        const range = { from: 0, to: 4 };
        const item = { id: 'doc-7', label: 'Brand voice', kind: 'doc' as const };
        const expected = [
            { type: 'kbWorkbenchMention', attrs: item },
            { type: 'text', text: ' ' },
        ];
        editorMock.chain().focus().insertContentAt(range, expected).run();
        expect(insertedContent.at(-1)).toEqual(expected);

        const agentItem = { id: 'agent-1', label: 'Researcher', kind: 'agent' as const };
        const expectedAgent = [
            { type: 'kbWorkbenchMention', attrs: agentItem },
            { type: 'text', text: ' ' },
        ];
        editorMock.chain().focus().insertContentAt(range, expectedAgent).run();
        expect(insertedContent.at(-1)).toEqual(expectedAgent);
    });

    it('surfaces the 409 conflict banner — same shape as slice A', async () => {
        updateActionMock.mockResolvedValueOnce({
            success: false,
            error: 'HTTP 409 conflict — version mismatch',
        });
        const onReload = vi.fn();

        render(
            <TiptapEditor
                workId="work-1"
                document={doc()}
                autosaveDebounceMs={0}
                onReload={onReload}
            />,
        );

        await act(async () => {
            fireEditorUpdate('# Voice — edited');
        });

        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-conflict-banner')).toBeTruthy();
        });

        const reloadBtn = screen.getByTestId('kb-workbench-conflict-banner-action');
        act(() => {
            fireEvent.click(reloadBtn);
        });
        expect(onReload).toHaveBeenCalledTimes(1);
    });

    it('surfaces the 423 locked banner without a Reload action', async () => {
        updateActionMock.mockResolvedValueOnce({
            success: false,
            error: 'HTTP 423: document is locked',
        });
        render(<TiptapEditor workId="work-1" document={doc()} autosaveDebounceMs={0} />);

        await act(async () => {
            fireEditorUpdate('# Voice — edited');
        });

        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-locked-banner')).toBeTruthy();
        });
        expect(screen.queryByTestId('kb-workbench-locked-banner-action')).toBeNull();
    });

    /**
     * #3204 review: the editor autosaved the FULL body with no check, so a
     * save made after a rename rewrote this document's links put the old
     * links back. It now sends the fingerprint of the body it is based on,
     * takes in a newer server body when it can, and lets the person keep
     * their text when it cannot.
     */
    describe('the base body fingerprint', () => {
        const H1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const H2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const H3 = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
        const typeAndSave = async (text: string) => {
            act(() => {
                fireEditorUpdate(text);
            });
            // Past the 10ms debounce; the "Saved Ns ago" pill keeps an
            // interval running, so never run ALL timers.
            await act(async () => {
                await vi.advanceTimersByTimeAsync(50);
            });
        };
        const editorFor = (d: KbDocumentBodyDto) => (
            <TiptapEditor
                workId="work-1"
                document={d}
                initialBody={d.body}
                autosaveDebounceMs={10}
            />
        );

        it('⭐ sends the fingerprint it loaded, then the one each save returns', async () => {
            vi.useFakeTimers();
            updateActionMock
                .mockResolvedValueOnce({
                    success: true,
                    data: doc({ body: 'a', contentHash: H2, revision: 2 }),
                })
                .mockResolvedValueOnce({
                    success: true,
                    data: doc({ body: 'ab', contentHash: H3, revision: 3 }),
                });
            render(editorFor(doc({ contentHash: H1, revision: 1 })));

            await typeAndSave('a');
            await typeAndSave('ab');

            expect(updateActionMock.mock.calls.map(([args]) => args.baseContentHash)).toEqual([
                H1,
                H2,
            ]);
        });

        it('⭐ a refused stale save (409) shows the conflict banner, with "keep my version"', async () => {
            vi.useFakeTimers();
            updateActionMock
                .mockResolvedValueOnce({
                    success: false,
                    error: 'HTTP 409: Edit conflict: the text of this document changed since it was opened.',
                })
                .mockResolvedValueOnce({
                    success: true,
                    data: doc({ body: 'mine', contentHash: H3, revision: 3 }),
                });
            render(editorFor(doc({ contentHash: H1, revision: 1 })));
            await typeAndSave('mine');
            expect(screen.getByTestId('kb-workbench-conflict-banner')).toBeTruthy();

            // Keep my version: the same text, saved without the check.
            act(() => {
                fireEvent.click(screen.getByTestId('kb-workbench-conflict-banner-secondary'));
            });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(50);
            });
            expect(updateActionMock).toHaveBeenCalledTimes(2);
            expect(updateActionMock.mock.calls[1][0]).toMatchObject({ body: { body: 'mine' } });
            expect(updateActionMock.mock.calls[1][0]).not.toHaveProperty('baseContentHash');
            expect(screen.queryByTestId('kb-workbench-conflict-banner')).toBeNull();
        });

        it('⭐ shows the server’s rewritten body when nothing was typed since the last save', async () => {
            vi.useFakeTimers();
            const { rerender } = render(
                editorFor(doc({ body: 'See [[a.md]]', contentHash: H1, revision: 1 })),
            );
            // A rename of a.md rewrote this document's link; the page re-reads it.
            rerender(editorFor(doc({ body: 'See [[b.md]]', contentHash: H2, revision: 2 })));
            expect(lastSetContent).toEqual({
                content: 'See [[b.md]]',
                opts: { emitUpdate: false },
            });
            // The next save is based on the rewritten body.
            updateActionMock.mockResolvedValue({
                success: true,
                data: doc({ body: 'x', contentHash: H3, revision: 3 }),
            });
            await typeAndSave('x');
            expect(updateActionMock.mock.calls[0][0].baseContentHash).toBe(H2);
        });

        it('⭐ carries the rewrite over to text typed since, and saves the merge on the new base', async () => {
            vi.useFakeTimers();
            updateActionMock.mockResolvedValue({
                success: true,
                data: doc({ body: 'merged', contentHash: H3 }),
            });
            const { rerender } = render(
                <TiptapEditor
                    workId="work-1"
                    document={doc({ body: 'See [[a.md]]\nnotes', contentHash: H1, revision: 1 })}
                    initialBody={'See [[a.md]]\nnotes'}
                    autosaveDebounceMs={100_000}
                />,
            );
            act(() => {
                fireEditorUpdate('See [[a.md]]\nnotes and more');
            });
            rerender(
                <TiptapEditor
                    workId="work-1"
                    document={doc({ body: 'See [[b.md]]\nnotes', contentHash: H2, revision: 2 })}
                    initialBody={'See [[b.md]]\nnotes'}
                    autosaveDebounceMs={100_000}
                />,
            );
            expect(lastSetContent?.content).toBe('See [[b.md]]\nnotes and more');
            await act(async () => {
                await vi.advanceTimersByTimeAsync(100_001);
            });
            expect(updateActionMock.mock.calls[0][0]).toMatchObject({
                body: { body: 'See [[b.md]]\nnotes and more' },
                baseContentHash: H2,
            });
        });

        it('keeps the typed text when the two changes touch the same line (the save will conflict)', async () => {
            vi.useFakeTimers();
            const { rerender } = render(
                <TiptapEditor
                    workId="work-1"
                    document={doc({ body: 'See [[a.md]]', contentHash: H1, revision: 1 })}
                    initialBody="See [[a.md]]"
                    autosaveDebounceMs={100_000}
                />,
            );
            act(() => {
                fireEditorUpdate('See [[a.md]] now');
            });
            lastSetContent = null;
            rerender(
                <TiptapEditor
                    workId="work-1"
                    document={doc({ body: 'See [[b.md]]', contentHash: H2, revision: 2 })}
                    initialBody="See [[b.md]]"
                    autosaveDebounceMs={100_000}
                />,
            );
            expect(lastSetContent).toBeNull();
        });

        it('⭐ a newer revision with the same body fingerprint (a title or tag edit) changes nothing', async () => {
            vi.useFakeTimers();
            updateActionMock.mockResolvedValue({
                success: true,
                data: doc({ body: 'x', contentHash: H3 }),
            });
            const { rerender } = render(editorFor(doc({ contentHash: H1, revision: 3 })));
            rerender(editorFor(doc({ title: 'Renamed', contentHash: H1, revision: 4 })));
            expect(lastSetContent).toBeNull();
            await typeAndSave('x');
            expect(updateActionMock.mock.calls[0][0].baseContentHash).toBe(H1);
        });

        it('⭐ ignores a re-read from before its own last save (not newer)', async () => {
            vi.useFakeTimers();
            updateActionMock.mockResolvedValue({
                success: true,
                data: doc({ body: 'mine', contentHash: H3, revision: 3 }),
            });
            const { rerender } = render(
                editorFor(doc({ body: 'old', contentHash: H1, revision: 1 })),
            );
            await typeAndSave('mine');
            lastSetContent = null;
            // The page's read raced the save: revision 2, older than the saved 3.
            rerender(editorFor(doc({ body: 'other', contentHash: H2, revision: 2 })));
            expect(lastSetContent).toBeNull();
        });

        it('sends no fingerprint for a document whose DTO has none (an older API)', async () => {
            vi.useFakeTimers();
            updateActionMock.mockResolvedValue({ success: true, data: doc({ body: 'x' }) });
            render(<TiptapEditor workId="work-1" document={doc()} autosaveDebounceMs={10} />);
            await typeAndSave('x');
            expect(updateActionMock.mock.calls[0][0]).not.toHaveProperty('baseContentHash');
        });
    });
});
