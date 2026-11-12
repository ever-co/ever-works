import { describe, expect, it } from 'vitest';
import { mergeLineChanges } from './merge-line-changes';

/**
 * #3204 closure check: renaming a document while another one that links to
 * it is open ended in the conflict banner, and Reload threw away what was
 * typed after the rename. The editor now carries the server's link rewrite
 * over to its text when the two touched different lines.
 */
describe('mergeLineChanges', () => {
    const base = ['# Guide', 'Write like [[brand/voice.md]].', '', 'Draft notes'].join('\n');
    const theirs = ['# Guide', 'Write like [[brand/tone.md]].', '', 'Draft notes'].join('\n');

    it('⭐ applies the rewritten line to text typed elsewhere', () => {
        const ours = [
            '# Guide',
            'Write like [[brand/voice.md]].',
            '',
            'Draft notes, more typed',
            'A new line',
        ].join('\n');
        expect(mergeLineChanges(base, theirs, ours)).toBe(
            [
                '# Guide',
                'Write like [[brand/tone.md]].',
                '',
                'Draft notes, more typed',
                'A new line',
            ].join('\n'),
        );
    });

    it('takes theirs when nothing was typed, ours when the server changed nothing', () => {
        expect(mergeLineChanges(base, theirs, base)).toBe(theirs);
        expect(mergeLineChanges(base, base, 'typed')).toBe('typed');
    });

    it.each([
        ['the editor changed the same line', base.replace('Write like', 'Sound like')],
        ['the line now appears twice', `${base}\nWrite like [[brand/voice.md]].`],
    ])('refuses to merge when %s', (_label, ours) => {
        expect(mergeLineChanges(base, theirs, ours)).toBeNull();
    });

    it('refuses when the server added or removed lines (not a link rewrite)', () => {
        expect(mergeLineChanges(base, `${theirs}\nextra`, `${base}\ntyped`)).toBeNull();
    });
});
