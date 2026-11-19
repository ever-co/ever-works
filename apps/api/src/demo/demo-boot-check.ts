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

	// Only generation (the git provider) needs the demo org; a local demo runs with git off.
	if (config.everWorks.git.isEnabled()) {
		const demoOrg = config.demo.githubOrg();
		const gitOrg = config.everWorks.git.getOrg();
		if (!demoOrg) {
			throw new Error(
				'DEMO=true with STORAGE_EVER_WORKS_GIT_ENABLED requires DEMO_GITHUB_ORG (the org that holds demo repositories).'
			);
		}
		if (demoOrg !== gitOrg) {
			throw new Error(
				`DEMO_GITHUB_ORG ("${demoOrg}") must equal EVER_WORKS_CUSTOMERS_GITHUB_ORG ("${gitOrg}") ` +
					'when STORAGE_EVER_WORKS_GIT_ENABLED is on: demo repositories are created in the latter org.'
			);
		}
	}
}
