'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useEditor, EditorContent, ReactRenderer, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Typography from '@tiptap/extension-typography';
import { Markdown } from 'tiptap-markdown';
import { cn } from '@/lib/utils/cn';
import { updateKbDocumentAction } from '@/app/actions/works/kb-document';
import { useAutosaveStatus, type SaveStatus } from '@/lib/kb/use-autosave-status';
import { mergeLineChanges } from '@/lib/kb/merge-line-changes';
import {
    WorkbenchWikilinkExtension,
    type WikilinkSuggestionItem,
    type WikilinkSuggestionRenderer,
    type WikilinkSuggestionRenderProps,
} from './extensions/wikilink-suggestion';
import {
    createWorkbenchMentionExtension,
    type MentionSuggestionItem,
    type MentionSuggestionRenderer,
    type MentionSuggestionRenderProps,
} from './extensions/mention-suggestion';
import {
    WorkbenchWikilinkSuggestionList,
    type WorkbenchWikilinkSuggestionListHandle,
} from './WorkbenchWikilinkSuggestionList';
import {
    WorkbenchMentionSuggestionList,
    type WorkbenchMentionSuggestionListHandle,
} from './WorkbenchMentionSuggestionList';
import type { KbDocumentBodyDto, KbDocumentDto } from '@ever-works/contracts';

/**
 * EW-641 slice B — Tiptap WYSIWYG editor that replaces the slice-A
 * Markdown split-pane.
 *
 * Drop-in replacement for `MarkdownEditor`. Same autosave contract
 * (`updateKbDocumentAction`, 800ms debounce, "Saved Ns ago" pill, 409
 * conflict banner, 423 locked banner) — the autosave plumbing is
 * shared via `useAutosaveStatus` so both editors stay aligned.
 *
 * Extras over slice A:
 *  - WYSIWYG editing via Tiptap on top of a Markdown round-trip
 *    (`tiptap-markdown`). The editor reads / writes Markdown so the
 *    persisted body shape doesn't change.
 *  - `[[…` triggers a wikilink popover (workbench extension). Selecting
 *    a result inserts an inline `<a>` (Tiptap Link mark) pointing at the
 *    new workbench URL — `/works/{workId}/kb/{doc.path}`.
 *  - `@…` triggers a unified mention popover (docs + agents). Selecting
 *    inserts a proper Tiptap Mention node with `{ id, label, kind }`
 *    attrs, rendered as a coloured pill via `kb-mention-chip` + the
 *    `data-kb-mention-kind` attribute.
 *
 * Tiptap on React 19 strict mode needs `immediatelyRender: false`.
 */
export interface TiptapEditorProps {
    workId: string;
    document: KbDocumentDto;
    /** Called with the freshly-confirmed body each time the autosave round-trips. */
    onSaved?: (document: KbDocumentBodyDto) => void;
    /** Override the 800ms autosave debounce — tests pass 0 for sync runs. */
    autosaveDebounceMs?: number;
    /** Banner Reload handler when a 409 conflict surfaces; defaults to `location.reload`. */
    onReload?: () => void;
    /** Initial body — defaults to `document.body` when present (KbDocumentBodyDto). */
    initialBody?: string;
}

const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 800;

