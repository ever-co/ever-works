import { describe, expect, it } from 'vitest';
import {
    DEFAULT_REPO_URL,
    buildGitHubLinks,
    buildLearnMoreLinks,
    isEverHostedDeployment,
    isEverOwnedUrl,
    compareBuilds,
    environmentFromBuildRef,
    environmentFromWebUrl,
    normalizeEnvironmentName,
    resolveDeploymentEnvironment,
    resolveDisplayApiAddress,
} from './about-info';

describe('normalizeEnvironmentName', () => {
    it.each([
        ['prod', 'prod'],
        ['Production', 'prod'],
        ['staging', 'stage'],
        ['stage', 'stage'],
        ['development', 'dev'],
        ['dev', 'dev'],
        ['local', 'local'],
    ])('%s → %s', (input, expected) => {
        expect(normalizeEnvironmentName(input)).toBe(expected);
    });

    it('answers null for an empty or unknown label', () => {
        expect(normalizeEnvironmentName(undefined)).toBeNull();
        expect(normalizeEnvironmentName('   ')).toBeNull();
        expect(normalizeEnvironmentName('qa')).toBeNull();
    });
});

describe('environmentFromBuildRef', () => {
    it.each([
        ['develop', 'dev'],
        ['stage', 'stage'],
        ['main', 'prod'],
        ['master', 'prod'],
        ['v1.4.0', 'prod'],
    ])('%s → %s', (ref, expected) => {
        expect(environmentFromBuildRef(ref)).toBe(expected);
    });

    it('says nothing for a feature branch or no ref', () => {
        expect(environmentFromBuildRef('feat/web-about')).toBeNull();
        expect(environmentFromBuildRef('')).toBeNull();
        expect(environmentFromBuildRef('local')).toBeNull();
    });
});

describe('environmentFromWebUrl', () => {
    it.each([
        ['https://app-dev.ever.works', 'dev'],
        ['https://appdev.ever.works', 'dev'],
        ['http://ever-works-app-dev.192.168.1.180.nip.io', 'dev'],
        ['https://app-stage.ever.works', 'stage'],
        ['https://appstage.ever.works', 'stage'],
        ['http://localhost:3000', 'local'],
        ['http://127.0.0.1:3000', 'local'],
    ])('%s → %s', (url, expected) => {
        expect(environmentFromWebUrl(url)).toBe(expected);
    });

    it('says nothing for a production or self-hosted domain, or a malformed URL', () => {
        expect(environmentFromWebUrl('https://app.ever.works')).toBeNull();
        expect(environmentFromWebUrl('https://works.example.com')).toBeNull();
        expect(environmentFromWebUrl('not a url')).toBeNull();
    });
});

describe('resolveDeploymentEnvironment', () => {
    it('lets an explicit override win', () => {
        expect(
            resolveDeploymentEnvironment({
                override: 'staging',
                webUrl: 'https://app-dev.ever.works',
                buildRef: 'main',
            }),
        ).toBe('stage');
    });

    it('prefers what the web address says over the build ref', () => {
        expect(
            resolveDeploymentEnvironment({
                webUrl: 'https://app-stage.ever.works',
                buildRef: 'develop',
            }),
        ).toBe('stage');
    });

    it('falls back to the build ref when the host says nothing (production)', () => {
        expect(
            resolveDeploymentEnvironment({ webUrl: 'https://app.ever.works', buildRef: 'main' }),
        ).toBe('prod');
    });

    it('answers null when nothing says', () => {
        expect(resolveDeploymentEnvironment({ webUrl: 'https://works.example.com' })).toBeNull();
    });
});

describe('resolveDisplayApiAddress', () => {
    it('shows the browser-facing URL when one is set, without a trailing slash', () => {
        expect(
            resolveDisplayApiAddress({
                publicApiUrl: 'https://api.ever.works/api/',
                serverApiUrl: 'http://ever-works-api:3100/api',
            }),
        ).toBe('https://api.ever.works/api');
    });

    it('shows a public server URL as is', () => {
        expect(resolveDisplayApiAddress({ serverApiUrl: 'https://api.example.com/api' })).toBe(
            'https://api.example.com/api',
        );
        expect(resolveDisplayApiAddress({ serverApiUrl: 'http://localhost:3100/api' })).toBe(
            'http://localhost:3100/api',
        );
    });

    it('never shows a cluster-internal address; uses the api sibling of the web host instead', () => {
        expect(
            resolveDisplayApiAddress({
                serverApiUrl: 'http://ever-works-api:3100/api',
                webUrl: 'https://app-dev.ever.works',
            }),
        ).toBe('https://api-dev.ever.works/api');
        expect(
            resolveDisplayApiAddress({
                serverApiUrl:
                    'http://ever-works-api.ever-works-app-prod.svc.cluster.local:3100/api',
                webUrl: 'https://app.ever.works',
            }),
        ).toBe('https://api.ever.works/api');
    });

    it('answers null when no public address can be derived', () => {
        expect(
            resolveDisplayApiAddress({
                serverApiUrl: 'http://ever-works-api:3100/api',
                webUrl: 'https://works.example.com',
            }),
        ).toBeNull();
        expect(resolveDisplayApiAddress({})).toBeNull();
    });
});

