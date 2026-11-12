import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MoveKbDocumentDto } from './move-kb-document.dto';

const errorsFor = async (body: unknown) =>
    (await validate(plainToInstance(MoveKbDocumentDto, body as object))).map((e) => e.property);

/**
 * `POST /api/works/:id/kb/documents/:docId/move` — the body is one path. The
 * global ValidationPipe runs with `forbidNonWhitelisted`, so only `path` is
 * declared; the service applies the same pattern again plus create's
 * class-folder and traversal rules.
 */
describe('MoveKbDocumentDto', () => {
    it.each(['brand/tone.md', 'research/2026/q3-notes_v2.md'])('accepts %s', async (path) => {
        expect(await errorsFor({ path })).toEqual([]);
    });

    it.each([
        ['missing', {}],
        ['empty', { path: '' }],
        ['not a string', { path: 42 }],
        ['without .md', { path: 'brand/tone' }],
        ['with a space', { path: 'brand/brand tone.md' }],
        ['absolute', { path: '/brand/tone.md' }],
        ['traversing', { path: 'brand/../tone.md' }],
        ['too long', { path: `brand/${'a'.repeat(510)}.md` }],
    ])('refuses a path %s', async (_label, body) => {
        expect(await errorsFor(body)).toEqual(['path']);
    });
});
