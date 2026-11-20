import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The repository creates report GitHub's id of the repository they CREATED, taken from
 * GitHub's own create response (`createInOrg`, `createForAuthenticatedUser`,
 * `createUsingTemplate`), as the optional `GitRepository.id`. The platform demo ledgers
 * that id, and its sweeper deletes a repository only when the live id equals it. A
 * repository a create merely found is answered as it was read, with no id from a create.
 *
 * GitHub's template create is asynchronous: the read-back right after it can 404 for a
 * moment. The create then answers the repository its own response described, so its id is
 * never lost, and the caller waits for it as for any new repository.
 *
 * Octokit is mocked, exactly as the sibling `github-api.service.*.spec.ts` suites do, so
 * nothing here can reach the network.
 */

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const reposGetMock = vi.fn();
const createInOrgMock = vi.fn();
const createForAuthenticatedUserMock = vi.fn();
const createUsingTemplateMock = vi.fn();
const getAuthenticatedMock = vi.fn();

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			repos: {
				get: (...args: unknown[]) => reposGetMock(...args),
				createInOrg: (...args: unknown[]) => createInOrgMock(...args),
				createForAuthenticatedUser: (...args: unknown[]) => createForAuthenticatedUserMock(...args),
				createUsingTemplate: (...args: unknown[]) => createUsingTemplateMock(...args)
			},
			users: {
				getAuthenticated: (...args: unknown[]) => getAuthenticatedMock(...args)
			}
		};
		constructor(public opts: unknown) {}
	}

	class FakeRequestError extends Error {
		constructor(
			message: string,
			public status: number
		) {
			super(message);
		}
	}

	return { Octokit: FakeOctokit, RequestError: FakeRequestError };
});

const { RequestError } = await import('octokit');
const { GitHubApiService } = await import('../github-api.service.js');

const ORG = 'ever-works-cloud';
const NAME = 'demo-1a2b3c4d-foo-website';

/** A repository payload as GitHub answers it (create responses and `repos.get` alike). */
function payload(owner: string, name: string, id: number) {
	return {
		id,
		owner: { login: owner },
		name,
		full_name: `${owner}/${name}`,
		description: null,
		default_branch: 'main',
		private: true,
		html_url: `https://github.com/${owner}/${name}`,
		clone_url: `https://github.com/${owner}/${name}.git`,
		fork: false,
		size: 10
	};
}

function notFound() {
	return new (RequestError as unknown as new (message: string, status: number) => Error)('Not Found', 404);
}

describe('GitHubApiService — the id of the repository a create made', () => {
	beforeEach(() => {
		for (const mock of [
			reposGetMock,
			createInOrgMock,
			createForAuthenticatedUserMock,
			createUsingTemplateMock,
			getAuthenticatedMock
		]) {
			mock.mockReset();
		}
		getAuthenticatedMock.mockResolvedValue({ data: { id: 1, login: 'platform-bot' } });
	});

	it('createRepository in an organization reports the id from createInOrg', async () => {
		reposGetMock.mockRejectedValue(notFound());
		createInOrgMock.mockResolvedValue({ data: payload(ORG, NAME, 812345678) });

		const created = await new GitHubApiService().createRepository({ name: NAME, organization: ORG }, 'tok');

		expect(created).toMatchObject({ owner: ORG, name: NAME, fullName: `${ORG}/${NAME}`, id: '812345678' });
	});

	it("createRepository for the token's own account reports the id from createForAuthenticatedUser", async () => {
		reposGetMock.mockRejectedValue(notFound());
		createForAuthenticatedUserMock.mockResolvedValue({ data: payload('platform-bot', NAME, 812345679) });

		const created = await new GitHubApiService().createRepository({ name: NAME }, 'tok');

		expect(created).toMatchObject({ owner: 'platform-bot', name: NAME, id: '812345679' });
	});

	it('createRepository answers an existing repository as read, with no create id', async () => {
		reposGetMock.mockResolvedValue({ data: payload(ORG, NAME, 5) });

		const found = await new GitHubApiService().createRepository({ name: NAME, organization: ORG }, 'tok');

		expect(createInOrgMock).not.toHaveBeenCalled();
		expect(found).toMatchObject({ fullName: `${ORG}/${NAME}` });
		expect(found).not.toHaveProperty('id');
	});

	it('createRepositoryFromTemplate reports the id from createUsingTemplate on the read-back', async () => {
		reposGetMock.mockRejectedValueOnce(notFound()).mockResolvedValueOnce({ data: payload(ORG, NAME, 812345680) });
		createUsingTemplateMock.mockResolvedValue({ data: payload(ORG, NAME, 812345680) });

		const created = await new GitHubApiService().createRepositoryFromTemplate(
			'ever-works',
			'directory-template',
			{ name: NAME, organization: ORG },
			'tok'
		);

		expect(created).toMatchObject({ fullName: `${ORG}/${NAME}`, defaultBranch: 'main', id: '812345680' });
	});

	it('createRepositoryFromTemplate answers the generated repository, with its id, when the read-back is not ready', async () => {
		reposGetMock.mockRejectedValue(notFound());
		createUsingTemplateMock.mockResolvedValue({ data: payload(ORG, NAME, 812345681) });

		const created = await new GitHubApiService().createRepositoryFromTemplate(
			'ever-works',
			'directory-template',
			{ name: NAME, organization: ORG },
			'tok'
		);

		expect(created).toEqual({
			owner: ORG,
			name: NAME,
			fullName: `${ORG}/${NAME}`,
			description: undefined,
			defaultBranch: 'main',
			isPrivate: true,
			url: `https://github.com/${ORG}/${NAME}`,
			cloneUrl: `https://github.com/${ORG}/${NAME}.git`,
			id: '812345681'
		});
	});

	it('createRepositoryFromTemplate answers an existing repository as read, with no create id', async () => {
		reposGetMock.mockResolvedValue({ data: payload(ORG, NAME, 5) });

		const found = await new GitHubApiService().createRepositoryFromTemplate(
			'ever-works',
			'directory-template',
			{ name: NAME, organization: ORG },
			'tok'
		);

		expect(createUsingTemplateMock).not.toHaveBeenCalled();
		expect(found).not.toHaveProperty('id');
	});
});
