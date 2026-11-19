jest.mock('@ever-works/agent/facades', () => ({
    ScreenshotFacadeService: class {},
    MAX_SIGNED_IMAGE_SEGMENT_LENGTH: 4096,
}));

import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import type { ScreenshotFacadeService } from '@ever-works/agent/facades';
import { ScreenshotImageController } from './screenshot-image.controller';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';

describe('ScreenshotImageController', () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);

    let screenshotFacade: { renderSignedImage: jest.Mock };
    let controller: ScreenshotImageController;
    let res: { status: jest.Mock; set: jest.Mock; end: jest.Mock };

    beforeEach(() => {
        screenshotFacade = { renderSignedImage: jest.fn() };
        controller = new ScreenshotImageController(
            screenshotFacade as unknown as ScreenshotFacadeService,
        );
        res = {
            status: jest.fn().mockReturnThis(),
            set: jest.fn().mockReturnThis(),
            end: jest.fn().mockReturnThis(),
        };
    });

    it('is public: Work websites load these images without a session', () => {
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, ScreenshotImageController.prototype.serve)).toBe(
            true,
        );
    });

    it('serves the rendered image with long-lived, locked-down headers', async () => {
        screenshotFacade.renderSignedImage.mockResolvedValue({
            image: PNG,
            contentType: 'image/png',
        });

        await controller.serve('payload.sig.png', res as unknown as Response);

        expect(screenshotFacade.renderSignedImage).toHaveBeenCalledWith('payload.sig.png');
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.set).toHaveBeenCalledWith(
            expect.objectContaining({
                'Content-Type': 'image/png',
                'Content-Length': String(PNG.length),
                'Cache-Control': 'public, max-age=31536000, immutable',
                'X-Content-Type-Options': 'nosniff',
            }),
        );
        expect(res.end).toHaveBeenCalledWith(PNG);
    });

    it('answers 404 for anything that does not verify or render', async () => {
        screenshotFacade.renderSignedImage.mockResolvedValue(null);

        await expect(
            controller.serve('forged.sig.png', res as unknown as Response),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(res.end).not.toHaveBeenCalled();
    });

    it('answers 404 for an oversized segment without rendering', async () => {
        await expect(
            controller.serve('x'.repeat(4097), res as unknown as Response),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(screenshotFacade.renderSignedImage).not.toHaveBeenCalled();
        // Short-circuits before any response header is committed.
        expect(res.status).not.toHaveBeenCalled();
        expect(res.set).not.toHaveBeenCalled();
    });
});
