import { config } from '@ever-works/agent/config';

/**
 * Boot-time guard for platform demo mode. Runs only when `DEMO` is on.
 *
 * Demo repos live in the one org `DEMO_GITHUB_ORG`, and the demo only ever
 * deletes repos in that org. When the Ever Works git provider is enabled it
 * creates repos in `EVER_WORKS_CUSTOMERS_GITHUB_ORG`, so the two MUST be the
 * same org; otherwise demo repos would be created where cleanup never looks.
 * Throws an `Error` naming the env vars so a misconfigured instance fails to boot.
 */
export function assertDemoConfig(): void {
	if (!config.demo.isEnabled()) return;

	const demoOrg = config.demo.githubOrg();
	if (!demoOrg) {
		throw new Error('DEMO=true requires DEMO_GITHUB_ORG to be set to the GitHub org that holds demo repositories.');
	}

	if (config.everWorks.git.isEnabled()) {
		const gitOrg = config.everWorks.git.getOrg();
		if (demoOrg !== gitOrg) {
			throw new Error(
				`DEMO_GITHUB_ORG ("${demoOrg}") must equal EVER_WORKS_CUSTOMERS_GITHUB_ORG ("${gitOrg}") ` +
					'when STORAGE_EVER_WORKS_GIT_ENABLED is on: demo repositories are created in the latter org.'
			);
		}
	}
}
