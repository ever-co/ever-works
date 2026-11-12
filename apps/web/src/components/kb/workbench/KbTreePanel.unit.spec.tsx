import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

const routerReplaceMock = vi.fn();

// Pass-through stub for the locale-aware Link — same shape as the
// existing KbTreePanel.unit.spec.tsx in works/detail/kb.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
    useRouter: () => ({
        push: vi.fn(),
        refresh: vi.fn(),
        back: vi.fn(),
        replace: routerReplaceMock,
        forward: vi.fn(),
        prefetch: vi.fn(),
    }),
    usePathname: () => '/',
    redirect: vi.fn(),
    getPathname: ({ href }: { href: string }) => href,
}));

import { KbTreePanel } from './KbTreePanel';
import type { KbDocumentDto } from '@ever-works/contracts';

function doc(overrides: Partial<KbDocumentDto> = {}): KbDocumentDto {
    return {
        id: 'doc-' + Math.random().toString(36).slice(2, 9),
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
        ...overrides,
    };
}

function mockFetchOnce(items: KbDocumentDto[]) {
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
        return new Response(JSON.stringify({ items, total: items.length }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }) as unknown as typeof fetch;
}

describe('workbench KbTreePanel', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        routerReplaceMock.mockReset();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders grouped rows once the fetch resolves and the group is expanded', async () => {
        mockFetchOnce([
            doc({ id: 'd1', class: 'brand', title: 'Voice', path: 'brand/voice.md' }),
            doc({ id: 'd2', class: 'brand', title: 'Tone', path: 'brand/tone.md' }),
            doc({ id: 'd3', class: 'legal', title: 'Terms', path: 'legal/terms.md' }),
        ]);

        render(<KbTreePanel workId="work-1" currentDocPath="brand/voice.md" />);

        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-group-brand')).toBeTruthy();
        });

        // The "brand" group contains the active doc → opened by default;
        // the "legal" group → collapsed by default.
        expect(screen.getByTestId('kb-workbench-row-d1')).toBeTruthy();
        expect(screen.getByTestId('kb-workbench-row-d2')).toBeTruthy();
        expect(screen.queryByTestId('kb-workbench-row-d3')).toBeNull();

        // Active doc row carries aria-current.
        expect(screen.getByTestId('kb-workbench-row-d1').getAttribute('aria-current')).toBe('page');
    });

    it('expanding the legal group renders the link with the right href', async () => {
        mockFetchOnce([doc({ id: 'd3', class: 'legal', title: 'Terms', path: 'legal/terms.md' })]);

        render(<KbTreePanel workId="work-1" />);

        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-group-legal')).toBeTruthy();
        });

        act(() => {
            fireEvent.click(screen.getByTestId('kb-workbench-group-toggle-legal'));
        });

        const row = screen.getByTestId('kb-workbench-row-d3');
        expect(row.getAttribute('href')).toBe('/works/work-1/kb/legal/terms.md');
    });

    it('lists the uploaded originals when the Originals tab is active', async () => {
        // Two different endpoints are involved once the tab switches: the
        // document list (KB tab) and the upload list (Originals tab). Route
        // by URL so the tab switch exercises the real second fetch rather
        // than replaying the document payload.
        (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            const body = url.includes('/kb/uploads')
                ? {
                      items: [
                          {
                              id: 'u1',
                              workId: 'work-1',
                              originalFilename: 'brand-guide.pdf',
                              extractionStatus: 'succeeded',
                              extractionError: null,
                          },
                      ],
                      total: 1,
                  }
                : { items: [doc({ id: 'd1' })], total: 1 };
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }) as unknown as typeof fetch;

        render(<KbTreePanel workId="work-1" />);

        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-tab-originals')).toBeTruthy();
        });

        act(() => {
            fireEvent.click(screen.getByTestId('kb-workbench-tab-originals'));
        });

        // The panel fetches on mount, so the row arrives asynchronously.
        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-originals-list')).toBeTruthy();
        });
        expect(screen.getByText('brand-guide.pdf')).toBeTruthy();
        // KB rows should no longer be in the DOM after the tab switch.
        expect(screen.queryByTestId('kb-workbench-row-d1')).toBeNull();
    });

    it('offers a retry only for an upload whose extraction FAILED', async () => {
        // The distinction this pins: an upload can be stored successfully
        // and still contribute nothing to retrieval. A failed row must
        // surface both the reason and the one recovery path the API has.
        (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            const body = url.includes('/kb/uploads')
                ? {
                      items: [
                          {
                              id: 'u-ok',
                              workId: 'work-1',
                              originalFilename: 'fine.md',
                              extractionStatus: 'succeeded',
                              extractionError: null,
                          },
                          {
                              id: 'u-bad',
                              workId: 'work-1',
                              originalFilename: 'broken.pdf',
                              extractionStatus: 'failed',
                              extractionError: 'malformed PDF trailer',
                          },
                      ],
                      total: 2,
                  }
                : { items: [], total: 0 };
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }) as unknown as typeof fetch;

        render(<KbTreePanel workId="work-1" />);
        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-tab-originals')).toBeTruthy();
        });
        act(() => {
            fireEvent.click(screen.getByTestId('kb-workbench-tab-originals'));
        });

        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-originals-list')).toBeTruthy();
        });
        // Exactly one retry control — the succeeded row must not offer one.
        expect(screen.getAllByTestId('kb-workbench-originals-retry')).toHaveLength(1);
        expect(screen.getByText('malformed PDF trailer')).toBeTruthy();
    });

    it('renders the empty state when the server returns zero docs', async () => {
        mockFetchOnce([]);
        render(<KbTreePanel workId="work-1" />);

        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-tree-empty')).toBeTruthy();
        });
    });

    it('marks the lock icon on locked rows', async () => {
        mockFetchOnce([
            doc({ id: 'd1', class: 'brand', locked: true, lockMode: 'full', title: 'Voice' }),
        ]);
        render(<KbTreePanel workId="work-1" currentDocPath="brand/voice.md" />);
        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-row-d1-lock')).toBeTruthy();
        });
    });

    // ─── Memory upgrades M8 — review-queue discoverability ────────────

    it('links to the review queue route', async () => {
        mockFetchOnce([doc({ id: 'd1' })]);
        render(<KbTreePanel workId="work-1" />);
        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-review-link')).toBeTruthy();
        });
        expect(screen.getByTestId('kb-workbench-review-link').getAttribute('href')).toBe(
            '/works/work-1/kb/review',
        );
    });

    it('badges the count of documents awaiting review', async () => {
        mockFetchOnce([
            doc({ id: 'd1', reviewState: 'proposed', source: 'agent' }),
            doc({ id: 'd2', reviewState: 'proposed', source: 'agent' }),
            doc({ id: 'd3', reviewState: 'accepted' }),
            // Pre-M7 rows carry a null column and must NOT count as work.
            doc({ id: 'd4', reviewState: null }),
        ]);
        render(<KbTreePanel workId="work-1" />);
        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-review-badge')).toBeTruthy();
        });
        expect(screen.getByTestId('kb-workbench-review-badge').textContent).toBe('2');
    });

    it('hides the badge when nothing is awaiting review', async () => {
        mockFetchOnce([doc({ id: 'd1', reviewState: 'accepted' }), doc({ id: 'd2' })]);
        render(<KbTreePanel workId="work-1" />);
        await waitFor(() => {
            expect(screen.getByTestId('kb-workbench-review-link')).toBeTruthy();
        });
        expect(screen.queryByTestId('kb-workbench-review-badge')).toBeNull();
    });

    // ─── Rename (POST …/move) ─────────────────────────────────────────

    describe('Rename from the tree', () => {
        function mockTreeAndMove(moved: KbDocumentDto) {
            const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                const json = (body: unknown, status = 200) =>
                    new Response(JSON.stringify(body), {
                        status,
                        headers: { 'Content-Type': 'application/json' },
                    });
                if (url.endsWith('/move')) return json(moved);
                if (url.includes('/kb/documents')) {
                    return json({
                        items: [
                            doc({ id: 'd1', title: 'Voice', path: 'brand/voice.md' }),
                            doc({ id: 'd2', title: 'Colors', path: 'brand/colors.md' }),
                        ],
                        total: 2,
                    });
                }
                // The library row the menu reads when it opens.
                return json({ message: 'not found' }, 404);
            });
            (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
            return fetchMock;
        }

        async function renameRow(rowId: string, path: string) {
            const row = await screen.findByTestId(`kb-workbench-row-${rowId}`);
            fireEvent.contextMenu(row, { clientX: 5, clientY: 5 });
            fireEvent.click(await screen.findByTestId('kb-workbench-context-rename'));
            fireEvent.change(screen.getByTestId('kb-workbench-context-rename-input'), {
                target: { value: path },
            });
            fireEvent.click(screen.getByTestId('kb-workbench-context-rename-submit'));
        }

        it('offers Rename on a tree row (the tree opts in)', async () => {
            mockTreeAndMove(doc({ id: 'd1' }));
            render(<KbTreePanel workId="work-1" currentDocPath="brand/voice.md" />);
            fireEvent.contextMenu(await screen.findByTestId('kb-workbench-row-d1'), {
                clientX: 5,
                clientY: 5,
            });
            expect(await screen.findByTestId('kb-workbench-context-rename')).toBeTruthy();
        });

        it('moves the row in place and follows the OPEN document to its new URL', async () => {
            const fetchMock = mockTreeAndMove(
                doc({ id: 'd1', title: 'Voice', path: 'brand/tone.md', slug: 'tone' }),
            );
            render(<KbTreePanel workId="work-1" currentDocPath="brand/voice.md" />);

            await renameRow('d1', 'brand/tone.md');

            await waitFor(() => {
                expect(screen.getByTestId('kb-workbench-row-d1').getAttribute('href')).toBe(
                    '/works/work-1/kb/brand/tone.md',
                );
            });
            expect(routerReplaceMock).toHaveBeenCalledWith('/works/work-1/kb/brand/tone.md');
            expect(
                fetchMock.mock.calls.some(([url]) =>
                    String(url).endsWith('/api/works/work-1/kb/documents/d1/move'),
                ),
            ).toBe(true);
        });

        it('renaming another document leaves the current page where it is', async () => {
            mockTreeAndMove(doc({ id: 'd2', title: 'Colors', path: 'brand/palette.md' }));
            render(<KbTreePanel workId="work-1" currentDocPath="brand/voice.md" />);

            await renameRow('d2', 'brand/palette.md');

            await waitFor(() => {
                expect(
                    screen.getByTestId('kb-workbench-row-d2').getAttribute('data-doc-path'),
                ).toBe('brand/palette.md');
            });
            expect(routerReplaceMock).not.toHaveBeenCalled();
        });
    });
});
