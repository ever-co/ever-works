import { describe, it, expect } from 'vitest';
import {
	CloudflareConfigError,
	buildWorkerName,
	isPlatformManaged,
	resolveAccountConfig,
	resolveLabel,
	resolveWorkerIdentity,
	toDnsLabel
} from '../target';

const ACCOUNT = 'a'.repeat(32);
const PLATFORM_ACCOUNT = 'b'.repeat(32);

const noEnv = () => undefined;
const platformEnv = (name: string) =>
	({
		CLOUDFLARE_DEPLOY_API_TOKEN: 'platform-token',
		CLOUDFLARE_DEPLOY_ACCOUNT_ID: PLATFORM_ACCOUNT,
		CLOUDFLARE_DEPLOY_ZONE_NAME: 'sites.ever.works'
	})[name];

describe('resolveLabel', () => {
	it('prefers the persisted managed subdomain', () => {
		expect(resolveLabel({ managedSubdomain: 'CRM', workSlug: 'awesome-other' })).toBe('crm');
	});

	it('falls back to the slug with a leading awesome- removed', () => {
		expect(resolveLabel({ workSlug: 'awesome-mcp-servers' })).toBe('mcp-servers');
		expect(resolveLabel({ workSlug: 'time-trackers' })).toBe('time-trackers');
	});

	it('keeps a slug that is only "awesome"', () => {
		expect(resolveLabel({ workSlug: 'awesome' })).toBe('awesome');
	});

	it('falls back to the website repository name without its -website suffix', () => {
		expect(resolveLabel({}, 'awesome-crm-website')).toBe('crm');
	});

	it('throws when nothing usable is available', () => {
		expect(() => resolveLabel({}, '---')).toThrow(CloudflareConfigError);
	});
});

describe('resolveWorkerIdentity on the shared platform account', () => {
	const platform = { platformManaged: true, workerPrefix: 'ew-', zoneName: 'ever.works' } as unknown as Parameters<
		typeof resolveWorkerIdentity
	>[0];
	const member = { platformManaged: false, workerPrefix: 'ew-', zoneName: 'example.com' } as unknown as Parameters<
		typeof resolveWorkerIdentity
	>[0];

	it('refuses a slug-derived name when no managed subdomain is allocated (slugs are not unique)', () => {
		expect(() => resolveWorkerIdentity(platform, { workSlug: 'awesome-crm' })).toThrow(CloudflareConfigError);
		expect(() => resolveWorkerIdentity(platform, {}, 'awesome-crm-website')).toThrow(CloudflareConfigError);
	});

	it('uses the allocated managed subdomain', () => {
		expect(resolveWorkerIdentity(platform, { managedSubdomain: 'crm', workSlug: 'awesome-crm' })).toEqual({
			label: 'crm',
			workerName: 'ew-crm',
			hostname: 'crm.ever.works'
		});
	});

	it("still falls back to the slug on a member's own account", () => {
		expect(resolveWorkerIdentity(member, { workSlug: 'awesome-crm' }).workerName).toBe('ew-crm');
	});
});

describe('toDnsLabel / buildWorkerName', () => {
	it('normalises arbitrary text to a DNS label', () => {
		expect(toDnsLabel('  My Cool_Directory!! ')).toBe('my-cool-directory');
	});

	it('keeps the Worker name within 63 characters without a trailing hyphen', () => {
		const label = `${'x'.repeat(59)}-yyy`;
		const name = buildWorkerName('ew-', label);
		expect(name.length).toBeLessThanOrEqual(63);
		expect(name.endsWith('-')).toBe(false);
		expect(name.startsWith('ew-')).toBe(true);
	});

	it('gives two long labels with the same first 60 characters different Worker names', () => {
		const stem = 'x'.repeat(60);
		const a = buildWorkerName('ew-', `${stem}-a1b2`);
		const b = buildWorkerName('ew-', `${stem}-c3d4`);
		expect(a).not.toBe(b);
		expect(a.length).toBeLessThanOrEqual(63);
		expect(b.length).toBeLessThanOrEqual(63);
		expect(buildWorkerName('ew-', `${stem}-a1b2`)).toBe(a);
	});

	it('leaves a label that fits unchanged', () => {
		expect(buildWorkerName('ew-', 'crm')).toBe('ew-crm');
	});
});

