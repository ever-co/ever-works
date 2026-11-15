import { describe, expect, it } from 'vitest';
import { EVER_ID_RETURN_TO_MAX_LENGTH, toEverIdReturnTo } from './ever-id';
import {
    EVER_ID_START_RETURN_PARAM,
    EVER_ID_START_ROUTE_SWITCH,
    isEverIdStartNavigation,
    isEverIdStartRouteEnabled,
    readEverIdStartReturnPath,
    toEverIdStartReturnPath,
} from './ever-id-start';

/**
 * Ever ID — the rules of the sign-in start address (`/api/auth/ever-id/start`).
 *
 * The address is a link anyone can write, so the return path it names is the
 * one place an open redirect could come from. Every refused shape is pinned
 * here by name: an absolute URL, `//host`, a backslash, a control or invisible
 * character, a dot segment, and each of those behind one or more layers of
 * percent-encoding.
 */

/** Where a browser would end up, were the value sent as a `Location` on this origin. */
const ORIGIN = 'https://app.example';
function landsOn(value: string): string {
    return new URL(value, ORIGIN).origin;
}

describe('isEverIdStartRouteEnabled: off unless exactly `true`', () => {
    it('names the switch once', () => {
        expect(EVER_ID_START_ROUTE_SWITCH).toBe('EVER_ID_START_ROUTE_ENABLED');
    });

    it('is off when the variable is unset', () => {
        expect(isEverIdStartRouteEnabled({})).toBe(false);
    });

    it.each(['true', 'TRUE', 'True', ' true '])('is on for %j', (value) => {
        expect(isEverIdStartRouteEnabled({ EVER_ID_START_ROUTE_ENABLED: value })).toBe(true);
    });

    it.each(['', 'false', '1', 'yes', 'on', 'enabled', 'truee', 'tru e'])(
        'is off for %j',
        (value) => {
            expect(isEverIdStartRouteEnabled({ EVER_ID_START_ROUTE_ENABLED: value })).toBe(false);
        },
    );

    it('reads the process environment by default, per call', () => {
        const saved = process.env.EVER_ID_START_ROUTE_ENABLED;
        try {
            delete process.env.EVER_ID_START_ROUTE_ENABLED;
            expect(isEverIdStartRouteEnabled()).toBe(false);
            process.env.EVER_ID_START_ROUTE_ENABLED = 'true';
            expect(isEverIdStartRouteEnabled()).toBe(true);
        } finally {
            if (saved === undefined) delete process.env.EVER_ID_START_ROUTE_ENABLED;
            else process.env.EVER_ID_START_ROUTE_ENABLED = saved;
        }
    });
});