describe('compareBuilds', () => {
    const sha = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

    it('is in sync when both sides report the same commit, short or full', () => {
        expect(compareBuilds({ gitSha: sha }, { gitSha: sha })).toBe('in-sync');
        expect(compareBuilds({ gitSha: sha }, { gitSha: sha.slice(0, 7).toUpperCase() })).toBe(
            'in-sync',
        );
    });

    it('reports different commits', () => {
        expect(
            compareBuilds({ gitSha: sha }, { gitSha: 'ffffffffffffffffffffffffffffffffffffffff' }),
        ).toBe('different');
    });

    it('is unknown for a local build or a missing API answer', () => {
        expect(compareBuilds({ gitSha: 'dev' }, { gitSha: 'dev' })).toBe('unknown');
        expect(compareBuilds({ gitSha: sha }, null)).toBe('unknown');
        expect(compareBuilds({ gitSha: sha }, { gitSha: 'dev' })).toBe('unknown');
    });
});

describe('buildGitHubLinks', () => {
    it('builds every link from the canonical repository by default', () => {
        expect(buildGitHubLinks(undefined)).toEqual({
            repository: DEFAULT_REPO_URL,
            releases: `${DEFAULT_REPO_URL}/releases`,
            issues: `${DEFAULT_REPO_URL}/issues`,
            pullRequests: `${DEFAULT_REPO_URL}/pulls`,
            contributors: `${DEFAULT_REPO_URL}/graphs/contributors`,
            contributingGuide: `${DEFAULT_REPO_URL}/blob/develop/.github/CONTRIBUTING.MD`,
            license: `${DEFAULT_REPO_URL}/blob/develop/LICENSE`,
        });
    });

    it('follows a fork override and drops a trailing slash', () => {
        expect(buildGitHubLinks('https://github.com/acme/works/').issues).toBe(
            'https://github.com/acme/works/issues',
        );
    });
});

describe('isEverOwnedUrl', () => {
    it.each([
        'https://ever.works',
        'https://docs.ever.works/docs',
        'https://ever.co/contacts',
        'https://app.gauzy.co',
        'https://www.githands.com',
    ])('%s is Ever-owned', (url) => {
        expect(isEverOwnedUrl(url)).toBe(true);
    });

    it.each([
        'https://github.com/ever-co/ever-works',
        'https://notever.works',
        'https://ever.works.example.com',
        'not a url',
        undefined,
    ])('%s is not', (url) => {
        expect(isEverOwnedUrl(url)).toBe(false);
    });
});

describe('isEverHostedDeployment', () => {
    it('is true only for ever.works and its subdomains', () => {
        expect(isEverHostedDeployment('https://app.ever.works')).toBe(true);
        expect(isEverHostedDeployment('https://app-dev.ever.works')).toBe(true);
        expect(isEverHostedDeployment('http://ever-works-web:3000')).toBe(false);
        expect(isEverHostedDeployment('http://localhost:3000')).toBe(false);
        expect(isEverHostedDeployment('https://app.gauzy.co')).toBe(false);
        expect(isEverHostedDeployment(undefined)).toBe(false);
    });
});

describe('buildLearnMoreLinks', () => {
    it("links to Ever's website, docs and company on Ever's hosted app", () => {
        expect(buildLearnMoreLinks({ webUrl: 'https://app.ever.works' })).toEqual([
            { id: 'website', href: 'https://ever.works' },
            { id: 'docs', href: 'https://docs.ever.works' },
            { id: 'company', href: 'https://ever.co' },
        ]);
    });

    it('renders no Ever link on a self-hosted install, even with the default owner site', () => {
        expect(
            buildLearnMoreLinks({
                webUrl: 'http://ever-works-web:3000',
                companyOwnerWebsite: 'https://ever.works',
                companyOwnerName: 'Ever Co. LTD',
            }),
        ).toEqual([]);
        expect(buildLearnMoreLinks({ webUrl: 'http://localhost:3000' })).toEqual([]);
    });

    it("shows a self-hosted operator's own http(s) site, with its name when set", () => {
        expect(
            buildLearnMoreLinks({
                webUrl: 'https://works.acme.test',
                companyOwnerWebsite: ' https://acme.test ',
                companyOwnerName: 'Acme Inc.',
            }),
        ).toEqual([{ id: 'company', href: 'https://acme.test', label: 'Acme Inc.' }]);
        expect(
            buildLearnMoreLinks({
                webUrl: 'https://works.acme.test',
                companyOwnerWebsite: 'https://acme.test',
            }),
        ).toEqual([{ id: 'company', href: 'https://acme.test' }]);
    });

    it('drops an operator site that is not an http(s) URL', () => {
        expect(
            buildLearnMoreLinks({
                webUrl: 'https://works.acme.test',
                companyOwnerWebsite: 'javascript:alert(1)',
            }),
        ).toEqual([]);
        expect(
            buildLearnMoreLinks({
                webUrl: 'https://works.acme.test',
                companyOwnerWebsite: 'acme.test',
            }),
        ).toEqual([]);
    });
});
