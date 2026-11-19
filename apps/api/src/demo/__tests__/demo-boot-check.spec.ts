import { assertDemoConfig } from '../demo-boot-check';

describe('assertDemoConfig', () => {
	const saved = { ...process.env };

	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key === 'DEMO' || key.startsWith('DEMO_') || key === 'STORAGE_EVER_WORKS_GIT_ENABLED') {
				delete process.env[key];
			}
		}
		delete process.env.EVER_WORKS_CUSTOMERS_GITHUB_ORG;
	});

	afterEach(() => {
		process.env = { ...saved };
	});

	it('does not throw when the demo is off, whatever the org', () => {
		process.env.STORAGE_EVER_WORKS_GIT_ENABLED = 'true';
		process.env.DEMO_GITHUB_ORG = 'ever-works-demo';
		process.env.EVER_WORKS_CUSTOMERS_GITHUB_ORG = 'ever-works-cloud';
		expect(() => assertDemoConfig()).not.toThrow();
	});

	it('throws naming DEMO_GITHUB_ORG when on with git enabled and the orgs differ', () => {
		process.env.DEMO = 'true';
		process.env.STORAGE_EVER_WORKS_GIT_ENABLED = 'true';
		process.env.DEMO_GITHUB_ORG = 'ever-works-demo';
		process.env.EVER_WORKS_CUSTOMERS_GITHUB_ORG = 'ever-works-cloud';
		expect(() => assertDemoConfig()).toThrow(/DEMO_GITHUB_ORG/);
	});

	it('throws when on with git enabled and DEMO_GITHUB_ORG is empty', () => {
		process.env.DEMO = 'true';
		process.env.STORAGE_EVER_WORKS_GIT_ENABLED = 'true';
		process.env.EVER_WORKS_CUSTOMERS_GITHUB_ORG = 'ever-works-cloud';
		expect(() => assertDemoConfig()).toThrow(/DEMO_GITHUB_ORG/);
	});

	it('does not throw when on with git disabled and DEMO_GITHUB_ORG unset', () => {
		process.env.DEMO = 'true';
		expect(() => assertDemoConfig()).not.toThrow();
	});

	it('passes when on, git disabled and DEMO_GITHUB_ORG is set', () => {
		process.env.DEMO = 'true';
		process.env.DEMO_GITHUB_ORG = 'ever-works-demo';
		expect(() => assertDemoConfig()).not.toThrow();
	});

	it('passes when both orgs are ever-works-cloud', () => {
		process.env.DEMO = 'true';
		process.env.STORAGE_EVER_WORKS_GIT_ENABLED = 'true';
		process.env.DEMO_GITHUB_ORG = 'ever-works-cloud';
		process.env.EVER_WORKS_CUSTOMERS_GITHUB_ORG = 'ever-works-cloud';
		expect(() => assertDemoConfig()).not.toThrow();
	});
});
