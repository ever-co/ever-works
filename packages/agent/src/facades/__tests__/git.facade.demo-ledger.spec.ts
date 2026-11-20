import { Logger } from '@nestjs/common';
import { DemoFeatureDisabledError, type DemoRepoLedgerPort } from '../../demo';
import { GitFacadeService } from '../git.facade';

/**
 * Platform demo mode — the repository ledger at the git facade (design §5.2.4 "Repo ledger").
 *
 * Generation makes repositories through `GitFacadeService` too: the website repository
 * (`<repo>-website`, by `createRepository` or `createRepositoryFromTemplate`), and a second
 * call for the data repository the provider already made. On a demo instance a repository the
 * call CREATED is written to the ledger for the Work owner the call names (`userId`), with no
 * GitHub id (the plugin does not report one). A repository the call merely FOUND — the
 * plugin answers an existing repository unchanged — is never recorded (ruling R23): a real
 * customer repository in the shared org must never enter the ledger. A demo instance with no
 * ledger bound refuses these creates before any provider call (ruling R22).
 *
 * `createRepositoryCopy` creates nothing (it pushes into a repository that must already
 * exist), so it never touches the ledger.
 */

const ORG = 'ever-works-cloud';
const SANDBOX_ID = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const OPTIONS = { providerId: 'github', userId: SANDBOX_ID, workId: 'work-1' } as const;
const WEBSITE = 'demo-1a2b3c4d-awesome-ai-coding-tools-website';

function repository(owner: string, name: string) {
    return {
        owner,
        name,
        fullName: `${owner}/${name}`,
        defaultBranch: 'main',
        isPrivate: true,
        url: `https://github.com/${owner}/${name}`,
        cloneUrl: `https://github.com/${owner}/${name}.git`,
    };
}

/** GitHub's id of the repository the double creates. */
const GITHUB_ID = 812345678;

type PluginDouble = {
    id: string;
    getUser: jest.Mock;
    getRepository: jest.Mock;
    getRepositoryIdentity?: jest.Mock;
    addRepositoryTopics?: jest.Mock;
    createRepository: jest.Mock;
    createRepositoryFromTemplate: jest.Mock;
    createRepositoryCopy: jest.Mock;
};

function pluginDouble(existing: ReturnType<typeof repository> | null = null): PluginDouble {
    return {
        id: 'github',
        getUser: jest.fn().mockResolvedValue({ id: '1', login: 'platform-bot' }),
        getRepository: jest.fn().mockResolvedValue(existing),
        getRepositoryIdentity: jest.fn(async (owner: string, name: string) => ({
            id: String(GITHUB_ID),
            fullName: `${owner}/${name}`,
        })),
        addRepositoryTopics: jest.fn().mockResolvedValue(undefined),
        createRepository: jest.fn(async (options: { name: string; organization?: string }) =>
            repository(options.organization ?? 'platform-bot', options.name),
        ),
        createRepositoryFromTemplate: jest.fn(
            async (
                _owner: string,
                _repo: string,
                options: { name: string; organization?: string },
            ) => repository(options.organization ?? 'platform-bot', options.name),
        ),
        createRepositoryCopy: jest
            .fn()
            .mockResolvedValue({ pushedSha: 'a'.repeat(40), alreadyUpToDate: false }),
    };
}

function ledgerDouble(): DemoRepoLedgerPort & { record: jest.Mock } {
    return { record: jest.fn().mockResolvedValue(undefined) };
}

/** A facade whose plugin resolution is fixed — no registry, no credentials. */
function makeFacade(plugin: PluginDouble, ledger?: DemoRepoLedgerPort) {
    const facade = new GitFacadeService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        ledger,
    );
    const resolve = jest.fn().mockResolvedValue({ plugin, token: 'tok' });
    (facade as unknown as { resolvePluginAndToken: jest.Mock }).resolvePluginAndToken = resolve;
    return { facade, resolve };
}