describe('isPlatformManaged', () => {
	it('is true when the platform flags it', () => {
		expect(isPlatformManaged({ platformManaged: true }, 'member', noEnv)).toBe(true);
	});

	it('is true when the token is the operator token', () => {
		expect(isPlatformManaged({}, 'platform-token', platformEnv)).toBe(true);
		expect(isPlatformManaged({ apiToken: 'platform-token' }, undefined, platformEnv)).toBe(true);
	});

	it('is false for a member token', () => {
		expect(isPlatformManaged({}, 'member-token', platformEnv)).toBe(false);
		expect(isPlatformManaged({}, '', noEnv)).toBe(false);
	});
});

describe('resolveAccountConfig', () => {
	it("uses the member's account, zone and prefix with their own token", () => {
		const config = resolveAccountConfig(
			{ accountId: ACCOUNT.toUpperCase(), zoneName: 'Example.COM.', workerPrefix: 'site-' },
			'member-token',
			platformEnv
		);
		expect(config).toEqual({
			accountId: ACCOUNT,
			zoneName: 'example.com',
			workerPrefix: 'site-',
			platformManaged: false
		});
	});

	it('defaults the zone to ever.works and the prefix to ew-', () => {
		const config = resolveAccountConfig({ accountId: ACCOUNT }, 'member-token', noEnv);
		expect(config.zoneName).toBe('ever.works');
		expect(config.workerPrefix).toBe('ew-');
	});

	it('accepts an empty prefix', () => {
		expect(resolveAccountConfig({ accountId: ACCOUNT, workerPrefix: '' }, 't', noEnv).workerPrefix).toBe('');
	});

	it('ignores member account, zone and prefix on the platform token', () => {
		const config = resolveAccountConfig(
			{ accountId: ACCOUNT, zoneName: 'gauzy.co', workerPrefix: '' },
			'platform-token',
			platformEnv
		);
		expect(config).toEqual({
			accountId: PLATFORM_ACCOUNT,
			zoneName: 'sites.ever.works',
			workerPrefix: 'ew-',
			platformManaged: true
		});
	});

	it('prefers the resolved platform* settings over raw env reads', () => {
		const config = resolveAccountConfig(
			{ platformManaged: true, platformAccountId: ACCOUNT, platformZoneName: 'ever.works' },
			'x',
			noEnv
		);
		expect(config.accountId).toBe(ACCOUNT);
		expect(config.zoneName).toBe('ever.works');
	});

	it('requires an account id', () => {
		expect(() => resolveAccountConfig({}, 'member-token', noEnv)).toThrow(/account ID/);
		expect(() => resolveAccountConfig({ platformManaged: true }, 'x', noEnv)).toThrow(
			/CLOUDFLARE_DEPLOY_ACCOUNT_ID/
		);
	});

	it('refuses an account id that is not 32 hex characters (path injection guard)', () => {
		expect(() => resolveAccountConfig({ accountId: '../../zones' }, 't', noEnv)).toThrow(CloudflareConfigError);
	});

	it('refuses an invalid zone or prefix', () => {
		expect(() => resolveAccountConfig({ accountId: ACCOUNT, zoneName: 'not a zone' }, 't', noEnv)).toThrow(
			/zone name/
		);
		expect(() => resolveAccountConfig({ accountId: ACCOUNT, workerPrefix: '-bad' }, 't', noEnv)).toThrow(/prefix/);
	});
});

describe('resolveWorkerIdentity', () => {
	it('derives worker name and hostname', () => {
		const config = resolveAccountConfig({ accountId: ACCOUNT }, 't', noEnv);
		expect(resolveWorkerIdentity(config, { managedSubdomain: 'crm' })).toEqual({
			label: 'crm',
			workerName: 'ew-crm',
			hostname: 'crm.ever.works'
		});
	});
});
