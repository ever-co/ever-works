import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

/**
 * Where a document may move — the same pattern as `KB_MOVE_PATH_PATTERN` in
 * `packages/agent/src/services/kb-document-move.ts`, which the service applies
 * again (with create's class-folder and traversal rules): a class folder, any
 * sub-folders, a file name ending in `.md`; each segment starts with a letter
 * or digit and uses only letters, digits, `-`, `_` and `.` — the characters
 * wikilinks, `@kb:` mentions and `kb:` citations recognise.
 */
export const KB_MOVE_PATH_PATTERN =
    /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*\.md$/;

/**
 * `POST /api/works/:id/kb/documents/:docId/move` — rename or move a KB
 * document to another path in the same Work.
 *
 * The KB tree's "Rename" used to PATCH `{ path }`, which
 * `UpdateKbDocumentDto` does not accept (400): a path change also has to
 * move the git-mirrored file and the links other documents carry, so it is
 * its own route.
 */
export class MoveKbDocumentDto {
    @ApiProperty({
        description:
            'The new KB-relative path: a class folder, then a file name ending in .md (e.g. `brand/tone.md`). A path another document of the Work holds answers 409.',
        maxLength: 512,
        example: 'brand/tone.md',
    })
    @IsString()
    @Length(1, 512)
    @Matches(KB_MOVE_PATH_PATTERN, {
        message:
            "path must be a class folder and a file name ending in .md, using letters, digits, '-', '_' and '.' (e.g. brand/voice.md)",
    })
    path: string;
}
