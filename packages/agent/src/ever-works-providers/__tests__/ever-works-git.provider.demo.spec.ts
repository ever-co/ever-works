import { DemoFeatureDisabledError } from '../../demo';
import { EverWorksGitProvider } from '../ever-works-git.provider';
import type { EverWorksProviderWorkRef } from '../types';

/**
 * Platform demo mode — the provider is the last stop before GitHub, so on a demo
 * instance it refuses to create any repository whose name does not start with
 * `DEMO_REPO_PREFIX`: the sweeper deletes only prefixed repositories, and an
 * unprefixed one in the shared customer org would outlive its sandbox.
 */

const ORG = 'ever-works-cloud';

/** A demo instance with no repository ledger bound refuses every create (ruling R22). */
const ledger = { record: jest.fn().mockResolvedValue(undefined) };

function work(userSlug: string): EverWorksProviderWorkRef {
    return {
        id: 'b8a4f8e0-1234-4def-aaaa-bbbbbbbbbbbb',
        slug: 'foo',
        userId: 'user-1',
        userSlug,
        description: 'A curated directory',
    };
}

function created(name: string): Response {
    return new Response(
        JSON.stringify({
            name,
            owner: { login: ORG },
            full_name: `${ORG}/${name}`,
            html_url: `https://github.com/${ORG}/${name}`,
            clone_url: `https://github.com/${ORG}/${name}.git`,
            private: true,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
    );
}

function nameTaken(): Response {
    return new Response(
        JSON.stringify({
            message: 'Validation Failed',
            errors: [{ code: 'custom', message: 'name already exists on this account' }],
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
    );
}

describe('EverWorksGitProvider.createRepository — demo repository prefix', () => {
    const ORIGINAL_ENV = { ...process.env };

    beforeEach(() => {
        process.env.STORAGE_EVER_WORKS_GIT_ENABLED = 'true';
        process.env.EVER_WORKS_CUSTOMERS_GITHUB_PAT = 'ghp_test';
        process.env.EVER_WORKS_CUSTOMERS_GITHUB_ORG = ORG;
        delete process.env.DEMO_REPO_PREFIX;
    });

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    describe('with the demo on', () => {
        beforeEach(() => {
            process.env.DEMO = 'true';
        });

        it('refuses anon-x-foo before calling GitHub', async () => {
            const fetchImpl = jest.fn();
            const provider = new EverWorksGitProvider(ledger);

            const result = provider.createRepository({ work: work('anon-x'), fetchImpl });

            await expect(result).rejects.toBeInstanceOf(DemoFeatureDisabledError);
            await expect(result).rejects.toMatchObject({
                feature: 'repository name',
                code: 'DEMO_DISABLED',
            });
            expect(fetchImpl).not.toHaveBeenCalled();
        });

        it('creates demo-1a2b3c4d-foo', async () => {
            const fetchImpl = jest.fn().mockResolvedValueOnce(created('demo-1a2b3c4d-foo'));
            const provider = new EverWorksGitProvider(ledger);

            const repo = await provider.createRepository({
                work: work('demo-1a2b3c4d'),
                fetchImpl,
            });

            expect(fetchImpl).toHaveBeenCalledTimes(1);
            const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
            expect(body.name).toBe('demo-1a2b3c4d-foo');
            expect(repo).toMatchObject({ owner: ORG, repo: 'demo-1a2b3c4d-foo' });
        });

        it('keeps the prefix on the collision retry', async () => {
            const fetchImpl = jest
                .fn()
                .mockResolvedValueOnce(nameTaken())
                .mockResolvedValueOnce(created('demo-1a2b3c4d-foo-b8a4f8e'));
            const provider = new EverWorksGitProvider(ledger);

            await provider.createRepository({ work: work('demo-1a2b3c4d'), fetchImpl });

            expect(fetchImpl).toHaveBeenCalledTimes(2);
            const retried = JSON.parse((fetchImpl.mock.calls[1][1] as RequestInit).body as string);
            expect(retried.name).toBe('demo-1a2b3c4d-foo-b8a4f8e');
        });

        it('follows DEMO_REPO_PREFIX', async () => {
            process.env.DEMO_REPO_PREFIX = 'ewdemo-';
            const fetchImpl = jest.fn();
            const provider = new EverWorksGitProvider(ledger);

            await expect(
                provider.createRepository({ work: work('demo-1a2b3c4d'), fetchImpl }),
            ).rejects.toBeInstanceOf(DemoFeatureDisabledError);
            expect(fetchImpl).not.toHaveBeenCalled();
        });
    });

    describe('with the demo off', () => {
        beforeEach(() => {
            delete process.env.DEMO;
        });

        it.each([
            ['anon-x', 'anon-x-foo'],
            ['demo-1a2b3c4d', 'demo-1a2b3c4d-foo'],
        ])('creates the repository for user %p (%p)', async (userSlug, name) => {
            const fetchImpl = jest.fn().mockResolvedValueOnce(created(name));
            const provider = new EverWorksGitProvider();

            const repo = await provider.createRepository({ work: work(userSlug), fetchImpl });

            expect(fetchImpl).toHaveBeenCalledTimes(1);
            expect(repo.repo).toBe(name);
        });
    });
});
