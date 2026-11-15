import { describe, expect, it } from 'vitest';
import { normalizeEverPlatformInstallId } from '@ever-works/contracts';
import {
    BLUEPRINT_HANDOFF_SWITCH,
    blueprintHandoffEntries,
    blueprintHandoffFormHref,
    blueprintHandoffSignInHref,
    isBlueprintHandoffEnabled,
    marketplaceInstallClaim,
    normalizeInstallId,
    organizationOfEverOrg,
    readBlueprintHandoff,
    readEnabledBlueprintHandoff,
} from './blueprint-handoff.shared';

/**
 * The address a marketplace install sends a person to
 * (`/new?type=app&blueprint=…&ever_org=…&install=…`): what is read of it, what
 * is ignored, and how it travels through sign-in and on to the create form.
 */
const INSTALL = '01JC5R7Y6K1M9E0V3Q2A8XW4TB';
const EVER_ORG = '01JMQCK0RG000000000000000A';

const query = (entries: Record<string, string>) => new URLSearchParams(entries);
/** The web app's environment with the hand-off switched on. */
const ON = { EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED: 'true' };

describe('the switch', () => {
    it('is off by default and on only with `true`', () => {
        expect(BLUEPRINT_HANDOFF_SWITCH).toBe('EVER_CONNECT_BLUEPRINT_HANDOFF_ENABLED');
        expect(isBlueprintHandoffEnabled({})).toBe(false);
        for (const value of ['', ' ', 'false', '1', 'yes', 'on', 'enabled']) {
            expect(isBlueprintHandoffEnabled({ [BLUEPRINT_HANDOFF_SWITCH]: value })).toBe(false);
        }
        expect(isBlueprintHandoffEnabled(ON)).toBe(true);
        expect(isBlueprintHandoffEnabled({ [BLUEPRINT_HANDOFF_SWITCH]: ' TRUE ' })).toBe(true);
        // Another Ever Connect switch does not turn it on.
        expect(isBlueprintHandoffEnabled({ EVER_CONNECT_ENABLED: 'true' })).toBe(false);
    });

    it('off, an address carries no hand-off for the pages, whatever it says', () => {
        const address = { blueprint: 'cal-diy', install: INSTALL, ever_org: EVER_ORG };
        expect(readEnabledBlueprintHandoff(address, {})).toBeNull();
        expect(
            readEnabledBlueprintHandoff(address, { [BLUEPRINT_HANDOFF_SWITCH]: 'false' }),
        ).toBeNull();
        expect(readEnabledBlueprintHandoff(address, ON)).toEqual({
            blueprint: 'cal-diy',
            install: INSTALL,
            everOrg: EVER_ORG,
        });
        // On, an address without a Blueprint is still not one.
        expect(readEnabledBlueprintHandoff({ install: INSTALL }, ON)).toBeNull();
    });

    it('off, a signed-out visitor is sent to sign in as always: nothing to come back to', () => {
        const address = query({ type: 'app', blueprint: 'cal-diy', install: INSTALL });
        expect(blueprintHandoffSignInHref('/new', address, {})).toBeNull();
        expect(
            blueprintHandoffSignInHref('/new', address, { [BLUEPRINT_HANDOFF_SWITCH]: '1' }),
        ).toBeNull();
        expect(blueprintHandoffSignInHref('/new', address, ON)).not.toBeNull();
    });
});

