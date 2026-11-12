import {
    KB_MIRROR_RETIRED_PATHS_KEY,
    KB_MIRROR_RETIRED_PATHS_MAX,
    KB_MOVE_PATH_PATTERN,
    nextRetiredPaths,
    retiredPathsOf,
    rewriteKbDocumentLinks,
    slugOfKbPath,
} from './kb-document-move';

const WORK_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_WORK_ID = '00000000-0000-0000-0000-000000000002';
const move = { workId: WORK_ID, oldPath: 'brand/voice.md', newPath: 'brand/tone.md' };

/**
 * The pure parts of a KB document move: which paths a document may move to,
 * the retired-path marker the git mirror reads, and the rewrite of the links
 * other documents carry to the old path.
 */
describe('kb-document-move', () => {
    describe('KB_MOVE_PATH_PATTERN', () => {
        it.each(['brand/tone.md', 'brand/2026/q3-plan_v2.md', 'legal/terms.v2.md', 'a/b.md'])(
            'accepts %s',
            (path) => {
                expect(KB_MOVE_PATH_PATTERN.test(path)).toBe(true);
            },
        );

        it.each([
            ['no .md', 'brand/tone'],
            ['another extension', 'brand/tone.txt'],
            ['an upper-case extension', 'brand/tone.MD'],
            ['a space', 'brand/brand voice.md'],
            ['a leading slash', '/brand/tone.md'],
            ['a traversal segment', 'brand/../legal/tone.md'],
            ['a dot segment', 'brand/./tone.md'],
            ['an empty segment', 'brand//tone.md'],
            ['a hidden file', 'brand/.tone.md'],
            ['a bare .md', 'brand/.md'],
            ['a backslash', 'brand\\tone.md'],
            ['a link-breaking bracket', 'brand/tone].md'],
            ['a trailing slash', 'brand/tone.md/'],
        ])('refuses %s', (_label, path) => {
            expect(KB_MOVE_PATH_PATTERN.test(path)).toBe(false);
        });
    });

    describe('slugOfKbPath', () => {
        it('is the last segment without .md, lower-cased (as create derives it)', () => {
            expect(slugOfKbPath('brand/Tone-Of-Voice.md')).toBe('tone-of-voice');
            expect(slugOfKbPath('research/2026/q3.md')).toBe('q3');
        });
    });

    describe('retired paths', () => {
        it('reads nothing from metadata without the marker, or with a malformed one', () => {
            expect(retiredPathsOf(null)).toEqual([]);
            expect(retiredPathsOf({ body: 'x' })).toEqual([]);
            expect(retiredPathsOf({ [KB_MIRROR_RETIRED_PATHS_KEY]: 'brand/voice.md' })).toEqual([]);
            expect(
                retiredPathsOf({ [KB_MIRROR_RETIRED_PATHS_KEY]: ['brand/a.md', 7, '', null] }),
            ).toEqual(['brand/a.md']);
        });

        it('adds the path moved from and drops the path moved to', () => {
            const metadata = { [KB_MIRROR_RETIRED_PATHS_KEY]: ['brand/old.md', 'brand/tone.md'] };
            expect(nextRetiredPaths(metadata, 'brand/voice.md', 'brand/tone.md')).toEqual([
                'brand/old.md',
                'brand/voice.md',
            ]);
        });

        it('moving back to a path the document once had keeps that path off the list', () => {
            const first = nextRetiredPaths({}, 'brand/a.md', 'brand/b.md');
            const back = nextRetiredPaths(
                { [KB_MIRROR_RETIRED_PATHS_KEY]: first },
                'brand/b.md',
                'brand/a.md',
            );
            expect(back).toEqual(['brand/b.md']);
        });

        it(`keeps at most ${KB_MIRROR_RETIRED_PATHS_MAX}, dropping the oldest`, () => {
            const many = Array.from({ length: 30 }, (_, i) => `brand/p${i}.md`);
            const next = nextRetiredPaths(
                { [KB_MIRROR_RETIRED_PATHS_KEY]: many },
                'brand/now.md',
                'brand/next.md',
            );
            expect(next).toHaveLength(KB_MIRROR_RETIRED_PATHS_MAX);
            expect(next[next.length - 1]).toBe('brand/now.md');
            expect(next).not.toContain('brand/p0.md');
        });
    });

    describe('rewriteKbDocumentLinks', () => {
        it('rewrites a path-only wikilink, keeping the padding the renderer trims', () => {
            const out = rewriteKbDocumentLinks(
                'See [[brand/voice.md]] and [[ brand/voice.md ]].',
                move,
            );
            expect(out).toEqual({
                body: 'See [[brand/tone.md]] and [[ brand/tone.md ]].',
                rewritten: 2,
            });
        });

        it('rewrites a labelled wikilink and keeps the label (even one naming the old path)', () => {
            const out = rewriteKbDocumentLinks('[[brand/voice.md|brand/voice.md]]', move);
            expect(out.body).toBe('[[brand/voice.md|brand/tone.md]]');
            expect(out.rewritten).toBe(1);
        });

        it("rewrites the workbench editor's Markdown link, relative or absolute", () => {
            const body = [
                `[Voice](/works/${WORK_ID}/kb/brand/voice.md)`,
                `[Voice](/works/${WORK_ID}/kb/brand/voice.md#tone "Brand voice")`,
                `https://app.ever.works/works/${WORK_ID}/kb/brand/voice.md`,
            ].join('\n');
            const out = rewriteKbDocumentLinks(body, move);
            expect(out.rewritten).toBe(3);
            expect(out.body).toBe(
                [
                    `[Voice](/works/${WORK_ID}/kb/brand/tone.md)`,
                    `[Voice](/works/${WORK_ID}/kb/brand/tone.md#tone "Brand voice")`,
                    `https://app.ever.works/works/${WORK_ID}/kb/brand/tone.md`,
                ].join('\n'),
            );
        });

        it('rewrites a Markdown link whose path segments the editor URI-encoded', () => {
            const out = rewriteKbDocumentLinks(`[V](/works/${WORK_ID}/kb/brand/brand%20voice.md)`, {
                workId: WORK_ID,
                oldPath: 'brand/brand voice.md',
                newPath: 'brand/voice.md',
            });
            expect(out.body).toBe(`[V](/works/${WORK_ID}/kb/brand/voice.md)`);
        });

        it('leaves links to a longer path, another document, or another Work alone', () => {
            const body = [
                '[[brand/voice.md.bak]]',
                '[[brand/voice.mdx]]',
                '[[brand/voice-2.md]]',
                '[[old/brand/voice.md]]',
                `[x](/works/${WORK_ID}/kb/brand/voice.md.bak)`,
                `[x](/works/${WORK_ID}/kb/brand/voice.md/child.md)`,
                `[x](/works/${OTHER_WORK_ID}/kb/brand/voice.md)`,
            ].join('\n');
            expect(rewriteKbDocumentLinks(body, move)).toEqual({ body, rewritten: 0 });
        });

        it('treats the old path literally (a "." is not a regex wildcard)', () => {
            const body = `[[brand/voiceXmd]] [x](/works/${WORK_ID}/kb/brand/voiceXmd)`;
            expect(rewriteKbDocumentLinks(body, move)).toEqual({ body, rewritten: 0 });
        });

        it('never rewrites inside a code fence or an inline code span (sample syntax)', () => {
            const body = [
                '```md',
                '[[brand/voice.md]]',
                '```',
                'Type `[[brand/voice.md]]` to link, like this: [[brand/voice.md]]',
            ].join('\n');
            const out = rewriteKbDocumentLinks(body, move);
            expect(out.rewritten).toBe(1);
            expect(out.body).toBe(
                [
                    '```md',
                    '[[brand/voice.md]]',
                    '```',
                    'Type `[[brand/voice.md]]` to link, like this: [[brand/tone.md]]',
                ].join('\n'),
            );
        });

        it('does not touch @kb: mentions or kb: citations (chat formats, not body links)', () => {
            const body = 'Ask @kb:brand/voice.md, cited as kb:brand/voice.';
            expect(rewriteKbDocumentLinks(body, move)).toEqual({ body, rewritten: 0 });
        });

        it('a "$" in the new path is inserted literally', () => {
            const out = rewriteKbDocumentLinks('[[brand/voice.md]]', {
                ...move,
                newPath: 'brand/$&.md',
            });
            expect(out.body).toBe('[[brand/$&.md]]');
        });

        it('is a no-op for an empty body or an unchanged path', () => {
            expect(rewriteKbDocumentLinks('', move)).toEqual({ body: '', rewritten: 0 });
            expect(
                rewriteKbDocumentLinks('[[brand/voice.md]]', { ...move, newPath: move.oldPath }),
            ).toEqual({ body: '[[brand/voice.md]]', rewritten: 0 });
        });
    });
});