export function TiptapEditor({
    workId,
    document,
    onSaved,
    autosaveDebounceMs = DEFAULT_AUTOSAVE_DEBOUNCE_MS,
    onReload,
    initialBody,
}: TiptapEditorProps) {
    const t = useTranslations('dashboard.workDetail.kb');
    const startBody = initialBody ?? (isBodyDto(document) ? document.body : '');
    const docIdRef = useRef(document.id);
    // The body the editor's text is based on (the server's, as loaded or last
    // saved) and its fingerprint: every save sends the fingerprint, so a save
    // made on a body the server has since changed (another edit, or a rename
    // that rewrote this document's links) is refused (409 → the conflict
    // banner) instead of writing the old text back over it. A title or tag
    // edit leaves the fingerprint alone, so it never makes a save conflict.
    const baseHashRef = useRef<string | undefined>(document.contentHash);
    const baseBodyRef = useRef(startBody);
    // The revision of that base: a re-read document is newer only when its
    // revision is higher (a page read from before the last save is not).
    const baseRevisionRef = useRef<number | undefined>(document.revision);
    // The page's document fingerprint the editor has already dealt with.
    const propHashRef = useRef<string | undefined>(document.contentHash);
    // "Keep my version": the next save goes without the fingerprint check.
    const keepMineRef = useRef(false);
    // Read synchronously when the page re-reads the document, never from React
    // state (a render can lag a keystroke): the text typed and not yet
    // confirmed saved (`null`: none), and whether a save is in flight.
    const unsavedRef = useRef<string | null>(null);
    const inFlightRef = useRef(false);

    const save = useCallback(
        async ({ candidate }: { candidate: string }) => {
            const baseContentHash = keepMineRef.current ? undefined : baseHashRef.current;
            keepMineRef.current = false;
            inFlightRef.current = true;
            let result: Awaited<ReturnType<typeof updateKbDocumentAction>>;
            try {
                result = await updateKbDocumentAction({
                    workId,
                    docId: document.id,
                    body: { body: candidate },
                    ...(baseContentHash ? { baseContentHash } : {}),
                });
            } finally {
                inFlightRef.current = false;
            }
            if (result.success) {
                // Typed nothing more while it saved: nothing is unsaved now.
                if (unsavedRef.current === candidate) unsavedRef.current = null;
                const confirmedBody = result.data?.body ?? candidate;
                baseHashRef.current = result.data?.contentHash ?? baseHashRef.current;
                baseRevisionRef.current = result.data?.revision ?? baseRevisionRef.current;
                baseBodyRef.current = confirmedBody;
                if (result.data) onSaved?.(result.data);
                return { success: true, confirmedBody };
            }
            return { success: false, error: result.error };
        },
        [workId, document.id, onSaved],
    );

    const autosave = useAutosaveStatus({
        initialBody: startBody,
        debounceMs: autosaveDebounceMs,
        save,
    });

    const wikilinkRenderFactory = useMemo(() => createWikilinkRenderFactory(), []);
    const mentionRenderFactory = useMemo(() => createMentionRenderFactory(), []);

    const editor = useEditor({
        immediatelyRender: false,
        extensions: [
            // Tiptap 3's StarterKit also bundles Link, Underline, TrailingNode and ListKeymap.
            // Link is configured on its own below (a second `link` would be a duplicate), and the
            // other three stay off to keep the v2 behaviour: TrailingNode would add an empty
            // paragraph after a closing heading or list that the v2 editor never added (a document
            // change, so an autosave), and markdown has no underline.
            StarterKit.configure({
                link: false,
                underline: false,
                trailingNode: false,
                listKeymap: false,
            }),
            Link.configure({
                openOnClick: false,
                HTMLAttributes: { rel: 'noopener noreferrer' },
            }),
            Placeholder.configure({
                placeholder: t('workbench.editor.placeholder'),
            }),
            Typography,
            Markdown.configure({
                html: false,
                breaks: true,
                transformPastedText: true,
            }),
            WorkbenchWikilinkExtension.configure({
                workId,
                render: wikilinkRenderFactory,
            }),
            createWorkbenchMentionExtension({
                workId,
                render: mentionRenderFactory,
            }),
        ],
        content: startBody,
        editorProps: {
            attributes: {
                'data-testid': 'kb-tiptap-editor-body',
                class: cn(
                    'prose prose-sm dark:prose-invert max-w-none focus:outline-none',
                    'min-h-[20rem] px-4 py-3',
                ),
            },
        },
    });

    // Reset the autosave machine + editor content whenever the parent
    // swaps to a different document.
    useEffect(() => {
        if (docIdRef.current === document.id) {
            // The same document, re-read by the page (a rename of it or of a
            // document it links to refreshes the page). When the server's body
            // is not the one the editor's text is based on, take it in:
            //  - nothing typed since the last save → show the server's body;
            //  - text typed → carry the server's change over to it when the
            //    two touched different lines (a link rewrite does);
            //  - otherwise keep the typed text: its save conflicts, and the
            //    banner offers to reload or to keep this version.
            const serverHash = document.contentHash;
            const serverRevision = document.revision;
            const serverBody = initialBody ?? (isBodyDto(document) ? document.body : undefined);
            if (!serverHash || serverBody === undefined || typeof serverRevision !== 'number')
                return;
            if (serverHash === propHashRef.current) return; // the same read as before
            if (inFlightRef.current) return; // decided once the save answers (the effect runs again)
            propHashRef.current = serverHash;
            if (
                typeof baseRevisionRef.current === 'number' &&
                serverRevision <= baseRevisionRef.current
            ) {
                return; // not newer than what the editor has (read before its last save)
            }
            baseRevisionRef.current = serverRevision;
            if (serverHash === baseHashRef.current || serverBody === baseBodyRef.current) {
                baseHashRef.current = serverHash; // a title or tag edit: the body is the same
                return;
            }
            const ours =
                unsavedRef.current === null
                    ? undefined
                    : ((editor ? readMarkdown(editor) : undefined) ?? unsavedRef.current);
            const merged =
                typeof ours === 'string'
                    ? mergeLineChanges(baseBodyRef.current, serverBody, ours)
                    : serverBody;
            if (merged === null) return;
            // The body changed under a pending "Keep my version": the choice
            // was made about the old one, so the merged text saves with the check.
            keepMineRef.current = false;
            baseHashRef.current = serverHash;
            baseBodyRef.current = serverBody;
            autosave.reset(serverBody);
            editor?.commands.setContent(merged, { emitUpdate: false });
            unsavedRef.current = merged === serverBody ? null : merged;
            if (merged !== serverBody) autosave.schedule(merged);
            return;
        }
        docIdRef.current = document.id;
        const next = initialBody ?? (isBodyDto(document) ? document.body : '');
        baseHashRef.current = document.contentHash;
        baseRevisionRef.current = document.revision;
        propHashRef.current = document.contentHash;
        baseBodyRef.current = next;
        unsavedRef.current = null;
        keepMineRef.current = false;
        autosave.reset(next);
        if (editor) {
            // `emitUpdate: false` so the document swap doesn't fire the
            // autosave listener we just reset above (Tiptap 3 takes an
            // options object; v2 took a bare boolean).
            editor.commands.setContent(next, { emitUpdate: false });
        }
    }, [document, initialBody, editor, autosave]);

    // Wire the editor's `update` event into the autosave scheduler.
    useEffect(() => {
        if (!editor) return;
        const onUpdate = () => {
            const md = readMarkdown(editor);
            if (typeof md !== 'string') return;
            unsavedRef.current = md;
            autosave.schedule(md);
        };
        editor.on('update', onUpdate);
        return () => {
            editor.off('update', onUpdate);
        };
    }, [editor, autosave]);

    // Save the text as it is over the newer body (whose change — say, a
    // renamed document's links — is then lost in this document).
    const keepMine = () => {
        if (!editor) return;
        const md = readMarkdown(editor);
        if (typeof md !== 'string') return;
        keepMineRef.current = true;
        autosave.schedule(md);
    };

    const reload = () => {
        if (onReload) {
            onReload();
            return;
        }
        if (typeof window !== 'undefined') {
            window.location.reload();
        }
    };

    return (
        <div
            data-testid="kb-workbench-editor"
            data-doc-id={document.id}
            data-status={autosave.status}
            className="flex h-full min-h-[24rem] flex-col"
        >
            <div className="flex items-center justify-end gap-2 px-4 py-1.5">
                <StatusIndicator
                    status={autosave.status}
                    savedAt={autosave.savedAt}
                    labels={{
                        saving: t('workbench.editor.saving'),
                        saved: t('workbench.editor.savedAt'),
                    }}
                />
            </div>

            {autosave.errorKind === 'conflict' ? (
                <Banner
                    testId="kb-workbench-conflict-banner"
                    tone="warning"
                    message={t('workbench.conflict')}
                    actionLabel={t('workbench.reload')}
                    onAction={reload}
                    secondaryActionLabel={t('workbench.keepMine')}
                    onSecondaryAction={keepMine}
                />
            ) : null}

            {autosave.errorKind === 'locked' ? (
                <Banner
                    testId="kb-workbench-locked-banner"
                    tone="warning"
                    message={t('workbench.locked')}
                />
            ) : null}

            <div className="flex flex-1 flex-col overflow-auto">
                <div
                    className={cn(
                        'm-4 flex-1 rounded-md border border-border/60 dark:border-border-dark/60',
                        'bg-card/70 dark:bg-card-primary-dark/10',
                    )}
                >
                    {editor ? (
                        <EditorContent editor={editor} />
                    ) : (
                        <div
                            data-testid="kb-tiptap-editor-body"
                            className="min-h-[20rem] px-4 py-3 text-sm italic text-text-muted dark:text-text-muted-dark/60"
                        >
                            {t('workbench.editor.placeholder')}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function isBodyDto(document: KbDocumentDto | KbDocumentBodyDto): document is KbDocumentBodyDto {
    return typeof (document as KbDocumentBodyDto).body === 'string';
}

function readMarkdown(editor: Editor): string | undefined {
    const storage = editor.storage as unknown as Record<string, { getMarkdown?: () => string }>;
    return storage.markdown?.getMarkdown?.();
}

interface StatusIndicatorProps {
    status: SaveStatus;
    savedAt: number | null;
    labels: { saving: string; saved: string };
}

function StatusIndicator({ status, savedAt, labels }: StatusIndicatorProps) {
    const [, force] = useState(0);
    // Re-render once per second while we have a `savedAt` so the
    // "Saved 2s ago" copy stays fresh without flooding the React tree.
    useEffect(() => {
        if (savedAt === null) return;
        const interval = setInterval(() => force((v) => v + 1), 1000);
        return () => clearInterval(interval);
    }, [savedAt]);

    if (status === 'saving') {
        return (
            <span
                data-testid="kb-workbench-status"
                data-status="saving"
                className="text-xs text-text-muted dark:text-text-muted-dark/70"
            >
                {labels.saving}
            </span>
        );
    }
    if (status === 'saved' && savedAt !== null) {
        const seconds = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
        return (
            <span
                data-testid="kb-workbench-status"
                data-status="saved"
                className="text-xs text-emerald-700 dark:text-emerald-300"
            >
                {labels.saved.replace('{seconds}', String(seconds))}
            </span>
        );
    }
    return (
        <span data-testid="kb-workbench-status" data-status={status} className="sr-only">
            {status}
        </span>
    );
}

interface BannerProps {
    testId: string;
    tone: 'warning';
    message: string;
    actionLabel?: string;
    onAction?: () => void;
    /** A second choice beside the action (the conflict banner's "Keep my version"). */
    secondaryActionLabel?: string;
    onSecondaryAction?: () => void;
}

function Banner({
    testId,
    tone: _tone,
    message,
    actionLabel,
    onAction,
    secondaryActionLabel,
    onSecondaryAction,
}: BannerProps) {
    return (
        <div
            data-testid={testId}
            role="status"
            className={cn(
                'mx-4 mt-1 flex items-center gap-3 rounded-md border px-3 py-2 text-xs',
                'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200',
            )}
        >
            <span className="flex-1">{message}</span>
            {actionLabel && onAction ? (
                <button
                    type="button"
                    onClick={onAction}
                    data-testid={`${testId}-action`}
                    className={cn(
                        'rounded-md border border-amber-500/40 bg-white/40 px-2 py-1',
                        'text-amber-900 hover:bg-white/60',
                        'dark:bg-amber-500/10 dark:text-amber-100 dark:hover:bg-amber-500/20',
                    )}
                >
                    {actionLabel}
                </button>
            ) : null}
            {secondaryActionLabel && onSecondaryAction ? (
                <button
                    type="button"
                    onClick={onSecondaryAction}
                    data-testid={`${testId}-secondary`}
                    className={cn(
                        'rounded-md border border-amber-500/40 px-2 py-1',
                        'text-amber-900 hover:bg-white/60',
                        'dark:text-amber-100 dark:hover:bg-amber-500/20',
                    )}
                >
                    {secondaryActionLabel}
                </button>
            ) : null}
        </div>
    );
}

/**
 * Build a renderer factory for `WorkbenchWikilinkExtension`. Mirrors the
 * slice-A pattern: a single `ReactRenderer` lives inside a
 * `position: fixed` popover `<div>` over the lifetime of one trigger,
 * positioned off the `clientRect()` callback. No tippy.js dep — the
 * popover is small and the codebase's existing convention is the
 * hand-positioned div.
 */
function createWikilinkRenderFactory(): () => WikilinkSuggestionRenderer {
    return () => {
        let renderer: ReactRenderer<WorkbenchWikilinkSuggestionListHandle> | null = null;
        let popoverEl: HTMLDivElement | null = null;

        function positionFrom(clientRect: (() => DOMRect | null) | null) {
            if (!popoverEl) return;
            const rect = clientRect?.();
            if (!rect) {
                popoverEl.style.visibility = 'hidden';
                return;
            }
            popoverEl.style.visibility = 'visible';
            popoverEl.style.top = `${rect.bottom + 4}px`;
            popoverEl.style.left = `${rect.left}px`;
        }

        function mount(props: WikilinkSuggestionRenderProps) {
            popoverEl = window.document.createElement('div');
            popoverEl.setAttribute('data-testid', 'kb-workbench-wikilink-popover');
            popoverEl.style.position = 'fixed';
            popoverEl.style.zIndex = '60';
            window.document.body.appendChild(popoverEl);
            renderer = new ReactRenderer(WorkbenchWikilinkSuggestionList, {
                editor: undefined as unknown as Editor,
                props: {
                    items: props.items,
                    query: props.query,
                    loading: props.loading,
                    onSelect: (item: WikilinkSuggestionItem) => props.command(item),
                } as Record<string, unknown>,
            });
            const element = renderer.element as unknown as HTMLElement | null;
            if (element) {
                popoverEl.appendChild(element);
            }
            positionFrom(props.clientRect);
        }

        return {
            onStart: (props) => {
                mount(props);
            },
            onUpdate: (props) => {
                if (!renderer) return;
                renderer.updateProps({
                    items: props.items,
                    query: props.query,
                    loading: props.loading,
                    onSelect: (item: WikilinkSuggestionItem) => props.command(item),
                });
                positionFrom(props.clientRect);
            },
            onKeyDown: ({ event }) => {
                if (event.key === 'Escape') {
                    return false;
                }
                return renderer?.ref?.onKeyDown(event) ?? false;
            },
            onExit: () => {
                renderer?.destroy();
                renderer = null;
                popoverEl?.remove();
                popoverEl = null;
            },
        };
    };
}

function createMentionRenderFactory(): () => MentionSuggestionRenderer {
    return () => {
        let renderer: ReactRenderer<WorkbenchMentionSuggestionListHandle> | null = null;
        let popoverEl: HTMLDivElement | null = null;

        function positionFrom(clientRect: (() => DOMRect | null) | null) {
            if (!popoverEl) return;
            const rect = clientRect?.();
            if (!rect) {
                popoverEl.style.visibility = 'hidden';
                return;
            }
            popoverEl.style.visibility = 'visible';
            popoverEl.style.top = `${rect.bottom + 4}px`;
            popoverEl.style.left = `${rect.left}px`;
        }

        function mount(props: MentionSuggestionRenderProps) {
            popoverEl = window.document.createElement('div');
            popoverEl.setAttribute('data-testid', 'kb-workbench-mention-popover');
            popoverEl.style.position = 'fixed';
            popoverEl.style.zIndex = '60';
            window.document.body.appendChild(popoverEl);
            renderer = new ReactRenderer(WorkbenchMentionSuggestionList, {
                editor: undefined as unknown as Editor,
                props: {
                    items: props.items,
                    query: props.query,
                    loading: props.loading,
                    onSelect: (item: MentionSuggestionItem) => props.command(item),
                } as Record<string, unknown>,
            });
            const element = renderer.element as unknown as HTMLElement | null;
            if (element) {
                popoverEl.appendChild(element);
            }
            positionFrom(props.clientRect);
        }

        return {
            onStart: (props) => {
                mount(props);
            },
            onUpdate: (props) => {
                if (!renderer) return;
                renderer.updateProps({
                    items: props.items,
                    query: props.query,
                    loading: props.loading,
                    onSelect: (item: MentionSuggestionItem) => props.command(item),
                });
                positionFrom(props.clientRect);
            },
            onKeyDown: ({ event }) => {
                if (event.key === 'Escape') return false;
                return renderer?.ref?.onKeyDown(event) ?? false;
            },
            onExit: () => {
                renderer?.destroy();
                renderer = null;
                popoverEl?.remove();
                popoverEl = null;
            },
        };
    };
}
