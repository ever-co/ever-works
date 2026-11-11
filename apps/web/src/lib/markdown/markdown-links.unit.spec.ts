import { describe, expect, it } from 'vitest';
import { resolveMarkdownHref, resolveMarkdownImageSrc } from './markdown-links';

describe('resolveMarkdownHref', () => {
    it('opens web URLs in a new tab', () => {
        expect(resolveMarkdownHref('https://ever.works/docs')).toEqual({
            href: 'https://ever.works/docs',
            external: true,
        });
        expect(resolveMarkdownHref(' http://localhost:3000/x ')).toEqual({
            href: 'http://localhost:3000/x',
            external: true,
        });
    });

    it('keeps same-origin paths, anchors and mailto in place', () => {
        expect(resolveMarkdownHref('/missions/abc')).toEqual({
            href: '/missions/abc',
            external: false,
        });
        expect(resolveMarkdownHref('#steps')).toEqual({ href: '#steps', external: false });
        expect(resolveMarkdownHref('../tasks')).toEqual({ href: '../tasks', external: false });
        expect(resolveMarkdownHref('mailto:team@ever.co')).toEqual({
            href: 'mailto:team@ever.co',
            external: false,
        });
    });

    it.each([
        'javascript:alert(1)',
        'JavaScript:alert(1)',
        ' javascript:alert(1)',
        'vbscript:msgbox(1)',
        'data:text/html,<script>alert(1)</script>',
        'file:///etc/passwd',
        '//evil.test/x',
        '/\\evil.test',
        '/\t/evil.test',
        'https://github.com@evil.test/',
        'ftp://example.com',
        'relative/path',
        '',
        undefined,
        null,
    ])('refuses %j', (value) => {
        expect(resolveMarkdownHref(value as string | null | undefined)).toBeNull();
    });
});

describe('resolveMarkdownImageSrc', () => {
    it('accepts https and same-origin images only', () => {
        expect(resolveMarkdownImageSrc('https://cdn.test/a.png')).toBe('https://cdn.test/a.png');
        expect(resolveMarkdownImageSrc('/api/uploads/serve/1')).toBe('/api/uploads/serve/1');
        expect(resolveMarkdownImageSrc('http://cdn.test/a.png')).toBeNull();
        expect(resolveMarkdownImageSrc('data:image/svg+xml,<svg onload=alert(1)>')).toBeNull();
        expect(resolveMarkdownImageSrc('javascript:alert(1)')).toBeNull();
        expect(resolveMarkdownImageSrc('//evil.test/a.png')).toBeNull();
    });
});
