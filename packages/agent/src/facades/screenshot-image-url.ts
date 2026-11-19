import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ScreenshotFormat } from '@ever-works/plugin';

/**
 * Signed, public URLs for screenshots whose provider returns image BYTES
 * instead of a URL (the self-hosted Gotenberg plugin).
 *
 * A Work item keeps its preview image as a URL, which the Work's website
 * loads in a browser. SaaS providers (ScreenshotOne, Urlbox) hand back their
 * own signed render URL. A self-hosted renderer sits on the cluster network,
 * so the platform's API serves the image instead:
 *
 *   GET {SCREENSHOT_IMAGE_BASE_URL}/api/screenshot/image/{payload}.{signature}.{ext}
 *
 * `payload` names the provider and the capture options, and `signature` is an
 * HMAC over it, so the route renders only what the platform itself signed —
 * nobody can use it to make the cluster's browser open a URL of their choice.
 * The response is cacheable for a year (the URL never changes meaning), so a
 * CDN in front of the API renders each image once.
 *
 * Configuration (environment, read once):
 * - `SCREENSHOT_IMAGE_BASE_URL` — public origin of this API, e.g.
 *   `https://api.ever.works`. Without it no URL is minted and buffer-only
 *   providers give items no image (the previous behaviour).
 * - `SCREENSHOT_IMAGE_SIGNING_SECRET` — optional; defaults to
 *   `PLATFORM_ENCRYPTION_KEY`, which the API and its Trigger.dev workers
 *   already share. The HMAC key is derived from it with a fixed label, so the
 *   secret itself never signs anything directly.
 */

/** Path of the public route, below the API origin. */
export const SCREENSHOT_IMAGE_ROUTE = '/api/screenshot/image';

/** Derivation label; bump the version to invalidate every minted URL. */
const KEY_LABEL = 'ever-works:screenshot-image-url:v1';
const PAYLOAD_VERSION = 1;

/** Longest `{payload}.{signature}.{ext}` segment accepted. */
export const MAX_SIGNED_IMAGE_SEGMENT_LENGTH = 4096;

const EXTENSION_BY_FORMAT: Record<ScreenshotFormat, string> = {
    png: 'png',
    jpg: 'jpg',
    jpeg: 'jpg',
    webp: 'webp',
};

const CONTENT_TYPE_BY_FORMAT: Record<ScreenshotFormat, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
};

/** What a signed URL asks the route to render. */
export interface SignedScreenshotImage {
    readonly pluginId: string;
    readonly url: string;
    readonly viewportWidth: number;
    readonly viewportHeight: number;
    readonly format: ScreenshotFormat;
    readonly fullPage: boolean;
}

/** The `Content-Type` of a screenshot format. */
export function screenshotContentType(format: ScreenshotFormat): string {
    return CONTENT_TYPE_BY_FORMAT[format];
}

function isFormat(value: unknown): value is ScreenshotFormat {
    return value === 'png' || value === 'jpg' || value === 'jpeg' || value === 'webp';
}

function isDimension(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 10_000;
}

function nonEmpty(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

/**
 * The public origin (+ optional path prefix) without a trailing slash, or
 * `null` when it is unset or not an absolute http(s) URL.
 */
function normalizePublicBaseUrl(raw: string | undefined): string | null {
    const text = nonEmpty(raw);
    if (!text) return null;
    try {
        const parsed = new URL(text);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        if (parsed.username || parsed.password) return null;
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return null;
    }
}

export class ScreenshotImageUrlSigner {
    private readonly publicBaseUrl: string | null;
    private readonly key: Buffer | null;

    /**
     * @param publicBaseUrl public origin of the API (`SCREENSHOT_IMAGE_BASE_URL`)
     * @param secret signing secret; the HMAC key is derived from it
     */
    constructor(publicBaseUrl: string | undefined, secret: string | undefined) {
        this.publicBaseUrl = normalizePublicBaseUrl(publicBaseUrl);
        const secretText = nonEmpty(secret);
        this.key = secretText ? createHmac('sha256', secretText).update(KEY_LABEL).digest() : null;
    }

    static fromEnv(env: NodeJS.ProcessEnv = process.env): ScreenshotImageUrlSigner {
        return new ScreenshotImageUrlSigner(
            env.SCREENSHOT_IMAGE_BASE_URL,
            nonEmpty(env.SCREENSHOT_IMAGE_SIGNING_SECRET) ?? env.PLATFORM_ENCRYPTION_KEY,
        );
    }

    /** Both a public base URL and a signing secret are configured. */
    isEnabled(): boolean {
        return this.publicBaseUrl !== null && this.key !== null;
    }

    /** A signed public URL for `image`, or `null` when signing is not configured. */
    createUrl(image: SignedScreenshotImage): string | null {
        if (!this.publicBaseUrl || !this.key) return null;

        const payload = Buffer.from(
            JSON.stringify([
                PAYLOAD_VERSION,
                image.pluginId,
                image.url,
                Math.round(image.viewportWidth),
                Math.round(image.viewportHeight),
                image.format,
                image.fullPage ? 1 : 0,
            ]),
            'utf8',
        ).toString('base64url');

        const segment = `${payload}.${this.sign(payload)}.${EXTENSION_BY_FORMAT[image.format]}`;
        if (segment.length > MAX_SIGNED_IMAGE_SEGMENT_LENGTH) return null;

        return `${this.publicBaseUrl}${SCREENSHOT_IMAGE_ROUTE}/${segment}`;
    }

    /**
     * The request a `{payload}.{signature}.{ext}` path segment signs, or `null`
     * for anything this signer did not mint (bad shape, wrong signature,
     * extension not matching the format, signing not configured).
     */
    verify(segment: string): SignedScreenshotImage | null {
        if (!this.key || typeof segment !== 'string') return null;
        if (segment.length === 0 || segment.length > MAX_SIGNED_IMAGE_SEGMENT_LENGTH) return null;

        const parts = segment.split('.');
        if (parts.length !== 3) return null;
        const [payload, signature, extension] = parts;
        if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;

        const expected = Buffer.from(this.sign(payload), 'utf8');
        const given = Buffer.from(signature, 'utf8');
        if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

        let decoded: unknown;
        try {
            decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        } catch {
            return null;
        }
        if (!Array.isArray(decoded) || decoded.length !== 7) return null;

        const [version, pluginId, url, width, height, format, fullPage] = decoded as unknown[];
        if (version !== PAYLOAD_VERSION) return null;
        if (typeof pluginId !== 'string' || pluginId.length === 0) return null;
        if (typeof url !== 'string' || url.length === 0) return null;
        if (!isDimension(width) || !isDimension(height)) return null;
        if (!isFormat(format) || EXTENSION_BY_FORMAT[format] !== extension) return null;
        if (fullPage !== 0 && fullPage !== 1) return null;

        return {
            pluginId,
            url,
            viewportWidth: width,
            viewportHeight: height,
            format,
            fullPage: fullPage === 1,
        };
    }

    private sign(payload: string): string {
        return createHmac('sha256', this.key as Buffer)
            .update(payload)
            .digest('base64url');
    }
}