describe('readBlueprintHandoff', () => {
    it('reads the Blueprint, the install and the Ever organization', () => {
        const expected = { blueprint: 'cal-diy', install: INSTALL, everOrg: EVER_ORG };
        expect(
            readBlueprintHandoff({ blueprint: 'cal-diy', install: INSTALL, ever_org: EVER_ORG }),
        ).toEqual(expected);
        // The same from a query string, whatever the order of its keys.
        expect(
            readBlueprintHandoff(
                query({ install: INSTALL, type: 'app', ever_org: EVER_ORG, blueprint: 'cal-diy' }),
            ),
        ).toEqual(expected);
    });

    it('a Blueprint alone is a hand-off; an Ever organization may be a handle', () => {
        expect(readBlueprintHandoff({ blueprint: 'cal-diy' })).toEqual({
            blueprint: 'cal-diy',
            install: null,
            everOrg: null,
        });
        expect(readBlueprintHandoff({ blueprint: ' cal-diy ', ever_org: 'Acme.Inc' })).toEqual({
            blueprint: 'cal-diy',
            install: null,
            everOrg: 'Acme.Inc',
        });
    });

    it('an install id is read in its canonical spelling', () => {
        expect(
            readBlueprintHandoff({ blueprint: 'cal-diy', install: ` ${INSTALL.toLowerCase()} ` }),
        ).toMatchObject({ install: INSTALL });
    });

    it.each([
        ['none', {}],
        ['an empty one', { blueprint: '' }],
        ['an address', { blueprint: 'https://github.com/calcom/cal.diy' }],
        ['a repository', { blueprint: 'calcom/cal.diy' }],
        ['upper case', { blueprint: 'Cal-DIY' }],
        ['a path', { blueprint: '../../etc/passwd' }],
        ['markup', { blueprint: '<script>alert(1)</script>' }],
        ['one that is too long', { blueprint: 'a'.repeat(101) }],
        ['one given twice', { blueprint: ['cal-diy', 'umami'] }],
    ])('without a Blueprint spelled like one there is no hand-off (%s)', (_name, params) => {
        expect(
            readBlueprintHandoff({ install: INSTALL, ever_org: EVER_ORG, ...params }),
        ).toBeNull();
    });

    it('leaves out an install or an Ever organization that is not spelled like one', () => {
        for (const install of ['', 'install-1', `${INSTALL}0`, 'https://evil.example/x']) {
            expect(readBlueprintHandoff({ blueprint: 'cal-diy', install })).toMatchObject({
                install: null,
            });
        }
        for (const everOrg of ['', '-acme', 'a b', 'acme/../x', 'a'.repeat(65), '<b>acme</b>']) {
            expect(readBlueprintHandoff({ blueprint: 'cal-diy', ever_org: everOrg })).toMatchObject(
                {
                    everOrg: null,
                },
            );
        }
    });
});

describe('normalizeInstallId', () => {
    it("agrees with the contract package's own reading of an install id", () => {
        for (const value of [
            INSTALL,
            INSTALL.toLowerCase(),
            ` ${INSTALL} `,
            '',
            'install-1',
            `${INSTALL}0`,
            INSTALL.slice(0, 25),
            // The letters I, L, O and U never appear in an id.
            `${INSTALL.slice(0, 25)}U`,
            'x'.repeat(65),
            null,
            undefined,
            42,
            {},
        ]) {
            expect(normalizeInstallId(value)).toBe(normalizeEverPlatformInstallId(value));
        }
        expect(normalizeInstallId(INSTALL.toLowerCase())).toBe(INSTALL);
    });
});

describe('where a hand-off goes', () => {
    const handoff = { blueprint: 'cal-diy', install: INSTALL, everOrg: EVER_ORG };

    it('travels as its own entries, in a fixed order, without what it does not have', () => {
        expect(blueprintHandoffEntries(handoff)).toEqual([
            ['blueprint', 'cal-diy'],
            ['ever_org', EVER_ORG],
            ['install', INSTALL],
        ]);
        expect(
            blueprintHandoffEntries({ blueprint: 'cal-diy', install: null, everOrg: null }),
        ).toEqual([['blueprint', 'cal-diy']]);
    });

    it('opens the App create form with the Blueprint, the install and the Ever organization', () => {
        expect(blueprintHandoffFormHref(handoff)).toBe(
            `/works/new?mode=manual&kind=app&blueprint=cal-diy&ever_org=${EVER_ORG}&install=${INSTALL}`,
        );
        expect(
            blueprintHandoffFormHref({ blueprint: 'cal-diy', install: null, everOrg: null }),
        ).toBe('/works/new?mode=manual&kind=app&blueprint=cal-diy');
    });
});