describe('isEverIdStartNavigation: only a person following a link', () => {
    const request = (headers: Record<string, string> = {}, method = 'GET') => ({
        method,
        headers: new Headers(headers),
    });

    it('accepts a top-level navigation, from this site or another', () => {
        for (const site of ['cross-site', 'same-site', 'same-origin', 'none']) {
            expect(
                isEverIdStartNavigation(
                    request({
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Dest': 'document',
                        'Sec-Fetch-Site': site,
                    }),
                ),
            ).toBe(true);
        }
    });

    it('accepts a client that describes nothing about the request', () => {
        expect(isEverIdStartNavigation(request())).toBe(true);
    });

    it.each(['cors', 'no-cors', 'same-origin', 'websocket'])(
        'refuses a background request (Sec-Fetch-Mode: %s)',
        (mode) => {
            expect(isEverIdStartNavigation(request({ 'Sec-Fetch-Mode': mode }))).toBe(false);
        },
    );

    it.each(['image', 'script', 'iframe', 'frame', 'embed', 'object', 'empty', 'style'])(
        'refuses a load that is not the page itself (Sec-Fetch-Dest: %s)',
        (destination) => {
            expect(
                isEverIdStartNavigation(
                    request({ 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': destination }),
                ),
            ).toBe(false);
        },
    );

    it.each([
        ['Sec-Purpose', 'prefetch'],
        ['Sec-Purpose', 'prefetch;prerender'],
        ['Sec-Purpose', 'prefetch;anonymous-client-ip'],
        ['Purpose', 'prefetch'],
        ['Purpose', 'preview'],
    ])('refuses a load made ahead of a click (%s: %s)', (name, value) => {
        expect(
            isEverIdStartNavigation(
                request({
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Dest': 'document',
                    [name]: value,
                }),
            ),
        ).toBe(false);
    });

    it.each(['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'])('refuses %s', (method) => {
        expect(isEverIdStartNavigation(request({}, method))).toBe(false);
    });
});

describe('toEverIdStartReturnPath: a path of this site, and nothing else', () => {
    it.each([
        '/',
        '/works',
        '/works/42',
        '/org/acme/works/42',
        '/settings/security?tab=a#b',
        '/works/42/kb/legal/privacy.md',
        '/new?type=app&blueprint=my-app&ever_org=acme&install=01ARZ3NDEKTSV4RRFFQ69G5FAV',
        '/works/',
        '/search?q=a%20b',
        '/works?next=%2Fworks%2F42',
    ])('keeps %s', (path) => {
        expect(toEverIdStartReturnPath(path)).toBe(path);
        expect(landsOn(path)).toBe(ORIGIN);
    });

    it('keeps a path that only looks like a host: it stays a path of this site', () => {
        for (const path of ['/evil.example', '/@evil.example', '/works?u=//evil.example']) {
            expect(toEverIdStartReturnPath(path)).toBe(path);
            expect(landsOn(path)).toBe(ORIGIN);
        }
    });

    describe('refuses an absolute URL', () => {
        it.each([
            'https://evil.example/phish',
            'http://evil.example',
            'HTTPS://EVIL.EXAMPLE',
            'https://app.example/works',
            'http://localhost:3000/works',
            'javascript:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'mailto:someone@evil.example',
            'evil.example/works',
            'works',
            '?return=/works',
            '#works',
        ])('%j', (value) => {
            expect(toEverIdStartReturnPath(value)).toBeUndefined();
        });
    });

    describe('refuses `//host` and any empty path segment', () => {
        it.each([
            '//evil.example',
            '//evil.example/works',
            '///evil.example',
            '////evil.example',
            '/works//evil.example',
            '/works//',
        ])('%j', (value) => {
            expect(toEverIdStartReturnPath(value)).toBeUndefined();
        });
    });

    describe('refuses a backslash, wherever it is', () => {
        it.each([
            '/\\evil.example',
            '\\\\evil.example',
            '\\/evil.example',
            '/\\/evil.example',
            '/works\\evil.example',
            '/works?next=\\evil.example',
            '/works#\\evil.example',
        ])('%j', (value) => {
            expect(toEverIdStartReturnPath(value)).toBeUndefined();
        });
    });

    describe('refuses the encoded spellings of all of those, at any depth', () => {
        it.each([
            // `//host` behind one, two and three layers of encoding.
            '/%2Fevil.example',
            '/%2fevil.example',
            '/%2F%2Fevil.example',
            '/%252Fevil.example',
            '/%25252Fevil.example',
            '/works/%2F/evil.example',
            // Not even a path until it is decoded.
            '%2F%2Fevil.example',
            '%2Fworks',
            'https%3A%2F%2Fevil.example',
            // A backslash.
            '/%5Cevil.example',
            '/%5cevil.example',
            '/%255Cevil.example',
            '/works?next=%5Cevil.example',
            // Dot segments.
            '/%2e%2e/evil.example',
            '/%2E%2E%2Fevil.example',
            '/.%2e/evil.example',
            '/works/..%2F..%2Fevil.example',
            '/%252e%252e/evil.example',
            // Control and invisible characters.
            '/%09/evil.example',
            '/%0A/evil.example',
            '/%0d%0aSet-Cookie:%20a=b',
            '/%00',
            '/works%7F',
            '/works%E2%80%8B',
            '/works%E2%80%AE',
            '/works%E2%80%A8',
            '/works%EF%BB%BF',
            '/%2509/evil.example',
        ])('%j', (value) => {
            expect(toEverIdStartReturnPath(value)).toBeUndefined();
        });

        it.each(['/%', '/%2', '/%zz', '/works%', '/%E0%A4%A', '/%ff', '/%C0%AF'])(
            'refuses a malformed escape (%j)',
            (value) => {
                expect(toEverIdStartReturnPath(value)).toBeUndefined();
            },
        );

        it('refuses a value that is still encoded after four layers', () => {
            // `/a b`, encoded n times over: `/a%20b`, `/a%2520b`, `/a%252520b`, …
            const layers = (count: number) => `/a%${'25'.repeat(count - 1)}20b`;

            expect(decodeURIComponent(layers(1))).toBe('/a b');
            for (const count of [1, 2, 3, 4]) {
                expect(toEverIdStartReturnPath(layers(count))).toBe(layers(count));
            }
            for (const count of [5, 6, 12]) {
                expect(toEverIdStartReturnPath(layers(count))).toBeUndefined();
            }
        });
    });

    describe('refuses a control or invisible character, and whitespace', () => {
        it.each([
            // A browser drops a tab or a line break while reading an address:
            // `/<tab>/evil.example` is `//evil.example` to it.
            '/\t/evil.example',
            '/\n/evil.example',
            '/\r/evil.example',
            '/works\r\nSet-Cookie: a=b',
            '/\u0000',
            '/works\u007f',
            '/works​',
            '/works‮',
            '/works ',
            '/works﻿',
            '/has space',
            // Surrounding whitespace is not trimmed away.
            ' /works',
            '/works ',
            '\t/works',
            '/works\n',
            '   ',
            '',
        ])('%j', (value) => {
            expect(toEverIdStartReturnPath(value)).toBeUndefined();
        });

        it('proves the tab case is real: a browser reads it as another host', () => {
            expect(landsOn('/\t/evil.example')).toBe('https://evil.example');
            expect(landsOn('/\\evil.example')).toBe('https://evil.example');
        });
    });

    describe('refuses a dot segment', () => {
        it.each(['/..', '/../works', '/works/../../settings', '/./works', '/works/.', '/works/..'])(
            '%j',
            (value) => {
                expect(toEverIdStartReturnPath(value)).toBeUndefined();
            },
        );
    });

    it('refuses anything outside the characters a path of this site uses', () => {
        for (const value of ['/<script>', '/works"', '/works|x', '/wörks', '/works^', '/{id}']) {
            expect(toEverIdStartReturnPath(value)).toBeUndefined();
        }
    });

    it('refuses a path longer than the sign-in flow carries', () => {
        const longest = '/' + 'a'.repeat(EVER_ID_RETURN_TO_MAX_LENGTH - 1);
        expect(toEverIdStartReturnPath(longest)).toBe(longest);
        expect(toEverIdStartReturnPath(longest + 'a')).toBeUndefined();
    });

    it('refuses anything that is not a string', () => {
        for (const value of [null, undefined, 42, true, {}, ['/works'], () => '/works']) {
            expect(toEverIdStartReturnPath(value)).toBeUndefined();
        }
    });

    it('never accepts what the sign-in flow itself would refuse', () => {
        for (const value of [
            '/works',
            '/works?next=%2Fworks',
            '//evil.example',
            '/\\evil.example',
            ' /works',
            'https://evil.example',
        ]) {
            const accepted = toEverIdStartReturnPath(value);
            if (accepted !== undefined) expect(toEverIdReturnTo(accepted)).toBe(accepted);
        }
    });
});

describe('readEverIdStartReturnPath: the one `return` value of the address', () => {
    const query = (search: string) =>
        new URL(`${ORIGIN}/api/auth/ever-id/start${search}`).searchParams;

    it('names the key once', () => {
        expect(EVER_ID_START_RETURN_PARAM).toBe('return');
    });

    it('is undefined when the address names no path', () => {
        expect(readEverIdStartReturnPath(query(''))).toBeUndefined();
        expect(readEverIdStartReturnPath(query('?other=/works'))).toBeUndefined();
        expect(readEverIdStartReturnPath(query('?return='))).toBeUndefined();
    });

    it('reads a path of this site, written plainly or encoded once as a query value', () => {
        expect(readEverIdStartReturnPath(query('?return=/works/42'))).toBe('/works/42');
        expect(readEverIdStartReturnPath(query('?return=%2Fworks%2F42'))).toBe('/works/42');
        expect(
            readEverIdStartReturnPath(query('?return=%2Fnew%3Ftype%3Dapp%26blueprint%3Dmy-app')),
        ).toBe('/new?type=app&blueprint=my-app');
    });

    it.each([
        '?return=https://evil.example',
        '?return=https%3A%2F%2Fevil.example',
        '?return=//evil.example',
        '?return=%2F%2Fevil.example',
        '?return=%252F%252Fevil.example',
        '?return=/%252Fevil.example',
        '?return=/%5Cevil.example',
        '?return=%2F%5Cevil.example',
        '?return=/%09/evil.example',
        '?return=%2F%09%2Fevil.example',
        '?return=/a+b',
    ])('refuses %s', (search) => {
        expect(readEverIdStartReturnPath(query(search))).toBeUndefined();
    });

    it('refuses a key given twice, whatever the two values are', () => {
        expect(readEverIdStartReturnPath(query('?return=/works&return=/settings'))).toBeUndefined();
        expect(
            readEverIdStartReturnPath(query('?return=/works&return=//evil.example')),
        ).toBeUndefined();
    });
});
