import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `GitHubApiService.getRepositoryIdentity` and `getUserRepositoryPermission`
 * — the two reads the Repository Work installation fallback asks GitHub with a
 * read-only installation token (`GitFacadeService.canInstallationStandInForUser`).
 *
 *   - `getRepositoryIdentity` exists because a name is not an identity: the
 *     caller compares GitHub's `id` with the id in its installation snapshot,
 *     and the RESOLVED `full_name` with the name it asked for.
 *   - `getUserRepositoryPermission` reports the permission GitHub calculates
 *     for a user, and the id of the user the answer is ABOUT, so the caller can
 *     bind it to an account id rather than to a login.
 *
 * Both must answer the truth or throw: anything this mapping turns into a
 * positive level is what lets a Work be bound to an installation.
 *
 * Octokit is mocked, exactly as the sibling `github-api.service.*.spec.ts`
 * suites do, so nothing here can reach the network.
 */

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const getMock = vi.fn();
const getCollaboratorPermissionLevelMock = vi.fn();

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			repos: {
				get: (...args: unknown[]) => getMock(...args),
				getCollaboratorPermissionLevel: (...args: unknown[]) => getCollaboratorPermissionLevelMock(...args)
			}
		};
		constructor(public opts: unknown) {}
	}
	class RequestError extends Error {
		status: number;
		constructor(message: string, status: number) {
			super(message);
			this.status = status;
		}
	}
	return { Octokit: FakeOctokit, RequestError };
});

const { RequestError } = (await import('octokit')) as unknown as {
	RequestError: new (message: string, status: number) => Error;
};
const { GitHubApiService } = await import('../github-api.service.js');

const OWNER = 'ever-co';
const REPO = 'ever-works';
const TOKEN = 'ghs_read_only';

describe('GitHubApiService.getRepositoryIdentity', () => {
	let svc: InstanceType<typeof GitHubApiService>;

	beforeEach(() => {
		svc = new GitHubApiService();
		getMock.mockReset();
	});

	it("reads the repository by name and reports GitHub's id (as a string) and current full name", async () => {
		getMock.mockResolvedValue({ data: { id: 556677, full_name: 'ever-co/ever-works' } });

		await expect(svc.getRepositoryIdentity(OWNER, REPO, TOKEN)).resolves.toEqual({
			id: '556677',
			fullName: 'ever-co/ever-works'
		});
		expect(getMock).toHaveBeenCalledTimes(1);
		expect(getMock).toHaveBeenCalledWith({ owner: OWNER, repo: REPO });
	});

	it('reports the RESOLVED name when GitHub redirected a renamed repository, not the requested one', async () => {
		// Octokit follows the 301: the payload is the repository the old name
		// now points at.
		getMock.mockResolvedValue({ data: { id: 556677, full_name: 'ever-co/ever-works-platform' } });

		await expect(svc.getRepositoryIdentity(OWNER, REPO, TOKEN)).resolves.toEqual({
			id: '556677',
			fullName: 'ever-co/ever-works-platform'
		});
	});

	it("keeps GitHub's own casing", async () => {
		getMock.mockResolvedValue({ data: { id: 1, full_name: 'Ever-Co/Ever-Works' } });

		const identity = await svc.getRepositoryIdentity(OWNER, REPO, TOKEN);

		expect(identity?.fullName).toBe('Ever-Co/Ever-Works');
	});

	it.each([404, 403])('answers null when the token cannot see the repository (%i)', async (status) => {
		getMock.mockRejectedValue(new RequestError('nope', status));

		await expect(svc.getRepositoryIdentity(OWNER, REPO, TOKEN)).resolves.toBeNull();
	});

	it.each([401, 500])('throws anything else (%i) rather than guessing', async (status) => {
		getMock.mockRejectedValue(new RequestError('boom', status));

		await expect(svc.getRepositoryIdentity(OWNER, REPO, TOKEN)).rejects.toThrow('boom');
	});

	it('throws a non-HTTP failure', async () => {
		getMock.mockRejectedValue(new Error('socket hang up'));

		await expect(svc.getRepositoryIdentity(OWNER, REPO, TOKEN)).rejects.toThrow('socket hang up');
	});

	it.each([
		['no id', { full_name: 'ever-co/ever-works' }],
		['a non-numeric id', { id: '556677', full_name: 'ever-co/ever-works' }],
		['no full name', { id: 556677 }],
		['an empty full name', { id: 556677, full_name: '' }]
	])('answers null for a payload with %s — an identity is never invented', async (_label, data) => {
		getMock.mockResolvedValue({ data });

		await expect(svc.getRepositoryIdentity(OWNER, REPO, TOKEN)).resolves.toBeNull();
	});
});