describe('blueprintHandoffSignInHref — a signed-out visitor comes back to the same hand-off', () => {
    /** The address sign-in is told to come back to. */
    const back = (pathname: string, entries: Record<string, string>) => {
        const href = blueprintHandoffSignInHref(pathname, query(entries), ON);
        if (href === null) return null;
        const url = new URL(href, 'https://works.example.test');
        expect(url.pathname).toBe('/login');
        expect([...url.searchParams.keys()]).toEqual(['redirect_uri']);
        return url.searchParams.get('redirect_uri');
    };

    it('keeps the Blueprint, the install and the Ever organization through sign-in', () => {
        expect(
            back('/new', {
                type: 'app',
                blueprint: 'cal-diy',
                ever_org: EVER_ORG,
                install: INSTALL,
            }),
        ).toBe(`/new?type=app&blueprint=cal-diy&ever_org=${EVER_ORG}&install=${INSTALL}`);
        expect(back('/new', { type: 'APP', blueprint: 'cal-diy' })).toBe(
            '/new?type=app&blueprint=cal-diy',
        );
    });

    it('the create form itself, and a workspace, come back as they were asked for', () => {
        expect(back('/works/new', { kind: 'app', blueprint: 'cal-diy', install: INSTALL })).toBe(
            `/works/new?mode=manual&kind=app&blueprint=cal-diy&install=${INSTALL}`,
        );
        expect(back('/org/acme/new', { type: 'app', blueprint: 'cal-diy' })).toBe(
            '/org/acme/new?type=app&blueprint=cal-diy',
        );
        expect(back('/org/acme-inc/works/new', { kind: 'app', blueprint: 'cal-diy' })).toBe(
            '/org/acme-inc/works/new?mode=manual&kind=app&blueprint=cal-diy',
        );
    });

    it('carries nothing through sign-in but the hand-off itself', () => {
        const target = back('/new', {
            type: 'app',
            blueprint: 'cal-diy',
            install: 'not-an-install',
            ever_org: '<b>',
            redirect_uri: 'https://evil.example',
            next: '//evil.example',
            template: 'x',
            prompt: 'https://token@github.com/x/y',
            access_token: 'secret',
        });
        expect(target).toBe('/new?type=app&blueprint=cal-diy');
    });

    it.each([
        ['another page', '/works', { kind: 'app', blueprint: 'cal-diy' }],
        ['the dashboard', '/', { type: 'app', blueprint: 'cal-diy' }],
        [
            'a page under the create form',
            '/works/new/campaign',
            { kind: 'app', blueprint: 'cal-diy' },
        ],
        ['another kind', '/new', { type: 'mission', blueprint: 'cal-diy' }],
        ['no kind', '/new', { blueprint: 'cal-diy' }],
        ['the kind of the other page', '/new', { kind: 'app', blueprint: 'cal-diy' }],
        ['no Blueprint', '/new', { type: 'app', install: INSTALL, ever_org: EVER_ORG }],
        ['a Blueprint that is not one', '/new', { type: 'app', blueprint: 'https://x.test' }],
        ['a workspace that is not one', '/org/Acme_Inc/new', { type: 'app', blueprint: 'cal-diy' }],
        [
            'a path that leaves the site',
            '//evil.example/new',
            { type: 'app', blueprint: 'cal-diy' },
        ],
        ['a backslash path', '/\\evil.example/new', { type: 'app', blueprint: 'cal-diy' }],
    ])(
        'is not a hand-off: %s (sign-in then goes where it always did)',
        (_name, pathname, entries) => {
            expect(blueprintHandoffSignInHref(pathname, query(entries), ON)).toBeNull();
        },
    );
});

