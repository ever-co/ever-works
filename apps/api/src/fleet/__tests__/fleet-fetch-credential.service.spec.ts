import { createHash, generateKeyPairSync } from 'node:crypto';
import {
    FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON,
    FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON,
    FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
} from '@ever-works/contracts';
import { FleetJobService, FleetJobStaleLeaseError } from '@ever-works/agent/fleet';
import { FleetPushCredentialService } from '../fleet-push-credential.service';

/**
 * Scoped FETCH credentials — the PLATFORM half
 * (`FleetPushCredentialService.mintFetch`), the read twin of
 * `fleet-push-credential.service.spec.ts`.
 *
 * What a review will look for, and what these cases pin:
 *
 *  - a token is narrowed to ONE repository, by the numeric id from the
 *    platform's own installation snapshot, and to `contents: read` +
 *    `metadata: read` and nothing else;
 *  - a caller cannot influence the scope: the request carries no
 *    repository, and the repositories are re-read from the job's own
 *    planner-written payload;
 *  - the installation must be the JOB OWNER's, live, and unambiguous, and
 *    the clone URL must be `https://github.com/…` — the push rules, run by
 *    the same code;
 *  - only the node holding an ACTIVE claim at the CURRENT generation is
 *    served (driven through the real `FleetJobService` below);
 *  - the ONE deliberate difference from push: "nothing to give" is an
 *    answer, per repository, never a refusal of the whole request;
 *  - no token and no installation id reaches a log line or the response
 *    beyond the credential itself.
 */

const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_NODE_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = 'user-1';
const OTHER_USER = 'user-2';
const SECRET = 'a'.repeat(32);

const tokenFor = (ids: readonly number[]): string =>
    `ghs_read_${ids.join('_')}_0123456789abcdefghij`;

const workspace = (overrides: Record<string, unknown> = {}) => ({
    repositoryId: 'ever-works/ever-works',
    repoUrl: 'https://github.com/ever-works/ever-works.git',
    baseRef: 'develop',
    branch: 'task/x',
    ...overrides,
});

const jobRow = (
    workspaceValue: unknown = workspace(),
    overrides: Record<string, unknown> = {},
) => ({
    id: JOB_ID,
    userId: USER_ID,
    payload: {
        taskId: 'task-1',
        git: { commit: true, push: true, commitMessage: 'feat(task): x' },
        // `null` = a job with no repository workspace at all.
        ...(workspaceValue === null ? {} : { workspace: workspaceValue }),
    },
    ...overrides,
});

const installationRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'inst-entity-1',
    installationId: '9001',
    createdByUserId: USER_ID,
    deletedAt: null,
    suspendedAt: null,
    ...overrides,
});

const snapshotRow = (
    fullName: string,
    githubRepoId: string,
    installationEntityId = 'inst-entity-1',
) => ({
    id: `snap-${fullName}-${installationEntityId}`,
    installationEntityId,
    githubRepoId,
    fullName,
    owner: fullName.split('/')[0],
    repo: fullName.split('/')[1],
});

function build(
    overrides: {
        job?: Record<string, unknown> | null;
        claim?: unknown;
        installations?: Array<Record<string, unknown>>;
        snapshots?: Record<string, Array<Record<string, unknown>>>;
    } = {},
) {
    const claim =
        overrides.claim === undefined
            ? { jobId: JOB_ID, userId: USER_ID, nodeId: NODE_ID }
            : overrides.claim;
    const jobs = { authorizeRunSecretRequest: jest.fn(async () => claim) };
    const jobRows = {
        findById: jest.fn(async () => (overrides.job === undefined ? jobRow() : overrides.job)),
        // Present only so "nothing is stored" can be asserted: this service
        // must never write a row on the way to a credential.
        update: jest.fn(),
        save: jest.fn(),
    };
    const nodes = { findById: jest.fn(async () => ({ id: NODE_ID, name: 'studio-win' })) };
    const rows = overrides.installations ?? [installationRow()];
    const installations = {
        findById: jest.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
    };
    const snapshots = overrides.snapshots ?? {
        'ever-works/ever-works': [snapshotRow('ever-works/ever-works', '556677')],
    };
    const installationRepos = {
        // Models the REAL repository, which matches case-insensitively and
        // is GLOBAL across the deployment — see the push spec's note.
        findByFullName: jest.fn(async (fullName: string) => {
            const key = Object.keys(snapshots).find(
                (name) => name.toLowerCase() === fullName.toLowerCase(),
            );
            return key === undefined ? [] : snapshots[key];
        }),
    };
    const service = new FleetPushCredentialService(
        jobs as never,
        jobRows as never,
        nodes as never,
        installations as never,
        installationRepos as never,
    );
    return { service, jobs, jobRows, nodes, installations, installationRepos };
}

