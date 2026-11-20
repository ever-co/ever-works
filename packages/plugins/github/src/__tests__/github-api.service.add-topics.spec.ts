import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `addRepositoryTopics` adds topics to a repository and keeps the ones it has
 * (GitHub's topics endpoint REPLACES the whole list, so the current list is read
 * first and the union written back). The platform demo tags every repository a
 * demo sandbox creates with `ever-works-demo`, so an operator can find a demo
 * repository that escaped the sweeper.
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

const getAllTopicsMock = vi.fn();
const replaceAllTopicsMock = vi.fn();

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			repos: {
				getAllTopics: (...args: unknown[]) => getAllTopicsMock(...args),
				replaceAllTopics: (...args: unknown[]) => replaceAllTopicsMock(...args)
			}
		};
		constructor(public opts: unknown) {}
	}
	return {
		Octokit: FakeOctokit,
		RequestError: class RequestError extends Error {}
	};
});

const { GitHubApiService } = await import('../github-api.service.js');

const OWNER = 'ever-works-cloud';
const REPO = 'demo-1a2b3c4d-foo-website';

describe('GitHubApiService.addRepositoryTopics', () => {
	beforeEach(() => {
		getAllTopicsMock.mockReset();
		replaceAllTopicsMock.mockReset();
		replaceAllTopicsMock.mockResolvedValue({ data: { names: [] } });
	});

	it('writes the topic beside the ones the repository already has', async () => {
		getAllTopicsMock.mockResolvedValue({ data: { names: ['directory'] } });

		await new GitHubApiService().addRepositoryTopics(OWNER, REPO, ['ever-works-demo'], 'tok');

		expect(getAllTopicsMock).toHaveBeenCalledWith({ owner: OWNER, repo: REPO });
		expect(replaceAllTopicsMock).toHaveBeenCalledWith({
			owner: OWNER,
			repo: REPO,
			names: ['directory', 'ever-works-demo']
		});
	});

	it('tags a repository that has no topics yet', async () => {
		getAllTopicsMock.mockResolvedValue({ data: { names: [] } });

		await new GitHubApiService().addRepositoryTopics(OWNER, REPO, ['ever-works-demo'], 'tok');

		expect(replaceAllTopicsMock).toHaveBeenCalledWith({
			owner: OWNER,
			repo: REPO,
			names: ['ever-works-demo']
		});
	});

	it('writes nothing when every topic is already there', async () => {
		getAllTopicsMock.mockResolvedValue({ data: { names: ['ever-works-demo'] } });

		await new GitHubApiService().addRepositoryTopics(OWNER, REPO, ['ever-works-demo'], 'tok');

		expect(replaceAllTopicsMock).not.toHaveBeenCalled();
	});

	it('lets a GitHub refusal reach the caller', async () => {
		getAllTopicsMock.mockResolvedValue({ data: { names: [] } });
		replaceAllTopicsMock.mockRejectedValue(new Error('Resource not accessible'));

		await expect(
			new GitHubApiService().addRepositoryTopics(OWNER, REPO, ['ever-works-demo'], 'tok')
		).rejects.toThrow('Resource not accessible');
	});
});
