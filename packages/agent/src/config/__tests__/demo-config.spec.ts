import { config } from '../index';

describe('config.demo', () => {
	const saved = { ...process.env };

	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key === 'DEMO' || key.startsWith('DEMO_')) delete process.env[key];
		}
	});

	afterAll(() => {
		process.env = saved;
	});

	describe('isEnabled', () => {
		it.each(['true', '1', 'YES ', 'Yes', ' TRUE'])('is true for %p', (value) => {
			process.env.DEMO = value;
			expect(config.demo.isEnabled()).toBe(true);
		});

		it.each([undefined, '', 'false', '0', 'no', 'on', 'garbage'])('is false for %p', (value) => {
			if (value === undefined) delete process.env.DEMO;
			else process.env.DEMO = value;
			expect(config.demo.isEnabled()).toBe(false);
		});
	});

	describe('sandboxTtlHours', () => {
		it('defaults to 24 when unset', () => {
			expect(config.demo.sandboxTtlHours()).toBe(24);
		});

		it.each(['abc', '', '0', '-3', '1.5', '6h'])('falls back to 24 for %p', (value) => {
			process.env.DEMO_SANDBOX_TTL_HOURS = value;
			expect(config.demo.sandboxTtlHours()).toBe(24);
		});

		it('reads a positive integer', () => {
			process.env.DEMO_SANDBOX_TTL_HOURS = '6';
			expect(config.demo.sandboxTtlHours()).toBe(6);
		});
	});

	describe('signUpUrl', () => {
		const DEFAULT = 'https://app.ever.works/register';

		it('defaults when unset', () => {
			expect(config.demo.signUpUrl()).toBe(DEFAULT);
		});

		it.each(['http://x', '/register', 'javascript:alert(1)', 'not a url', ''])('falls back for %p', (value) => {
			process.env.DEMO_SIGN_UP_URL = value;
			expect(config.demo.signUpUrl()).toBe(DEFAULT);
		});

		it('keeps an absolute https URL', () => {
			process.env.DEMO_SIGN_UP_URL = 'https://app.ever.works/register';
			expect(config.demo.signUpUrl()).toBe('https://app.ever.works/register');
			process.env.DEMO_SIGN_UP_URL = 'https://example.com/join';
			expect(config.demo.signUpUrl()).toBe('https://example.com/join');
		});
	});

	describe('string accessors', () => {
		it('githubOrg is empty when unset and trimmed when set', () => {
			expect(config.demo.githubOrg()).toBe('');
			process.env.DEMO_GITHUB_ORG = ' ever-works-demo ';
			expect(config.demo.githubOrg()).toBe('ever-works-demo');
		});

		it('repoPrefix defaults to demo-', () => {
			expect(config.demo.repoPrefix()).toBe('demo-');
			process.env.DEMO_REPO_PREFIX = 'try-';
			expect(config.demo.repoPrefix()).toBe('try-');
		});
	});

	describe('numeric limits', () => {
		const cases: Array<[string, () => number, number]> = [
			['DEMO_AI_REQUESTS_PER_SANDBOX', () => config.demo.aiRequestsPerSandbox(), 120],
			['DEMO_AI_REQUESTS_PER_DAY', () => config.demo.aiRequestsPerDay(), 900],
			['DEMO_AI_REQUESTS_PER_MINUTE', () => config.demo.aiRequestsPerMinute(), 18],
			['DEMO_MAX_WORKS_PER_SANDBOX', () => config.demo.maxWorksPerSandbox(), 3],
			['DEMO_MAX_ACTIVE_SANDBOXES', () => config.demo.maxActiveSandboxes(), 300],
			['DEMO_CREATE_PER_IP_PER_HOUR', () => config.demo.createPerIpPerHour(), 5]
		];

		it.each(cases)('%s defaults, accepts a positive integer, rejects garbage', (name, read, fallback) => {
			expect(read()).toBe(fallback);
			process.env[name] = '7';
			expect(read()).toBe(7);
			for (const bad of ['0', '-1', 'abc', '2.5', '']) {
				process.env[name] = bad;
				expect(read()).toBe(fallback);
			}
		});
	});
});