type GitHubCall = { url: string; body: { repository_ids?: number[]; permissions?: unknown } };

const ask = (service: FleetPushCredentialService, extra: Record<string, unknown> = {}) =>
    service.mintFetch({
        nodeId: NODE_ID,
        secret: SECRET,
        jobId: JOB_ID,
        leaseGeneration: 4,
        ...extra,
    });

describe('FleetPushCredentialService.mintFetch — scoped fetch credentials', () => {
    let fetchSpy: jest.SpyInstance | undefined;
    const previousEnv = { id: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY };

    /** GitHub answers every mint with a token that names the ids it was asked for. */
    const githubMints = (
        failing: (call: GitHubCall) => { status: number; statusText: string } | null = () => null,
    ): GitHubCall[] => {
        const calls: GitHubCall[] = [];
        fetchSpy = jest
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (input: unknown, init?: RequestInit) => {
                const call: GitHubCall = {
                    url: String(input),
                    body: JSON.parse(String(init?.body ?? '{}')) as GitHubCall['body'],
                };
                calls.push(call);
                const failure = failing(call);
                if (failure) {
                    return {
                        ok: false,
                        status: failure.status,
                        statusText: failure.statusText,
                        json: async () => ({}),
                    } as unknown as Response;
                }
                return {
                    ok: true,
                    status: 201,
                    statusText: 'Created',
                    json: async () => ({
                        token: tokenFor(call.body.repository_ids ?? []),
                        expires_at: '2026-11-10T21:00:00Z',
                    }),
                } as unknown as Response;
            });
        return calls;
    };

    beforeEach(() => {
        process.env.GITHUB_APP_ID = '12345';
        process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    });

    afterEach(() => {
        fetchSpy?.mockRestore();
        fetchSpy = undefined;
        if (previousEnv.id === undefined) delete process.env.GITHUB_APP_ID;
        else process.env.GITHUB_APP_ID = previousEnv.id;
        if (previousEnv.key === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
        else process.env.GITHUB_APP_PRIVATE_KEY = previousEnv.key;
    });

    describe('the scope is narrowed from platform state', () => {
        it('mints with the repository id from the installation SNAPSHOT and contents:read + metadata:read ONLY', async () => {
            const calls = githubMints();
            const { service } = build();

            const answer = await ask(service);

            expect(calls).toHaveLength(1);
            expect(calls[0].url).toBe(
                'https://api.github.com/app/installations/9001/access_tokens',
            );
            // The EXACT pin is the control. `contents: read` is what `git
            // fetch` needs; `metadata: read` is GitHub's mandatory baseline,
            // named so the grant is explicit. Anything added here — `write`,
            // `pull_requests`, `workflows`, `actions`, `secrets` — is a wider
            // credential on an unattended machine, and a test loosened to
            // `toMatchObject` would stop noticing.
            expect(calls[0].body).toEqual({
                repository_ids: [556677],
                permissions: { contents: 'read', metadata: 'read' },
            });
            expect(answer).toEqual({
                credentials: [
                    {
                        token: tokenFor([556677]),
                        username: 'x-access-token',
                        expiresAt: '2026-11-10T21:00:00Z',
                        repositories: ['ever-works/ever-works'],
                    },
                ],
                uncovered: [],
            });
        });

        it('mints ONE token PER repository — no fetch ever holds a credential for another repository of the job', async () => {
            const calls = githubMints();
            const { service } = build({
                job: jobRow(
                    workspace({
                        mounts: [
                            {
                                repositoryId: 'ever-works/template',
                                repoUrl: 'https://github.com/ever-works/template.git',
                                writable: true,
                                mountDir: 't',
                            },
                            {
                                repositoryId: 'ever-works/reference',
                                repoUrl: 'https://github.com/ever-works/reference.git',
                                // A READ-ONLY reference. A push credential
                                // leaves it out; reading it is what it is for.
                                writable: false,
                                mountDir: 'r',
                            },
                        ],
                    }),
                ),
                snapshots: {
                    'ever-works/ever-works': [snapshotRow('ever-works/ever-works', '556677')],
                    'ever-works/template': [snapshotRow('ever-works/template', '778899')],
                    'ever-works/reference': [snapshotRow('ever-works/reference', '990011')],
                },
            });

            const answer = await ask(service);

            // Three mints, each narrowed to a SINGLE id.
            expect(calls.map((call) => call.body.repository_ids)).toEqual([
                [556677],
                [778899],
                [990011],
            ]);
            for (const call of calls) {
                expect(call.body.permissions).toEqual({ contents: 'read', metadata: 'read' });
            }
            expect(answer?.credentials.map((entry) => [entry.repositories, entry.token])).toEqual([
                [['ever-works/ever-works'], tokenFor([556677])],
                [['ever-works/template'], tokenFor([778899])],
                [['ever-works/reference'], tokenFor([990011])],
            ]);
            expect(answer?.uncovered).toEqual([]);
        });

        it('mints once for a repository the workspace names twice', async () => {
            const calls = githubMints();
            const { service } = build({
                job: jobRow(
                    workspace({
                        mounts: [
                            {
                                repositoryId: 'Ever-Works/Ever-Works',
                                repoUrl: 'https://github.com/Ever-Works/ever-works',
                                writable: false,
                                mountDir: 'again',
                            },
                        ],
                    }),
                ),
            });

            const answer = await ask(service);

            expect(calls).toHaveLength(1);
            expect(answer?.credentials).toHaveLength(1);
        });

        it('resolves a repository whose GitHub name is MIXED CASE, and names it normalized', async () => {
            const calls = githubMints();
            const { service, installationRepos } = build({
                job: jobRow({
                    repositoryId: 'Ever-Works/Directory-Web-Template',
                    repoUrl: 'https://github.com/Ever-Works/Directory-Web-Template.git',
                }),
                // Stored exactly as GitHub reports it.
                snapshots: {
                    'Ever-Works/Directory-Web-Template': [
                        snapshotRow('Ever-Works/Directory-Web-Template', '445566'),
                    ],
                },
            });

            const answer = await ask(service);

            expect(calls[0].body.repository_ids).toEqual([445566]);
            // The name the node compares its remote against.
            expect(answer?.credentials[0].repositories).toEqual([
                'ever-works/directory-web-template',
            ]);
            expect(installationRepos.findByFullName).toHaveBeenCalledWith(
                'ever-works/directory-web-template',
            );
        });

        it('ignores anything the CALLER or the payload says about ids: the request carries no scope', async () => {
            const calls = githubMints();
            const { service, jobs } = build({
                job: jobRow(
                    workspace({
                        // Not fields the platform reads. A numeric id from a
                        // payload is a name somebody supplied.
                        githubRepoId: '1',
                        repositoryIds: [1, 2, 3],
                        installationId: '666',
                    }),
                ),
            });

            await ask(service, {
                // Nor these: the DTO forbids them, and the service would not
                // look even if it did not.
                repositories: ['victim/private'],
                repositoryIds: [42],
                installationId: '666',
                permissions: { contents: 'write' },
            });

            expect(calls).toHaveLength(1);
            expect(calls[0].url).toContain('/installations/9001/');
            expect(calls[0].body).toEqual({
                repository_ids: [556677],
                permissions: { contents: 'read', metadata: 'read' },
            });
            // The claim is handed to the authorizer as sent, and nothing else.
            expect(jobs.authorizeRunSecretRequest).toHaveBeenCalledWith({
                nodeId: NODE_ID,
                secret: SECRET,
                jobId: JOB_ID,
                leaseGeneration: 4,
            });
        });
    });

    describe('the installation must belong to the job’s owner — the push rule, unchanged', () => {
        const uncoveredCases: Array<[string, Parameters<typeof build>[0]]> = [
            ['no installation snapshot names the repository', { snapshots: {} }],
            [
                'the installation belongs to someone else',
                { installations: [installationRow({ createdByUserId: OTHER_USER })] },
            ],
            [
                'the installation was suspended',
                { installations: [installationRow({ suspendedAt: new Date() })] },
            ],
            [
                'the installation was deleted',
                { installations: [installationRow({ deletedAt: new Date() })] },
            ],
            ['the installation row is gone', { installations: [] }],
        ];

        it.each(uncoveredCases)('issues nothing when %s', async (_name, overrides) => {
            const calls = githubMints();
            const { service } = build(overrides);

            const answer = await ask(service);

            // NOT a refusal of the request (see the fallback block below):
            // the repository is simply not covered…
            expect(answer).toEqual({
                credentials: [],
                uncovered: [
                    {
                        repository: 'ever-works/ever-works',
                        reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
                    },
                ],
            });
            // …and nothing was minted: the decision is made before GitHub is asked.
            expect(calls).toEqual([]);
        });

        it('never reaches for ANOTHER owner’s installation of the same repository', async () => {
            // `findByFullName` is global: it returns the row of every
            // installation in the deployment that covers this name. The
            // ownership filter is the only thing between a job and a token
            // minted against somebody else's installation.
            const calls = githubMints();
            const { service } = build({
                installations: [
                    installationRow({
                        id: 'inst-foreign',
                        installationId: '6660',
                        createdByUserId: OTHER_USER,
                    }),
                    installationRow(),
                ],
                snapshots: {
                    'ever-works/ever-works': [
                        snapshotRow('ever-works/ever-works', '111111', 'inst-foreign'),
                        snapshotRow('ever-works/ever-works', '556677', 'inst-entity-1'),
                    ],
                },
            });

            const answer = await ask(service);

            expect(calls).toHaveLength(1);
            expect(calls[0].url).toBe(
                'https://api.github.com/app/installations/9001/access_tokens',
            );
            expect(calls[0].body.repository_ids).toEqual([556677]);
            expect(answer?.credentials).toHaveLength(1);
        });

        it('does not guess between TWO of the owner’s installations covering one repository', async () => {
            // The same anomaly a push refuses, answered the same way.
            const calls = githubMints();
            const { service } = build({
                installations: [
                    installationRow(),
                    installationRow({ id: 'inst-entity-2', installationId: '9002' }),
                ],
                snapshots: {
                    'ever-works/ever-works': [
                        snapshotRow('ever-works/ever-works', '556677', 'inst-entity-1'),
                        snapshotRow('ever-works/ever-works', '556677', 'inst-entity-2'),
                    ],
                },
            });

            const answer = await ask(service);

            expect(calls).toEqual([]);
            expect(answer?.uncovered).toEqual([
                {
                    repository: 'ever-works/ever-works',
                    reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
                },
            ]);
        });
    });

    describe('the host must be github.com — the clone URL is the authority', () => {
        // `owner/repo` is not an identity without a host in front of it. A
        // mount at `https://gitlab.example/ever-works/ever-works` normalizes
        // to the same name as the GitHub repository an installation row
        // covers; without this check it would buy a token for a repository
        // the run never touches (the push slice's review, F4).
        it.each([
            ['a different forge', 'https://gitlab.com/ever-works/ever-works.git'],
            ['a suffix lookalike', 'https://github.com.evil.tld/ever-works/ever-works'],
            ['a non-default port', 'https://github.com:8443/ever-works/ever-works'],
            ['plain http', 'http://github.com/ever-works/ever-works.git'],
            ['an ssh remote', 'git@github.com:ever-works/ever-works.git'],
            ['a URL carrying userinfo', 'https://x@github.com/ever-works/ever-works.git'],
            ['a name that disagrees with its own url', 'https://github.com/someone-else/other.git'],
        ])('issues nothing for a repository whose clone URL is %s', async (_label, repoUrl) => {
            const calls = githubMints();
            const { service, installationRepos } = build({
                job: jobRow(workspace({ repoUrl })),
            });

            const answer = await ask(service);

            expect(calls).toEqual([]);
            expect(answer).toEqual({
                credentials: [],
                uncovered: [
                    {
                        repository: 'ever-works/ever-works',
                        reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
                    },
                ],
            });
            // Not even looked up: the name was never accepted as an identity.
            expect(installationRepos.findByFullName).not.toHaveBeenCalled();
        });

        it('a non-GitHub repository does not shadow the GitHub repository of the same name mounted beside it', async () => {
            const calls = githubMints();
            const { service } = build({
                job: jobRow(
                    workspace({
                        repoUrl: 'https://gitlab.com/ever-works/ever-works.git',
                        mounts: [
                            {
                                repositoryId: 'ever-works/ever-works',
                                repoUrl: 'https://github.com/ever-works/ever-works.git',
                                writable: false,
                                mountDir: 'gh',
                            },
                        ],
                    }),
                ),
            });

            const answer = await ask(service);

            expect(calls).toHaveLength(1);
            // The GitHub one is covered; the other is listed as uncovered.
            // The node offers the token only to the github.com URL.
            expect(answer?.credentials.map((entry) => entry.repositories)).toEqual([
                ['ever-works/ever-works'],
            ]);
            expect(answer?.uncovered).toEqual([
                {
                    repository: 'ever-works/ever-works',
                    reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
                },
            ]);
        });
    });

    describe('fetch keeps its fallback — "nothing to give" is an answer per repository, never a refusal', () => {
        const mixedWorkspace = () =>
            workspace({
                mounts: [
                    {
                        repositoryId: 'ever-works/not-installed',
                        repoUrl: 'https://github.com/ever-works/not-installed.git',
                        writable: true,
                        mountDir: 'a',
                    },
                    {
                        repositoryId: 'acme/elsewhere',
                        repoUrl: 'https://gitlab.com/acme/elsewhere.git',
                        writable: false,
                        mountDir: 'b',
                    },
                ],
            });

        it('covers each repository that can be covered and lists the rest', async () => {
            const calls = githubMints();
            const { service } = build({ job: jobRow(mixedWorkspace()) });

            const answer = await ask(service);

            // A push for this job is refused whole: one credential cannot
            // cover it. A fetch covers what it can.
            expect(calls.map((call) => call.body.repository_ids)).toEqual([[556677]]);
            expect(answer?.credentials.map((entry) => entry.repositories)).toEqual([
                ['ever-works/ever-works'],
            ]);
            expect(answer?.uncovered).toEqual([
                {
                    repository: 'ever-works/not-installed',
                    reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
                },
                { repository: 'acme/elsewhere', reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON },
            ]);
        });

        it('covers repositories under DIFFERENT installations of the same owner — which a push refuses', async () => {
            // A push needs ONE credential for the whole run, so two
            // installations are refused. Fetch tokens are per repository, so
            // there is nothing to choose between.
            const calls = githubMints();
            const { service } = build({
                job: jobRow(
                    workspace({
                        mounts: [
                            {
                                repositoryId: 'ever-co/other',
                                repoUrl: 'https://github.com/ever-co/other.git',
                                writable: true,
                                mountDir: 'o',
                            },
                        ],
                    }),
                ),
                installations: [
                    installationRow(),
                    installationRow({ id: 'inst-entity-2', installationId: '9002' }),
                ],
                snapshots: {
                    'ever-works/ever-works': [
                        snapshotRow('ever-works/ever-works', '556677', 'inst-entity-1'),
                    ],
                    'ever-co/other': [snapshotRow('ever-co/other', '778899', 'inst-entity-2')],
                },
            });

            const answer = await ask(service);

            expect(calls.map((call) => [call.url, call.body.repository_ids])).toEqual([
                ['https://api.github.com/app/installations/9001/access_tokens', [556677]],
                ['https://api.github.com/app/installations/9002/access_tokens', [778899]],
            ]);
            expect(answer?.uncovered).toEqual([]);
            // The push scope for the very same repositories is still refused.
            await expect(
                service.describeScope(USER_ID, [
                    { repositoryId: 'ever-works/ever-works' },
                    { repositoryId: 'ever-co/other' },
                ]),
            ).resolves.toEqual({ ok: false, reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON });
        });

        it('answers — does not throw — when the deployment has no GitHub App configured', async () => {
            delete process.env.GITHUB_APP_ID;
            const calls = githubMints();
            const { service, installationRepos } = build({ job: jobRow(mixedWorkspace()) });

            const answer = await ask(service);

            expect(answer).toEqual({
                credentials: [],
                uncovered: [
                    {
                        repository: 'ever-works/ever-works',
                        reason: FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON,
                    },
                    {
                        repository: 'ever-works/not-installed',
                        reason: FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON,
                    },
                    {
                        repository: 'acme/elsewhere',
                        reason: FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON,
                    },
                ],
            });
            expect(calls).toEqual([]);
            // Decided before any row is read.
            expect(installationRepos.findByFullName).not.toHaveBeenCalled();
        });

        it('keeps the credentials it could mint when GitHub declines ONE of them, and never echoes GitHub', async () => {
            const calls = githubMints((call) =>
                call.body.repository_ids?.[0] === 778899
                    ? {
                          status: 403,
                          statusText: 'installation suspended: app 12345 for org ever-works',
                      }
                    : null,
            );
            const { service } = build({
                job: jobRow(
                    workspace({
                        mounts: [
                            {
                                repositoryId: 'ever-works/template',
                                repoUrl: 'https://github.com/ever-works/template.git',
                                writable: true,
                                mountDir: 't',
                            },
                        ],
                    }),
                ),
                snapshots: {
                    'ever-works/ever-works': [snapshotRow('ever-works/ever-works', '556677')],
                    'ever-works/template': [snapshotRow('ever-works/template', '778899')],
                },
            });
            const lines: string[] = [];
            const logger = (service as unknown as { logger: Record<string, (m: string) => void> })
                .logger;
            for (const level of ['log', 'warn', 'error']) {
                jest.spyOn(logger, level as never).mockImplementation(((message: string) => {
                    lines.push(String(message));
                }) as never);
            }

            const answer = await ask(service);

            expect(calls).toHaveLength(2);
            expect(answer?.credentials.map((entry) => entry.repositories)).toEqual([
                ['ever-works/ever-works'],
            ]);
            expect(answer?.uncovered).toEqual([
                {
                    repository: 'ever-works/template',
                    reason: FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON,
                },
            ]);
            // GitHub's message can name the installation and the App; it
            // reaches neither the node nor a log line.
            expect(JSON.stringify(answer)).not.toContain('org ever-works');
            expect(lines.join('\n')).not.toContain('org ever-works');
        });

        it('treats a snapshot it cannot read as "not covered", not as a server error', async () => {
            const calls = githubMints();
            const { service, installationRepos } = build();
            installationRepos.findByFullName.mockRejectedValue(new Error('db down'));

            await expect(ask(service)).resolves.toEqual({
                credentials: [],
                uncovered: [
                    {
                        repository: 'ever-works/ever-works',
                        reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
                    },
                ],
            });
            expect(calls).toEqual([]);
        });

        it('covers NOTHING for a workspace with more repositories than a workspace can have', async () => {
            // The primary plus eight mounts is the ceiling the planner
            // enforces. A payload beyond it was not written by the planner,
            // and this bounds what one request can ask GitHub to mint.
            const calls = githubMints();
            const mounts = Array.from({ length: 9 }, (_, index) => ({
                repositoryId: `ever-works/m${index}`,
                repoUrl: `https://github.com/ever-works/m${index}.git`,
                writable: false,
                mountDir: `m${index}`,
            }));
            const { service } = build({ job: jobRow(workspace({ mounts })) });

            const answer = await ask(service);

            expect(calls).toEqual([]);
            expect(answer?.credentials).toEqual([]);
            expect(answer?.uncovered).toHaveLength(10);
        });

        it('answers an empty list for a job with no repository workspace at all', async () => {
            const calls = githubMints();
            const { service } = build({ job: jobRow(null) });

            await expect(ask(service)).resolves.toEqual({ credentials: [], uncovered: [] });
            expect(calls).toEqual([]);
        });

        it('never echoes a repository identity outside the identity alphabet', async () => {
            githubMints();
            const { service } = build({
                job: jobRow(
                    workspace({ repositoryId: 'not a repo\nInjected: line', repoUrl: undefined }),
                ),
            });

            const answer = await ask(service);

            expect(answer?.uncovered).toEqual([
                { repository: 'unknown', reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON },
            ]);
        });
    });

    describe('only the node the job is assigned to may ask', () => {
        it('answers null — one undifferentiated 401 — when the claim proof fails, and reads nothing', async () => {
            const calls = githubMints();
            const { service, jobRows, installationRepos } = build({ claim: null });

            await expect(ask(service)).resolves.toBeNull();
            // Nothing is read about the job: an unauthenticated caller must
            // not be able to probe which jobs exist.
            expect(jobRows.findById).not.toHaveBeenCalled();
            expect(installationRepos.findByFullName).not.toHaveBeenCalled();
            expect(calls).toEqual([]);
        });

        it('answers null when the job row vanished between the proof and the read', async () => {
            const calls = githubMints();
            const { service } = build({ job: null });

            await expect(ask(service)).resolves.toBeNull();
            expect(calls).toEqual([]);
        });

        it('scopes ownership to the JOB’s owner, never to anything the caller sent', async () => {
            // The claim's `userId` comes from the job row. An installation
            // owned by whoever the caller would like to be does not count.
            const calls = githubMints();
            const { service } = build({
                claim: { jobId: JOB_ID, userId: OTHER_USER, nodeId: NODE_ID },
            });

            const answer = await ask(service, { userId: USER_ID });

            expect(calls).toEqual([]);
            expect(answer?.credentials).toEqual([]);
        });

        /**
         * The real claim proof, not a double: the REAL
         * `FleetJobService.authorizeRunSecretRequest` — the very method the
         * push credential and `env-files` stand on — over stub repositories.
         * These are the four checks, and each one ends the same way.
         */
        describe('through the real FleetJobService', () => {
            const sha256 = (value: string): string =>
                createHash('sha256').update(value, 'utf8').digest('hex');
            const OTHER_SECRET = 'b'.repeat(32);

            function real(jobOverrides: Record<string, unknown> = {}) {
                const job = {
                    ...jobRow(),
                    nodeId: NODE_ID,
                    status: 'running',
                    leaseGeneration: 4,
                    ...jobOverrides,
                };
                const nodeRows: Record<string, Record<string, unknown>> = {
                    [NODE_ID]: {
                        id: NODE_ID,
                        userId: USER_ID,
                        status: 'online',
                        name: 'assigned',
                        enrollmentTokenHash: sha256(SECRET),
                    },
                    // A perfectly valid node of the SAME owner, with its own
                    // valid secret — just not the one this job is on.
                    [OTHER_NODE_ID]: {
                        id: OTHER_NODE_ID,
                        userId: USER_ID,
                        status: 'online',
                        name: 'bystander',
                        enrollmentTokenHash: sha256(OTHER_SECRET),
                    },
                };
                const jobRepo = {
                    findById: jest.fn(async (id: string) => (id === JOB_ID ? job : null)),
                };
                const nodeRepo = { findById: jest.fn(async (id: string) => nodeRows[id] ?? null) };
                const jobService = new FleetJobService(
                    jobRepo as never,
                    nodeRepo as never,
                    { findForOwnedAgent: async () => null } as never,
                );
                const service = new FleetPushCredentialService(
                    jobService,
                    jobRepo as never,
                    nodeRepo as never,
                    { findById: async () => installationRow() } as never,
                    {
                        findByFullName: async () => [
                            snapshotRow('ever-works/ever-works', '556677'),
                        ],
                    } as never,
                );
                return { service };
            }

            it('serves the assigned node, holding an active claim at the current generation', async () => {
                const calls = githubMints();
                const { service } = real();

                const answer = await ask(service);

                expect(calls).toHaveLength(1);
                expect(answer?.credentials[0].repositories).toEqual(['ever-works/ever-works']);
            });

            it.each([
                [
                    'ANOTHER node with a valid secret of its own',
                    {},
                    { nodeId: OTHER_NODE_ID, secret: OTHER_SECRET },
                ],
                ['the assigned node presenting a wrong secret', {}, { secret: 'c'.repeat(32) }],
                ['an unknown node', {}, { nodeId: '99999999-9999-4999-8999-999999999999' }],
                [
                    'a job that is still queued (no node holds it)',
                    { status: 'queued', nodeId: null },
                    {},
                ],
                ['a job that already finished', { status: 'done' }, {}],
                ['a job that already failed', { status: 'failed' }, {}],
                ['a job this node no longer holds', { nodeId: OTHER_NODE_ID }, {}],
            ])(
                'refuses %s with the same null, and mints nothing',
                async (_label, jobOverrides, request) => {
                    const calls = githubMints();
                    const { service } = real(jobOverrides);

                    await expect(ask(service, request)).resolves.toBeNull();
                    expect(calls).toEqual([]);
                },
            );

            it.each([
                ['an older generation', 3],
                ['a newer generation', 5],
                ['no generation at all', undefined],
            ])(
                'refuses %s as a stale lease, and mints nothing',
                async (_label, leaseGeneration) => {
                    const calls = githubMints();
                    const { service } = real();

                    await expect(ask(service, { leaseGeneration })).rejects.toBeInstanceOf(
                        FleetJobStaleLeaseError,
                    );
                    expect(calls).toEqual([]);
                },
            );
        });
    });

    describe('nothing about the token is logged, stored or echoed', () => {
        it('logs the job, the node and the repositories — never a credential, never an installation id', async () => {
            githubMints();
            const { service, jobRows } = build({
                job: jobRow(
                    workspace({
                        mounts: [
                            {
                                repositoryId: 'ever-works/not-installed',
                                repoUrl: 'https://github.com/ever-works/not-installed.git',
                                writable: false,
                                mountDir: 'n',
                            },
                        ],
                    }),
                ),
            });
            const lines: string[] = [];
            const logger = (service as unknown as { logger: Record<string, (m: string) => void> })
                .logger;
            for (const level of ['log', 'warn', 'error']) {
                jest.spyOn(logger, level as never).mockImplementation(((message: string) => {
                    lines.push(String(message));
                }) as never);
            }

            const answer = await ask(service);

            const text = lines.join('\n');
            // The audit record says who got a credential for what…
            expect(text).toContain(JOB_ID);
            expect(text).toContain(NODE_ID);
            expect(text).toContain('ever-works/ever-works');
            expect(text).toContain(
                `ever-works/not-installed (${FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON})`,
            );
            // …and never the credential, in any form.
            expect(text).not.toContain(tokenFor([556677]));
            expect(text).not.toContain('ghs_');
            // Nothing was written on the way.
            expect(jobRows.update).not.toHaveBeenCalled();
            expect(jobRows.save).not.toHaveBeenCalled();
            // The response carries the credential and what the node needs to
            // scope it — no installation id, no numeric repository id.
            expect(Object.keys(answer ?? {}).sort()).toEqual(['credentials', 'uncovered']);
            expect(Object.keys(answer?.credentials[0] ?? {}).sort()).toEqual([
                'expiresAt',
                'repositories',
                'token',
                'username',
            ]);
            const withoutToken = JSON.stringify({
                ...answer,
                credentials: answer?.credentials.map((entry) => ({ ...entry, token: '' })),
            });
            expect(withoutToken).not.toContain('9001');
            expect(withoutToken).not.toContain('556677');
        });
    });

    describe('the push mode is unchanged by the read mode', () => {
        it('the same job still pushes with contents:write over its WRITABLE repositories only', async () => {
            const calls = githubMints();
            const { service } = build({
                job: jobRow(
                    workspace({
                        mounts: [
                            {
                                repositoryId: 'ever-works/template',
                                repoUrl: 'https://github.com/ever-works/template.git',
                                writable: true,
                                mountDir: 't',
                            },
                            {
                                repositoryId: 'ever-works/reference',
                                repoUrl: 'https://github.com/ever-works/reference.git',
                                writable: false,
                                mountDir: 'r',
                            },
                        ],
                    }),
                ),
                snapshots: {
                    'ever-works/ever-works': [snapshotRow('ever-works/ever-works', '556677')],
                    'ever-works/template': [snapshotRow('ever-works/template', '778899')],
                    'ever-works/reference': [snapshotRow('ever-works/reference', '990011')],
                },
            });

            const push = await service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: JOB_ID });

            // One token, the writable two, WRITE and nothing else — exactly
            // what the push spec pins. The shared lookup did not blur them.
            expect(calls).toHaveLength(1);
            expect(calls[0].body).toEqual({
                repository_ids: [556677, 778899],
                permissions: { contents: 'write' },
            });
            expect(push?.push?.repositories).toEqual([
                'ever-works/ever-works',
                'ever-works/template',
            ]);
        });
    });
});
