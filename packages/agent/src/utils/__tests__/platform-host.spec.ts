import { Logger } from '@nestjs/common';

import { config } from '../../config';
import {
    PLATFORM_DOMAIN_NOT_ALLOWED,
    PlatformDomainNotAllowedError,
    assertNotPlatformHost,
    isPlatformDomainNotAllowedError,
    isPlatformOwnedHost,
    matchPlatformRootDomain,
    normalizePlatformHost,
    platformDomainNotAllowedBody,
    platformDomainRefusalMessage,
    platformIngressHostRefusalMessage,
} from '../platform-host';

describe('platform-host — custom domains under the platform root domains', () => {
    const roots = ['ever.works'];

    describe('isPlatformOwnedHost', () => {
        it('refuses the root itself', () => {
            expect(isPlatformOwnedHost('ever.works', roots)).toBe(true);
        });

        it('refuses a subdomain at any depth', () => {
            expect(isPlatformOwnedHost('login.ever.works', roots)).toBe(true);
            expect(isPlatformOwnedHost('a.b.ever.works', roots)).toBe(true);
        });

        it('ignores case, surrounding whitespace and a trailing dot', () => {
            expect(isPlatformOwnedHost('LOGIN.Ever.Works', roots)).toBe(true);
            expect(isPlatformOwnedHost('  login.ever.works  ', roots)).toBe(true);
            expect(isPlatformOwnedHost('login.ever.works.', roots)).toBe(true);
            expect(isPlatformOwnedHost('ever.works.', roots)).toBe(true);
        });

        it('normalizes the root the same way', () => {
            expect(isPlatformOwnedHost('login.ever.works', [' Ever.Works. '])).toBe(true);
            expect(isPlatformOwnedHost('login.ever.works', ['.ever.works'])).toBe(true);
        });

        it('does not refuse a lookalike that is not under the root', () => {
            expect(isPlatformOwnedHost('evil-ever.works', roots)).toBe(false);
            expect(isPlatformOwnedHost('everworks', roots)).toBe(false);
            expect(isPlatformOwnedHost('ever.works.evil.com', roots)).toBe(false);
            expect(isPlatformOwnedHost('login.ever.works.evil.com', roots)).toBe(false);
            expect(isPlatformOwnedHost('notever.works', roots)).toBe(false);
            expect(isPlatformOwnedHost('example.com', roots)).toBe(false);
        });

        it('ignores an unset or empty root instead of matching everything', () => {
            expect(isPlatformOwnedHost('example.com', [undefined])).toBe(false);
            expect(isPlatformOwnedHost('example.com', [null])).toBe(false);
            expect(isPlatformOwnedHost('example.com', [''])).toBe(false);
            expect(isPlatformOwnedHost('example.com', ['   '])).toBe(false);
            expect(isPlatformOwnedHost('example.com', ['...'])).toBe(false);
            expect(isPlatformOwnedHost('example.com', [])).toBe(false);
            // A blank root never shadows a real one after it.
            expect(isPlatformOwnedHost('login.ever.works', ['', undefined, 'ever.works'])).toBe(
                true,
            );
        });

        it('checks every root (the platform domain and the apps domains)', () => {
            const all = ['ever.works', 'ever.app'];
            expect(isPlatformOwnedHost('login.ever.app', all)).toBe(true);
            expect(isPlatformOwnedHost('ever.app', all)).toBe(true);
            expect(isPlatformOwnedHost('evil-ever.app', all)).toBe(false);
        });

        it('never refuses an empty or non-string host', () => {
            expect(isPlatformOwnedHost('', roots)).toBe(false);
            expect(isPlatformOwnedHost('   ', roots)).toBe(false);
            expect(isPlatformOwnedHost(undefined, roots)).toBe(false);
            expect(isPlatformOwnedHost(42, roots)).toBe(false);
        });
    });

    describe('matchPlatformRootDomain', () => {
        it('answers the normalized root that matched, or null', () => {
            expect(matchPlatformRootDomain('Login.Ever.App.', ['ever.works', 'Ever.App'])).toBe(
                'ever.app',
            );
            expect(matchPlatformRootDomain('example.com', ['ever.works'])).toBeNull();
        });
    });

    describe('normalizePlatformHost', () => {
        it('lowercases, trims and strips edge dots in linear time', () => {
            expect(normalizePlatformHost('  ..Login.Ever.Works..  ')).toBe('login.ever.works');
            expect(normalizePlatformHost(null)).toBe('');
            const dots = '.'.repeat(50_000);
            expect(normalizePlatformHost(`${dots}x${dots}`)).toBe('x');
        });
    });

    describe('assertNotPlatformHost', () => {
        it('throws PlatformDomainNotAllowedError with the code, root and message', () => {
            let caught: unknown;
            try {
                assertNotPlatformHost('Login.Ever.Works', roots);
            } catch (error) {
                caught = error;
            }

            expect(caught).toBeInstanceOf(PlatformDomainNotAllowedError);
            expect(caught).toMatchObject({
                code: PLATFORM_DOMAIN_NOT_ALLOWED,
                domain: 'login.ever.works',
                root: 'ever.works',
                message:
                    "Domains under ever.works can't be added as a custom domain. Use the managed subdomain setting instead.",
            });
            expect(isPlatformDomainNotAllowedError(caught)).toBe(true);
        });

        it('lets a host outside every root through', () => {
            expect(() => assertNotPlatformHost('tools.example.com', roots)).not.toThrow();
        });
    });

    describe('isPlatformDomainNotAllowedError', () => {
        it('recognises the code on a copy of the error and nothing else', () => {
            expect(
                isPlatformDomainNotAllowedError({
                    code: PLATFORM_DOMAIN_NOT_ALLOWED,
                    root: 'ever.works',
                }),
            ).toBe(true);
            expect(isPlatformDomainNotAllowedError(new Error('boom'))).toBe(false);
            expect(isPlatformDomainNotAllowedError({ code: 'OTHER', root: 'x' })).toBe(false);
            expect(isPlatformDomainNotAllowedError(null)).toBe(false);
        });
    });

    describe('IDNA normalization (review M2)', () => {
        it('maps fullwidth and ideographic dots to ASCII before matching', () => {
            expect(isPlatformOwnedHost('login．ever．works', roots)).toBe(true);
            expect(isPlatformOwnedHost('login。ever。works', roots)).toBe(true);
            expect(isPlatformOwnedHost('login．ever．works．', roots)).toBe(true);
            expect(normalizePlatformHost('LOGIN。Ever。Works')).toBe('login.ever.works');
        });

        it('compares a Unicode label in its punycode form', () => {
            expect(normalizePlatformHost('Bücher.Ever.Works')).toBe('xn--bcher-kva.ever.works');
            expect(isPlatformOwnedHost('bücher.ever.works', roots)).toBe(true);
            expect(isPlatformOwnedHost('xn--bcher-kva.ever.works', roots)).toBe(true);
        });

        it('keeps a value IDNA cannot convert, lowercased, instead of dropping it', () => {
            expect(normalizePlatformHost('A B.Ever.Works')).toBe('a b.ever.works');
            expect(isPlatformOwnedHost('a b.ever.works', roots)).toBe(true);
            expect(normalizePlatformHost('Ever.Works:443')).toBe('ever.works:443');
        });
    });

    describe('platformDomainNotAllowedBody', () => {
        it('is the one coded 400 body, with the custom-domain sentence by default', () => {
            expect(platformDomainNotAllowedBody('ever.works')).toEqual({
                status: 'error',
                code: PLATFORM_DOMAIN_NOT_ALLOWED,
                message:
                    "Domains under ever.works can't be added as a custom domain. Use the managed subdomain setting instead.",
            });
        });

        it('takes the ingress-host sentence for the k8s setting', () => {
            expect(
                platformDomainNotAllowedBody(
                    'ever.app',
                    platformIngressHostRefusalMessage('ever.app'),
                ),
            ).toEqual({
                status: 'error',
                code: PLATFORM_DOMAIN_NOT_ALLOWED,
                message:
                    "Hosts under ever.app can't be used as the default ingress host. Use the managed subdomain setting instead.",
            });
        });
    });

    it('words the refusal generically, naming only the root', () => {
        expect(platformDomainRefusalMessage('ever.app')).toBe(
            "Domains under ever.app can't be added as a custom domain. Use the managed subdomain setting instead.",
        );
    });
});

