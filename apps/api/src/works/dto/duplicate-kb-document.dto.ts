import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

/**
 * `POST /api/works/:id/kb/documents/:docId/duplicate` — copy a KB document.
 *
 * The KB tree's "Duplicate" menu item has called this route since it shipped,
 * but no API (nor web proxy) route existed, so every click answered 404.
 */
export class DuplicateKbDocumentDto {
    @ApiPropertyOptional({
        description:
            'Where the copy goes (a KB-relative path). Omitted: next to the source; a taken path gets a free name.',
        maxLength: 512,
    })
    @IsOptional()
    @IsString()
    @Length(1, 512)
    path?: string;

    @ApiPropertyOptional({
        description: 'Title of the copy. Omitted: the source title + " (copy)".',
    })
    @IsOptional()
    @IsString()
    @Length(1, 255)
    title?: string;
}