describe('organizationOfEverOrg', () => {
    const organizations = [
        { slug: 'acme', everOrgId: EVER_ORG, handle: 'acme-inc' },
        { slug: 'globex', everOrgId: '01JMQCK0RG000000000000000B', handle: 'Globex' },
        { slug: 'not-linked', everOrgId: null, handle: null },
    ];

    it("finds the person's Organization linked to the Ever organization, by id or by handle", () => {
        expect(organizationOfEverOrg(EVER_ORG, organizations)?.slug).toBe('acme');
        expect(organizationOfEverOrg('acme-inc', organizations)?.slug).toBe('acme');
        expect(organizationOfEverOrg('GLOBEX', organizations)?.slug).toBe('globex');
    });

    it('answers nothing when none is linked to it, or when it cannot tell which', () => {
        expect(organizationOfEverOrg('01JMQCK0RG000000000000000Z', organizations)).toBeNull();
        expect(organizationOfEverOrg('initech', organizations)).toBeNull();
        expect(organizationOfEverOrg(EVER_ORG, [])).toBeNull();
        // An id is compared exactly: its lower-case spelling is not the id.
        expect(organizationOfEverOrg(EVER_ORG.toLowerCase(), organizations)).toBeNull();
        expect(
            organizationOfEverOrg('acme-inc', [
                ...organizations,
                { slug: 'acme-two', everOrgId: null, handle: 'ACME-INC' },
            ]),
        ).toBeNull();
    });
});

/**
 * What the create action lets through of a marketplace install. The install id
 * is a claim that came in an address, and a server action can be called with
 * any body: this rule, not the form, decides what is sent on.
 */
describe('marketplaceInstallClaim — what a create request may carry of an install', () => {
    const request = (overrides: Record<string, unknown> = {}) => ({
        kind: 'app',
        blueprintId: 'cal-diy',
        installId: INSTALL,
        everOrg: EVER_ORG,
        ...overrides,
    });

    it('lets the install through with its Ever organization, for an App made from a Blueprint', () => {
        expect(marketplaceInstallClaim(request(), ON)).toEqual({
            installId: INSTALL,
            everOrg: EVER_ORG,
        });
        // A handle names an Ever organization as well as its id does.
        expect(marketplaceInstallClaim(request({ everOrg: ' acme ' }), ON)).toEqual({
            installId: INSTALL,
            everOrg: 'acme',
        });
        // One spelling of the install id.
        expect(
            marketplaceInstallClaim(request({ installId: ` ${INSTALL.toLowerCase()} ` }), ON),
        ).toEqual({ installId: INSTALL, everOrg: EVER_ORG });
    });

    it.each([
        ['unset', {}],
        ['`false`', { [BLUEPRINT_HANDOFF_SWITCH]: 'false' }],
        ['a value that is not `true`', { [BLUEPRINT_HANDOFF_SWITCH]: '1' }],
        ['another Ever Connect switch', { EVER_CONNECT_ENABLED: 'true' }],
    ])('lets nothing through with the switch %s, whatever was sent', (_name, env) => {
        expect(marketplaceInstallClaim(request(), env)).toBeNull();
    });

    it.each([
        ['a generated site', { kind: 'website' }],
        ['a repository Work', { kind: 'repo' }],
        ['a request that names no kind', { kind: undefined }],
        ['an App that is not made from a Blueprint', { blueprintId: undefined }],
        ['an empty Blueprint id', { blueprintId: '' }],
        ['a Blueprint id that is not one', { blueprintId: 'calcom/cal.diy' }],
        ['a Blueprint id that is not text', { blueprintId: 42 }],
        ['no install id', { installId: undefined }],
        ['an install id that is not one', { installId: 'install-1' }],
        ['an install id that is too long', { installId: `${INSTALL}0` }],
        ['an install id that is not text', { installId: 42 }],
        // One without the other binds nothing.
        ['an install without its Ever organization', { everOrg: undefined }],
        ['an empty Ever organization', { everOrg: '  ' }],
        ['an Ever organization that is not one', { everOrg: 'acme corp' }],
        ['an Ever organization that is an address', { everOrg: 'https://x.test/acme' }],
        ['an Ever organization that is too long', { everOrg: 'a'.repeat(65) }],
        ['an Ever organization that is not text', { everOrg: { id: EVER_ORG } }],
        ['an Ever organization without an install', { installId: undefined }],
    ])('lets nothing through for %s (ignored, never an error)', (_name, overrides) => {
        expect(marketplaceInstallClaim(request(overrides), ON)).toBeNull();
    });

    it('reads the switch of this process by default: off unless it is set', () => {
        expect(marketplaceInstallClaim(request(), {})).toBeNull();
    });
});