describe('GitFacadeService — demo repository ledger', () => {
    const savedDemo = process.env.DEMO;

    afterEach(() => {
        if (savedDemo === undefined) delete process.env.DEMO;
        else process.env.DEMO = savedDemo;
        jest.restoreAllMocks();
    });

    describe('with the demo on', () => {
        beforeEach(() => {
            process.env.DEMO = 'true';
        });

        it.each([
            [
                'createRepository',
                (plugin: PluginDouble) =>
                    plugin.createRepository.mockImplementation(
                        async (options: { name: string; organization?: string }) => ({
                            ...repository(options.organization as string, options.name),
                            id: '777000111',
                        }),
                    ),
                (facade: GitFacadeService) =>
                    facade.createRepository({ name: WEBSITE, organization: ORG }, OPTIONS),
            ],
            [
                'createRepositoryFromTemplate',
                (plugin: PluginDouble) =>
                    plugin.createRepositoryFromTemplate.mockImplementation(
                        async (
                            _owner: string,
                            _repo: string,
                            options: { name: string; organization?: string },
                        ) => ({
                            ...repository(options.organization as string, options.name),
                            id: '777000111',
                        }),
                    ),
                (facade: GitFacadeService) =>
                    facade.createRepositoryFromTemplate(
                        'ever-works',
                        'directory-template',
                        { name: WEBSITE, organization: ORG },
                        OPTIONS,
                    ),
            ],
        ])(
            '%s records the id the create itself reported, with no read-back',
            async (_name, arrange, call) => {
                const plugin = pluginDouble(null);
                arrange(plugin);
                const ledger = ledgerDouble();
                const { facade } = makeFacade(plugin, ledger);

                await call(facade);

                expect(plugin.getRepositoryIdentity).not.toHaveBeenCalled();
                expect(ledger.record).toHaveBeenCalledWith({
                    sandboxUserId: SANDBOX_ID,
                    owner: ORG,
                    name: WEBSITE,
                    githubId: 777000111,
                });
            },
        );

        it('reads the id back when the create reported a non-numeric one', async () => {
            const plugin = pluginDouble(null);
            plugin.createRepository.mockImplementation(
                async (options: { name: string; organization?: string }) => ({
                    ...repository(options.organization as string, options.name),
                    id: 'R_kgDOabc',
                }),
            );
            const ledger = ledgerDouble();
            const { facade } = makeFacade(plugin, ledger);

            await facade.createRepository({ name: WEBSITE, organization: ORG }, OPTIONS);

            expect(plugin.getRepositoryIdentity).toHaveBeenCalledWith(ORG, WEBSITE, 'tok');
            expect(ledger.record).toHaveBeenCalledWith(
                expect.objectContaining({ githubId: GITHUB_ID }),
            );
        });

        it("createRepository falls back to the plugin's read-back when the create reported no id (R26)", async () => {
            const plugin = pluginDouble(null);
            const ledger = ledgerDouble();
            const { facade } = makeFacade(plugin, ledger);

            await facade.createRepository(
                { name: WEBSITE, organization: ORG, isPrivate: true },
                OPTIONS,
            );

            expect(plugin.getRepository).toHaveBeenCalledWith(ORG, WEBSITE, 'tok');
            expect(plugin.createRepository).toHaveBeenCalledTimes(1);
            expect(plugin.getRepositoryIdentity).toHaveBeenCalledWith(ORG, WEBSITE, 'tok');
            expect(ledger.record).toHaveBeenCalledTimes(1);
            expect(ledger.record).toHaveBeenCalledWith({
                sandboxUserId: SANDBOX_ID,
                owner: ORG,
                name: WEBSITE,
                githubId: GITHUB_ID,
            });
        });

        it.each([
            [
                'the identity lookup throws',
                (plugin: PluginDouble) =>
                    plugin.getRepositoryIdentity!.mockRejectedValue(new Error('rate limited')),
            ],
            [
                'the plugin cannot see the repository yet',
                (plugin: PluginDouble) => plugin.getRepositoryIdentity!.mockResolvedValue(null),
            ],
            [
                'the plugin answers for another repository',
                (plugin: PluginDouble) =>
                    plugin.getRepositoryIdentity!.mockResolvedValue({
                        id: '5',
                        fullName: `${ORG}/customer-site`,
                    }),
            ],
            [
                'the id is not a number',
                (plugin: PluginDouble) =>
                    plugin.getRepositoryIdentity!.mockResolvedValue({
                        id: 'R_kgDOabc',
                        fullName: `${ORG}/${WEBSITE}`,
                    }),
            ],
            [
                'the plugin offers no identity read',
                (plugin: PluginDouble) => {
                    delete plugin.getRepositoryIdentity;
                },
            ],
        ])(
            'records a null id, the create still succeeding, when %s (R26)',
            async (_label, arrange) => {
                const plugin = pluginDouble(null);
                arrange(plugin);
                const ledger = ledgerDouble();
                const debug = jest
                    .spyOn(Logger.prototype, 'debug')
                    .mockImplementation(() => undefined);
                const { facade } = makeFacade(plugin, ledger);

                await expect(
                    facade.createRepository({ name: WEBSITE, organization: ORG }, OPTIONS),
                ).resolves.toMatchObject({ fullName: `${ORG}/${WEBSITE}` });

                expect(ledger.record).toHaveBeenCalledWith({
                    sandboxUserId: SANDBOX_ID,
                    owner: ORG,
                    name: WEBSITE,
                    githubId: null,
                });
                expect(debug).toHaveBeenCalledWith(expect.stringContaining(`${ORG}/${WEBSITE}`));
            },
        );

        it('tags a repository it created with the ever-works-demo topic, before recording it (R27)', async () => {
            const plugin = pluginDouble(null);
            const ledger = ledgerDouble();
            const { facade } = makeFacade(plugin, ledger);

            await facade.createRepository({ name: WEBSITE, organization: ORG }, OPTIONS);

            expect(plugin.addRepositoryTopics).toHaveBeenCalledTimes(1);
            expect(plugin.addRepositoryTopics).toHaveBeenCalledWith(
                ORG,
                WEBSITE,
                ['ever-works-demo'],
                'tok',
            );
            expect(plugin.addRepositoryTopics!.mock.invocationCallOrder[0]).toBeLessThan(
                ledger.record.mock.invocationCallOrder[0],
            );
        });

        it('never tags a repository that already existed (R27)', async () => {
            const plugin = pluginDouble(repository(ORG, WEBSITE));
            const { facade } = makeFacade(plugin, ledgerDouble());

            await facade.createRepository({ name: WEBSITE, organization: ORG }, OPTIONS);
            await facade.createRepositoryFromTemplate(
                'ever-works',
                'directory-template',
                { name: WEBSITE, organization: ORG },
                OPTIONS,
            );

            expect(plugin.addRepositoryTopics).not.toHaveBeenCalled();
        });

        it.each([
            [
                'the topic call fails',
                (plugin: PluginDouble) =>
                    plugin.addRepositoryTopics!.mockRejectedValue(new Error('403 Forbidden')),
            ],
            [
                'the plugin offers no topic write',
                (plugin: PluginDouble) => {
                    delete plugin.addRepositoryTopics;
                },
            ],
        ])(
            'keeps the create and the record when %s, with a warning (R27)',
            async (_label, arrange) => {
                const plugin = pluginDouble(null);
                arrange(plugin);
                const ledger = ledgerDouble();
                const warnings = jest
                    .spyOn(Logger.prototype, 'warn')
                    .mockImplementation(() => undefined);
                const { facade } = makeFacade(plugin, ledger);

                await expect(
                    facade.createRepository({ name: WEBSITE, organization: ORG }, OPTIONS),
                ).resolves.toMatchObject({ fullName: `${ORG}/${WEBSITE}` });

                expect(ledger.record).toHaveBeenCalledWith(
                    expect.objectContaining({ name: WEBSITE, githubId: GITHUB_ID }),
                );
                expect(warnings).toHaveBeenCalledWith(expect.stringContaining(`${ORG}/${WEBSITE}`));
            },
        );

        it('still tags a repository whose record fails (R27: findable by an operator)', async () => {
            const plugin = pluginDouble(null);
            const ledger = ledgerDouble();
            ledger.record.mockRejectedValue(new Error('remote call failed'));
            jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
            const { facade } = makeFacade(plugin, ledger);

            await expect(
                facade.createRepository({ name: WEBSITE, organization: ORG }, OPTIONS),
            ).rejects.toThrow('remote call failed');
            expect(plugin.addRepositoryTopics).toHaveBeenCalledTimes(1);
        });

        it('createRepository never records a repository that already existed (R23)', async () => {
            const plugin = pluginDouble(repository(ORG, WEBSITE));
            const ledger = ledgerDouble();
            const { facade } = makeFacade(plugin, ledger);

            const result = await facade.createRepository(
                { name: WEBSITE, organization: ORG, isPrivate: true },
                OPTIONS,
            );

            expect(result.fullName).toBe(`${ORG}/${WEBSITE}`);
            expect(plugin.createRepository).toHaveBeenCalledTimes(1);
            expect(ledger.record).not.toHaveBeenCalled();
        });

        it("checks a personal repository under the token's own account", async () => {
            const plugin = pluginDouble(null);
            const ledger = ledgerDouble();
            const { facade } = makeFacade(plugin, ledger);

            await facade.createRepository({ name: 'demo-1a2b3c4d-foo-data' }, OPTIONS);

            expect(plugin.getUser).toHaveBeenCalledWith('tok');
            expect(plugin.getRepository).toHaveBeenCalledWith(
                'platform-bot',
                'demo-1a2b3c4d-foo-data',
                'tok',
            );
            expect(ledger.record).toHaveBeenCalledWith(
                expect.objectContaining({ owner: 'platform-bot', name: 'demo-1a2b3c4d-foo-data' }),
            );
        });

        it('records nothing when the create fails', async () => {
            const plugin = pluginDouble(null);
            plugin.createRepository.mockRejectedValue(new Error('GitHub 500'));
            const ledger = ledgerDouble();
            const { facade } = makeFacade(plugin, ledger);

            await expect(
                facade.createRepository({ name: WEBSITE, organization: ORG }, OPTIONS),
            ).rejects.toThrow('GitHub 500');
            expect(ledger.record).not.toHaveBeenCalled();
        });

        it('fails the call, naming the repository, when the ledger cannot record it', async () => {
            const plugin = pluginDouble(null);
            const ledger = ledgerDouble();
            ledger.record.mockRejectedValue(new Error('remote call failed'));
            const errors = jest
                .spyOn(Logger.prototype, 'error')
                .mockImplementation(() => undefined);
            const { facade } = makeFacade(plugin, ledger);

            await expect(
                facade.createRepository({ name: WEBSITE, organization: ORG }, OPTIONS),
            ).rejects.toThrow('remote call failed');
            expect(errors).toHaveBeenCalledWith(expect.stringContaining(`${ORG}/${WEBSITE}`));
        });

        it("createRepositoryFromTemplate records a repository it created, with GitHub's id, tagged", async () => {
            const plugin = pluginDouble(null);
            const ledger = ledgerDouble();
            const { facade } = makeFacade(plugin, ledger);

            await facade.createRepositoryFromTemplate(
                'ever-works',
                'directory-template',
                { name: WEBSITE, organization: ORG, isPrivate: true },
                OPTIONS,
            );

            expect(plugin.getRepository).toHaveBeenCalledWith(ORG, WEBSITE, 'tok');
            expect(ledger.record).toHaveBeenCalledWith({
                sandboxUserId: SANDBOX_ID,
                owner: ORG,
                name: WEBSITE,
                githubId: GITHUB_ID,
            });
            expect(plugin.addRepositoryTopics).toHaveBeenCalledWith(
                ORG,
                WEBSITE,
                ['ever-works-demo'],
                'tok',
            );
        });

        it('createRepositoryFromTemplate never records a repository that already existed (R23)', async () => {
            const plugin = pluginDouble(repository(ORG, WEBSITE));
            const ledger = ledgerDouble();
            const { facade } = makeFacade(plugin, ledger);

            await facade.createRepositoryFromTemplate(
                'ever-works',
                'directory-template',
                { name: WEBSITE, organization: ORG },
                OPTIONS,
            );

            expect(ledger.record).not.toHaveBeenCalled();
        });

        it('createRepositoryFromTemplate records the requested repository when GitHub cannot read the new one back yet', async () => {
            // GitHub's template create answers `null` when the repository it just created is
            // not readable yet; generation carries on with it, so it must be ledgered. Its id
            // cannot be read yet either.
            const plugin = pluginDouble(null);
            plugin.createRepositoryFromTemplate.mockResolvedValue(null);
            plugin.getRepositoryIdentity!.mockResolvedValue(null);
            jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
            const ledger = ledgerDouble();
            const { facade } = makeFacade(plugin, ledger);

            await facade.createRepositoryFromTemplate(
                'ever-works',
                'directory-template',
                { name: WEBSITE, organization: ORG },
                OPTIONS,
            );

            expect(ledger.record).toHaveBeenCalledWith({
                sandboxUserId: SANDBOX_ID,
                owner: ORG,
                name: WEBSITE,
                githubId: null,
            });
        });

        it('createRepositoryFromTemplate records nothing when it answers no repository for one that existed', async () => {
            const plugin = pluginDouble(repository(ORG, WEBSITE));
            plugin.createRepositoryFromTemplate.mockResolvedValue(null);
            const ledger = ledgerDouble();
            const { facade } = makeFacade(plugin, ledger);

            await facade.createRepositoryFromTemplate(
                'ever-works',
                'directory-template',
                { name: WEBSITE, organization: ORG },
                OPTIONS,
            );

            expect(ledger.record).not.toHaveBeenCalled();
        });

        it('a call that names no user is created but not recorded (nobody to sweep it for)', async () => {
            const plugin = pluginDouble(null);
            const ledger = ledgerDouble();
            const warnings = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            const { facade } = makeFacade(plugin, ledger);

            await facade.createRepository(
                { name: WEBSITE, organization: ORG },
                { providerId: 'github', token: 'tok' },
            );

            expect(plugin.createRepository).toHaveBeenCalledTimes(1);
            expect(ledger.record).not.toHaveBeenCalled();
            expect(warnings).toHaveBeenCalledWith(expect.stringContaining(`${ORG}/${WEBSITE}`));
        });

        it.each([
            [
                'createRepository',
                (facade: GitFacadeService) =>
                    facade.createRepository({ name: WEBSITE, organization: ORG }, OPTIONS),
            ],
            [
                'createRepositoryFromTemplate',
                (facade: GitFacadeService) =>
                    facade.createRepositoryFromTemplate(
                        'ever-works',
                        'directory-template',
                        { name: WEBSITE, organization: ORG },
                        OPTIONS,
                    ),
            ],
        ])(
            '%s refuses with no ledger bound, before any provider call (R22), and says so once',
            async (_name, call) => {
                const errors = jest
                    .spyOn(Logger.prototype, 'error')
                    .mockImplementation(() => undefined);
                const plugin = pluginDouble(null);
                const { facade, resolve } = makeFacade(plugin);

                for (let attempt = 0; attempt < 2; attempt += 1) {
                    const result = call(facade);
                    await expect(result).rejects.toBeInstanceOf(DemoFeatureDisabledError);
                    await expect(result).rejects.toMatchObject({
                        feature: 'repository creation (ledger not configured)',
                    });
                }
                expect(resolve).not.toHaveBeenCalled();
                expect(plugin.getRepository).not.toHaveBeenCalled();
                expect(plugin.createRepository).not.toHaveBeenCalled();
                expect(plugin.createRepositoryFromTemplate).not.toHaveBeenCalled();
                expect(errors).toHaveBeenCalledTimes(1);
                expect(errors.mock.calls[0][0]).toMatch(/DEMO_REPO_LEDGER/);
            },
        );

        it('createRepositoryCopy creates no repository, so it neither records nor needs a ledger', async () => {
            const plugin = pluginDouble(null);
            const ledger = ledgerDouble();
            const input = {
                sourceOwner: 'upstream',
                sourceRepo: 'widgets',
                sourceBranch: 'main',
                targetOwner: ORG,
                targetRepo: 'demo-1a2b3c4d-widgets',
                maxSizeKb: 1000,
            };

            await makeFacade(plugin, ledger).facade.createRepositoryCopy(input, OPTIONS);
            await makeFacade(plugin).facade.createRepositoryCopy(input, OPTIONS);

            expect(plugin.createRepositoryCopy).toHaveBeenCalledTimes(2);
            expect(ledger.record).not.toHaveBeenCalled();
        });
    });

    describe('with the demo off', () => {
        beforeEach(() => {
            delete process.env.DEMO;
        });

        it('creates exactly as before: no existence check, no id read, no topic, no ledger call', async () => {
            const plugin = pluginDouble(null);
            const ledger = ledgerDouble();
            const { facade } = makeFacade(plugin, ledger);

            await facade.createRepository({ name: 'site', organization: 'acme' }, OPTIONS);
            await facade.createRepositoryFromTemplate(
                'ever-works',
                'directory-template',
                { name: 'site-2', organization: 'acme' },
                OPTIONS,
            );

            expect(plugin.getRepository).not.toHaveBeenCalled();
            expect(plugin.getUser).not.toHaveBeenCalled();
            expect(plugin.getRepositoryIdentity).not.toHaveBeenCalled();
            expect(plugin.addRepositoryTopics).not.toHaveBeenCalled();
            expect(ledger.record).not.toHaveBeenCalled();
        });

        it('needs no ledger bound', async () => {
            const plugin = pluginDouble(null);
            const { facade } = makeFacade(plugin);

            await expect(
                facade.createRepository({ name: 'site', organization: 'acme' }, OPTIONS),
            ).resolves.toMatchObject({ fullName: 'acme/site' });
        });
    });
});
