import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same stub as the other suites here: the service imports libsodium for secret encryption, which this test never uses.
vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

import { GitHubActionsService } from '../github-actions.service.js';
import type { GitHubWorkflow } from '../types.js';

/**
 * `enableDeploymentWorkflows` keeps the deploy workflows of every provider enabled and disables the rest.
 *
 * Regression (production, 2026-11-22): the Cloudflare Workers provider dispatches `deploy_cloudflare.yaml`, which
 * was missing from the allowlist, so each deploy disabled that workflow and its own dispatch then failed with
 * "Cannot trigger a 'workflow_dispatch' on a disabled workflow".
 */

const OWNER = 'ever-works';
const REPO = 'awesome-crm-website';
const TOKEN = 'token';

const workflow = (id: number, name: string, path: string): GitHubWorkflow =>
	({ id, name, path, state: 'active' }) as unknown as GitHubWorkflow;

const WORKFLOWS: GitHubWorkflow[] = [
	workflow(1, 'CI', '.github/workflows/ci.yml'),
	workflow(2, 'Cloudflare deployment', '.github/workflows/deploy_cloudflare.yaml'),
	workflow(3, 'Kubernetes Deployment', '.github/workflows/deploy_k8s.yaml'),
	workflow(4, 'Production deployment', '.github/workflows/deploy_prod.yaml'),
	workflow(5, 'Vercel Deployment', '.github/workflows/deploy_vercel.yaml'),
	workflow(6, 'k8s-build', '.github/workflows/k8s-build.yml'),
	workflow(7, 'Lighthouse CI', '.github/workflows/lighthouse.yml')
];

describe('GitHubActionsService.enableDeploymentWorkflows', () => {
	let svc: GitHubActionsService;
	let enabled: number[];
	let disabled: number[];

	beforeEach(() => {
		svc = new GitHubActionsService();
		enabled = [];
		disabled = [];
		const octokit = {
			rest: {
				actions: {
					setAllowedActionsRepository: vi.fn().mockResolvedValue({}),
					setGithubActionsPermissionsRepository: vi.fn().mockResolvedValue({})
				}
			}
		};
		vi.spyOn(svc as unknown as { createOctokit: () => unknown }, 'createOctokit').mockReturnValue(octokit);
		vi.spyOn(svc, 'listWorkflows').mockResolvedValue(WORKFLOWS);
		vi.spyOn(svc, 'enableWorkflow').mockImplementation(async (_o, _r, id) => {
			enabled.push(id as number);
		});
		vi.spyOn(svc, 'disableWorkflow').mockImplementation(async (_o, _r, id) => {
			disabled.push(id as number);
		});
	});

	it('keeps the Cloudflare deploy workflow enabled', async () => {
		await svc.enableDeploymentWorkflows(OWNER, REPO, TOKEN, undefined, false);

		expect(enabled).toContain(2);
		expect(disabled).not.toContain(2);
	});

	it('keeps every provider deploy workflow enabled and disables the others', async () => {
		await svc.enableDeploymentWorkflows(OWNER, REPO, TOKEN, undefined, false);

		expect(enabled.sort()).toEqual([2, 3, 4, 5]);
		expect(disabled.sort()).toEqual([1, 6, 7]);
	});
});