describe('config.everWorks.platformRootDomains', () => {
    const NAMES = [
        'EVER_WORKS_DOMAIN',
        'EVER_WORKS_APPS_DOMAIN',
        'EVER_WORKS_APPS_MANAGED_DOMAIN',
    ] as const;
    const original: Record<string, string | undefined> = {};

    beforeEach(() => {
        // The apps-domain getter logs its own decisions; they are not under test here.
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        for (const name of NAMES) {
            original[name] = process.env[name];
            delete process.env[name];
        }
    });

    afterEach(() => {
        jest.restoreAllMocks();
        for (const name of NAMES) {
            if (original[name] === undefined) delete process.env[name];
            else process.env[name] = original[name];
        }
    });

    it('uses the documented ever.works default when EVER_WORKS_DOMAIN is unset', () => {
        expect(config.everWorks.platformRootDomains()).toEqual(['ever.works']);
    });

    it('uses EVER_WORKS_DOMAIN, normalized', () => {
        process.env.EVER_WORKS_DOMAIN = ' Preview.Ever.Works. ';
        expect(config.everWorks.platformRootDomains()).toEqual(['preview.ever.works']);
    });

    it('adds the apps domain and the managed App apex when they differ (prod shape)', () => {
        process.env.EVER_WORKS_DOMAIN = 'ever.works';
        process.env.EVER_WORKS_APPS_MANAGED_DOMAIN = 'ever.app';
        expect(config.everWorks.platformRootDomains()).toEqual(['ever.works', 'ever.app']);

        process.env.EVER_WORKS_APPS_DOMAIN = 'apps.example.com';
        expect(config.everWorks.platformRootDomains()).toEqual([
            'ever.works',
            'apps.example.com',
            'ever.app',
        ]);
    });

    it('skips an apps domain the config refuses (null) rather than matching on it', () => {
        process.env.EVER_WORKS_DOMAIN = 'ever.works';
        process.env.EVER_WORKS_APPS_DOMAIN = 'https://bad/apex';
        expect(config.everWorks.platformRootDomains()).toEqual(['ever.works']);
    });
});