describe('GitHubApiService.getUserRepositoryPermission', () => {
	let svc: InstanceType<typeof GitHubApiService>;

	beforeEach(() => {
		svc = new GitHubApiService();
		getCollaboratorPermissionLevelMock.mockReset();
	});

	it('asks GitHub about the named user on the named repository', async () => {
		getCollaboratorPermissionLevelMock.mockResolvedValue({
			data: { permission: 'read', role_name: 'read', user: { id: 9001, login: 'octo-member' } }
		});

		await svc.getUserRepositoryPermission(OWNER, REPO, 'octo-member', TOKEN);

		expect(getCollaboratorPermissionLevelMock).toHaveBeenCalledTimes(1);
		expect(getCollaboratorPermissionLevelMock).toHaveBeenCalledWith({
			owner: OWNER,
			repo: REPO,
			username: 'octo-member'
		});
	});

	it.each(['admin', 'write', 'read', 'none'] as const)(
		'reports the `%s` base role as GitHub calculated it',
		async (permission) => {
			getCollaboratorPermissionLevelMock.mockResolvedValue({
				data: { permission, role_name: permission, user: { id: 9001, login: 'octo-member' } }
			});

			await expect(svc.getUserRepositoryPermission(OWNER, REPO, 'octo-member', TOKEN)).resolves.toEqual({
				permission,
				userId: '9001',
				login: 'octo-member'
			});
		}
	);

	it.each([
		['an unknown value', 'maintain'],
		['an empty string', ''],
		['a missing value', undefined],
		['a non-string', 4]
	])('reports %s as `none` — never as access', async (_label, permission) => {
		getCollaboratorPermissionLevelMock.mockResolvedValue({
			data: { permission, user: { id: 9001, login: 'octo-member' } }
		});

		const result = await svc.getUserRepositoryPermission(OWNER, REPO, 'octo-member', TOKEN);

		expect(result?.permission).toBe('none');
	});

	it('does not read the permission off `role_name` or the nested `permissions` flags', async () => {
		getCollaboratorPermissionLevelMock.mockResolvedValue({
			data: {
				permission: 'none',
				role_name: 'admin',
				user: { id: 9001, login: 'octo-member', permissions: { pull: true, push: true, admin: true } }
			}
		});

		const result = await svc.getUserRepositoryPermission(OWNER, REPO, 'octo-member', TOKEN);

		expect(result?.permission).toBe('none');
	});

	it('reports the id of the user GitHub answered ABOUT, so a caller can bind the answer to an account', async () => {
		// The login was asked for; a different account now holds it.
		getCollaboratorPermissionLevelMock.mockResolvedValue({
			data: { permission: 'admin', user: { id: 7777, login: 'octo-member' } }
		});

		await expect(svc.getUserRepositoryPermission(OWNER, REPO, 'octo-member', TOKEN)).resolves.toEqual({
			permission: 'admin',
			userId: '7777',
			login: 'octo-member'
		});
	});

	it.each([
		['no user object', { permission: 'read', user: null }],
		['a user without an id', { permission: 'read', user: { login: 'octo-member' } }],
		['a user with a non-numeric id', { permission: 'read', user: { id: '9001', login: 'octo-member' } }]
	])('reports a null userId for %s', async (_label, data) => {
		getCollaboratorPermissionLevelMock.mockResolvedValue({ data });

		const result = await svc.getUserRepositoryPermission(OWNER, REPO, 'octo-member', TOKEN);

		expect(result?.userId).toBeNull();
	});

	it('answers null when GitHub answers 404 for that user or repository', async () => {
		getCollaboratorPermissionLevelMock.mockRejectedValue(new RequestError('Not Found', 404));

		await expect(svc.getUserRepositoryPermission(OWNER, REPO, 'ghost', TOKEN)).resolves.toBeNull();
	});

	it.each([401, 403, 500])('throws anything else (%i) rather than guessing', async (status) => {
		getCollaboratorPermissionLevelMock.mockRejectedValue(new RequestError('boom', status));

		await expect(svc.getUserRepositoryPermission(OWNER, REPO, 'octo-member', TOKEN)).rejects.toThrow('boom');
	});
});
