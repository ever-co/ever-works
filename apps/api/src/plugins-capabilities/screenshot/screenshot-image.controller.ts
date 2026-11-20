import { Controller, Get, HttpStatus, NotFoundException, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
    MAX_SIGNED_IMAGE_SEGMENT_LENGTH,
    ScreenshotFacadeService,
} from '@ever-works/agent/facades';
import { Public } from '../../auth/decorators/public.decorator';

/**
 * Public, signed screenshot images.
 *
 * A screenshot provider that returns image bytes instead of a URL (the
 * self-hosted Gotenberg plugin) gets a signed URL on this route from the
 * screenshot facade; Work items store that URL and the Work's website loads
 * it like any image. The route is public because those websites are, and safe
 * because it renders only what the platform signed (HMAC over the provider
 * and the capture options), never a URL a caller chooses.
 *
 * A URL's meaning never changes, so the answer is cacheable for a year and a
 * CDN in front of the API renders each image once. Anything that does not
 * verify, or does not render, answers the same 404.
 */
@ApiTags('Screenshot')
@Controller('api/screenshot/image')
export class ScreenshotImageController {
    constructor(private readonly screenshotFacade: ScreenshotFacadeService) {}

    @Public()
    @Get(':file')
    // A cache miss starts a browser render; keep a client from forcing many.
    @Throttle({ long: { limit: 60, ttl: 60_000 } })
    @ApiOperation({ summary: 'Serve a signed screenshot image (public, cacheable)' })
    @ApiParam({
        name: 'file',
        description: '{payload}.{signature}.{png|jpg|webp}, as minted by the platform',
    })
    @ApiResponse({ status: 200, description: 'The image' })
    @ApiResponse({ status: 404, description: 'Unknown, unsigned or unrenderable image' })
    async serve(@Param('file') file: string, @Res() res: Response): Promise<void> {
        if (typeof file !== 'string' || file.length > MAX_SIGNED_IMAGE_SEGMENT_LENGTH) {
            throw new NotFoundException();
        }

        const rendered = await this.screenshotFacade.renderSignedImage(file);
        if (!rendered) {
            throw new NotFoundException();
        }

        res.status(HttpStatus.OK)
            .set({
                'Content-Type': rendered.contentType,
                'Content-Length': String(rendered.image.length),
                'Cache-Control': 'public, max-age=31536000, immutable',
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy':
                    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
                'Cross-Origin-Resource-Policy': 'cross-origin',
            })
            .end(rendered.image);
    }
}
