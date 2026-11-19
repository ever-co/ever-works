import {
    MAX_SIGNED_IMAGE_SEGMENT_LENGTH,
    SCREENSHOT_IMAGE_ROUTE,
    ScreenshotImageUrlSigner,
    screenshotContentType,
    type SignedScreenshotImage,
} from '../screenshot-image-url';

const IMAGE: SignedScreenshotImage = {
    pluginId: 'gotenberg',
    url: 'https://example.com/product?id=1&ref=a.b',
    viewportWidth: 1280,
    viewportHeight: 800,
    format: 'png',
    fullPage: false,
};

/** The `{payload}.{signature}.{ext}` segment of a minted URL. */
function segmentOf(url: string): string {
    return url.slice(url.lastIndexOf('/') + 1);
}

describe('ScreenshotImageUrlSigner', () => {
    const signer = new ScreenshotImageUrlSigner('https://api.ever.works/', 'platform-secret');

    it('mints a URL on the public image route that verifies back to the same request', () => {
        const url = signer.createUrl(IMAGE);

        expect(url).toMatch(
            new RegExp(
                `^https://api\\.ever\\.works${SCREENSHOT_IMAGE_ROUTE}/[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.png$`,
            ),
        );
        expect(signer.verify(segmentOf(url!))).toEqual(IMAGE);
    });

    it('uses the extension of the format, and jpeg as jpg', () => {
        expect(signer.createUrl({ ...IMAGE, format: 'webp' })).toMatch(/\.webp$/);
        expect(signer.createUrl({ ...IMAGE, format: 'jpeg' })).toMatch(/\.jpg$/);
        expect(signer.createUrl({ ...IMAGE, format: 'jpg' })).toMatch(/\.jpg$/);
    });

    it('keeps a path prefix of the base URL', () => {
        const prefixed = new ScreenshotImageUrlSigner('https://example.org/works-api', 's');
        expect(prefixed.createUrl(IMAGE)).toMatch(
            /^https:\/\/example\.org\/works-api\/api\/screenshot\/image\//,
        );
    });

    it('rejects a tampered payload', () => {
        const [payload, signature, ext] = segmentOf(signer.createUrl(IMAGE)!).split('.');
        const forged = Buffer.from(
            JSON.stringify([1, 'gotenberg', 'http://169.254.169.254/', 1280, 800, 'png', 0]),
        ).toString('base64url');

        expect(signer.verify(`${forged}.${signature}.${ext}`)).toBeNull();
        expect(signer.verify(`${payload}.${signature}x.${ext}`)).toBeNull();
    });

    it('rejects a URL signed with another secret', () => {
        const other = new ScreenshotImageUrlSigner('https://api.ever.works', 'other-secret');
        expect(signer.verify(segmentOf(other.createUrl(IMAGE)!))).toBeNull();
    });

    it('rejects an extension that does not match the signed format', () => {
        const segment = segmentOf(signer.createUrl(IMAGE)!);
        expect(signer.verify(segment.replace(/\.png$/, '.webp'))).toBeNull();
        expect(signer.verify(segment.replace(/\.png$/, '.svg'))).toBeNull();
    });

    it.each([
        '',
        'no-dots',
        'a.b',
        'a.b.c.d',
        '../../etc.passwd.png',
        'x'.repeat(MAX_SIGNED_IMAGE_SEGMENT_LENGTH + 1),
    ])('rejects the malformed segment %#', (segment) => {
        expect(signer.verify(segment)).toBeNull();
    });

    it('rejects a correctly signed payload of the wrong shape', () => {
        // The signature is valid; the shape check refuses the zero width.
        const minted = signer.createUrl({ ...IMAGE, viewportWidth: 0 });
        expect(minted).not.toBeNull();
        expect(signer.verify(segmentOf(minted!))).toBeNull();
    });

    it('is disabled, minting and accepting nothing, without a base URL or a secret', () => {
        for (const disabled of [
            new ScreenshotImageUrlSigner(undefined, 'secret'),
            new ScreenshotImageUrlSigner('not a url', 'secret'),
            new ScreenshotImageUrlSigner('ftp://api.ever.works', 'secret'),
            new ScreenshotImageUrlSigner('https://api.ever.works', undefined),
            new ScreenshotImageUrlSigner('https://api.ever.works', '   '),
        ]) {
            expect(disabled.isEnabled()).toBe(false);
            expect(disabled.createUrl(IMAGE)).toBeNull();
        }

        const noSecret = new ScreenshotImageUrlSigner('https://api.ever.works', undefined);
        expect(noSecret.verify(segmentOf(signer.createUrl(IMAGE)!))).toBeNull();
    });

    it('verifies without a base URL, so a worker-minted URL renders on an API that only knows the secret', () => {
        const apiOnly = new ScreenshotImageUrlSigner(undefined, 'platform-secret');
        expect(apiOnly.verify(segmentOf(signer.createUrl(IMAGE)!))).toEqual(IMAGE);
    });

    it('refuses to mint a URL longer than the route accepts', () => {
        expect(
            signer.createUrl({ ...IMAGE, url: `https://example.com/${'a'.repeat(4000)}` }),
        ).toBeNull();
    });

    describe('fromEnv', () => {
        it('reads the base URL and prefers the dedicated secret', () => {
            const fromDedicated = ScreenshotImageUrlSigner.fromEnv({
                SCREENSHOT_IMAGE_BASE_URL: 'https://api.ever.works',
                SCREENSHOT_IMAGE_SIGNING_SECRET: 'dedicated',
                PLATFORM_ENCRYPTION_KEY: 'platform',
            });
            const dedicated = new ScreenshotImageUrlSigner('https://api.ever.works', 'dedicated');

            expect(fromDedicated.isEnabled()).toBe(true);
            expect(dedicated.verify(segmentOf(fromDedicated.createUrl(IMAGE)!))).toEqual(IMAGE);
        });

        it('falls back to PLATFORM_ENCRYPTION_KEY', () => {
            const fromPlatform = ScreenshotImageUrlSigner.fromEnv({
                SCREENSHOT_IMAGE_BASE_URL: 'https://api.ever.works',
                SCREENSHOT_IMAGE_SIGNING_SECRET: '',
                PLATFORM_ENCRYPTION_KEY: 'platform',
            });
            const platform = new ScreenshotImageUrlSigner('https://api.ever.works', 'platform');

            expect(platform.verify(segmentOf(fromPlatform.createUrl(IMAGE)!))).toEqual(IMAGE);
        });

        it('is disabled when nothing is set', () => {
            expect(ScreenshotImageUrlSigner.fromEnv({}).isEnabled()).toBe(false);
        });
    });

    it('maps formats to content types', () => {
        expect(screenshotContentType('png')).toBe('image/png');
        expect(screenshotContentType('jpg')).toBe('image/jpeg');
        expect(screenshotContentType('jpeg')).toBe('image/jpeg');
        expect(screenshotContentType('webp')).toBe('image/webp');
    });
});
