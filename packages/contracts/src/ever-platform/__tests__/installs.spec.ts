import { describe, expect, it } from 'vitest';
import {
	EVER_INSTALL_DETAIL_TOKENS,
	EVER_INSTALL_STATE_EVENT,
	installStatusReport,
	isInstallFeedEventType,
	parseInstallFeedMessage
} from '../installs.js';

const INSTALL = '01JZ8Q3M4N5P6R7S8T9V0W1X2Y';
const LISTING = '01JZ8Q3M4N5P6R7S8T9V0W1X3A';
const ORG = '01JZ8Q3M4N5P6R7S8T9V0W1X4B';
const INSTANCE = '01JZ8Q3M4N5P6R7S8T9V0W1X5C';
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;

/** A plugin request as Ever Platform sends it to the target installation. */
const requested = (extra: Record<string, unknown> = {}) => ({
	install_id: INSTALL,
	listing_id: LISTING,
	org_id: ORG,
	instance_id: INSTANCE,
	mechanism: 'instance_plugin',
	state: 'requested',
	listing_slug: 'timeclock',
	edition_key: 'free',
	package: { registry: 'npm', id: '@acme/timeclock', version_range: '^1.0.0' },
	...extra
});

/** The command spelling with an exact version and the integrity. */
const command = (extra: Record<string, unknown> = {}) => ({
	install_id: INSTALL,
	kind: 'instance_plugin',
	listing_slug: 'timeclock',
	package: '@acme/timeclock',
	version: '1.2.3',
	integrity: INTEGRITY,
	edition_key: 'free',
	...extra
});

describe('install requests on the feed', () => {
	it('valid_instance_plugin_command: a requested plugin install is read with its coordinates', () => {
		const message = parseInstallFeedMessage(EVER_INSTALL_STATE_EVENT, requested());
		expect(message).toEqual({
			kind: 'requested',
			request: {
				installId: INSTALL,
				listingSlug: 'timeclock',
				source: { kind: 'registry', registry: 'npm', packageName: '@acme/timeclock' },
				version: '^1.0.0',
				versionIsExact: false,
				integrity: null,
				editionKey: 'free',
				orgId: ORG,
				instanceId: INSTANCE
			}
		});

		const pinned = parseInstallFeedMessage('install_requested', command());
		expect(pinned).toMatchObject({
			kind: 'requested',
			request: { version: '1.2.3', versionIsExact: true, integrity: INTEGRITY }
		});
	});

	it('an exact version and the integrity on the state event are read too', () => {
		const message = parseInstallFeedMessage(
			EVER_INSTALL_STATE_EVENT,
			requested({ version: '1.4.0', integrity: INTEGRITY })
		);
		expect(message).toMatchObject({
			kind: 'requested',
			request: { version: '1.4.0', versionIsExact: true, integrity: INTEGRITY }
		});
	});

	it('extra_field_rejected: a field outside the closed set is refused with its path', () => {
		expect(parseInstallFeedMessage(EVER_INSTALL_STATE_EVENT, requested({ tenant_name: 'Acme' }))).toEqual({
			kind: 'rejected',
			path: '/tenant_name',
			code: 'unknown_field'
		});
		expect(
			parseInstallFeedMessage(
				EVER_INSTALL_STATE_EVENT,
				requested({ package: { registry: 'npm', id: '@acme/timeclock', url: 'https://x' } })
			)
		).toEqual({ kind: 'rejected', path: '/package/url', code: 'unknown_field' });
		expect(parseInstallFeedMessage('install_requested', command({ tenant_name: 'Acme' }))).toEqual({
			kind: 'rejected',
			path: '/tenant_name',
			code: 'unknown_field'
		});
		// Control: the same message without the extra field is read.
		expect(parseInstallFeedMessage(EVER_INSTALL_STATE_EVENT, requested()).kind).toBe('requested');
	});

	it('missing_integrity_rejected: the command spelling requires the integrity', () => {
		const { integrity: _omitted, ...withoutIntegrity } = command();
		expect(parseInstallFeedMessage('install_requested', withoutIntegrity)).toEqual({
			kind: 'rejected',
			path: '/integrity',
			code: 'required'
		});
		expect(parseInstallFeedMessage('install_requested', command({ integrity: 'md5-abc' }))).toEqual({
			kind: 'rejected',
			path: '/integrity',
			code: 'invalid'
		});
	});

	it('a plugin request without a package or a slug is refused', () => {
		const { package: _package, ...withoutPackage } = requested();
		expect(parseInstallFeedMessage(EVER_INSTALL_STATE_EVENT, withoutPackage)).toEqual({
			kind: 'rejected',
			path: '/package',
			code: 'not_an_object'
		});
		const { listing_slug: _slug, ...withoutSlug } = requested();
		expect(parseInstallFeedMessage(EVER_INSTALL_STATE_EVENT, withoutSlug)).toEqual({
			kind: 'rejected',
			path: '/listing_slug',
			code: 'required'
		});
	});

	it('a package name that is not an npm name, or a malformed id, is refused', () => {
		expect(
			parseInstallFeedMessage(
				EVER_INSTALL_STATE_EVENT,
				requested({ package: { registry: 'npm', id: '../../etc/passwd' } })
			)
		).toMatchObject({ kind: 'rejected', path: '/package/id' });
		expect(parseInstallFeedMessage(EVER_INSTALL_STATE_EVENT, requested({ install_id: 'not-a-ulid' }))).toEqual({
			kind: 'rejected',
			path: '/install_id',
			code: 'invalid'
		});
		expect(parseInstallFeedMessage('install_requested', command({ package: '@acme/timeclock@1.0.0' }))).toEqual({
			kind: 'rejected',
			path: '/package',
			code: 'invalid'
		});
	});

	it('blueprint_variant_left_to_other_handler: a blueprint install is not a plugin request', () => {
		expect(
			parseInstallFeedMessage(EVER_INSTALL_STATE_EVENT, {
				install_id: INSTALL,
				listing_id: LISTING,
				org_id: ORG,
				mechanism: 'works_blueprint',
				state: 'requested'
			})
		).toEqual({ kind: 'other_mechanism', installId: INSTALL, mechanism: 'works_blueprint' });
		expect(
			parseInstallFeedMessage('install_requested', {
				install_id: INSTALL,
				kind: 'works_blueprint',
				listing_slug: 'cal'
			})
		).toEqual({ kind: 'other_mechanism', installId: INSTALL, mechanism: 'works_blueprint' });
	});

	it('cancelled withdraws, removed asks for a removal, every other state is only a state', () => {
		expect(parseInstallFeedMessage(EVER_INSTALL_STATE_EVENT, requested({ state: 'cancelled' }))).toEqual({
			kind: 'withdrawn',
			installId: INSTALL
		});
		expect(parseInstallFeedMessage(EVER_INSTALL_STATE_EVENT, requested({ state: 'removed' }))).toEqual({
			kind: 'remove_requested',
			installId: INSTALL
		});
		expect(parseInstallFeedMessage(EVER_INSTALL_STATE_EVENT, requested({ state: 'installed' }))).toEqual({
			kind: 'state',
			installId: INSTALL,
			state: 'installed'
		});
		expect(parseInstallFeedMessage('install_withdrawn', { install_id: INSTALL })).toEqual({
			kind: 'withdrawn',
			installId: INSTALL
		});
		expect(parseInstallFeedMessage('remove_requested', { install_id: INSTALL, reason: 'x' })).toEqual({
			kind: 'rejected',
			path: '/reason',
			code: 'unknown_field'
		});
	});

	it('the message types are recognised; nothing else is', () => {
		expect(isInstallFeedEventType(EVER_INSTALL_STATE_EVENT)).toBe(true);
		expect(isInstallFeedEventType('install_requested')).toBe(true);
		expect(isInstallFeedEventType('ever.consent.integration.enabled')).toBe(false);
		expect(parseInstallFeedMessage('ever.consent.integration.enabled', {})).toEqual({
			kind: 'rejected',
			path: '#type',
			code: 'invalid'
		});
	});
});

describe('install status reports', () => {
	it('status_detail_enum_closed: a detail outside the tokens is sent as unknown', () => {
		expect(EVER_INSTALL_DETAIL_TOKENS).toEqual([
			'checksum_mismatch',
			'incompatible_version',
			'installer_disabled',
			'permission_denied',
			'unknown'
		]);
		expect(installStatusReport({ state: 'failed', detail: 'checksum_mismatch' })).toEqual({
			state: 'failed',
			detail: 'checksum_mismatch'
		});
		expect(installStatusReport({ state: 'failed', detail: 'ENOENT /app/plugins' as never })).toEqual({
			state: 'failed',
			detail: 'unknown'
		});
	});

	it('the version travels only with installed, the detail only with failed', () => {
		expect(installStatusReport({ state: 'installed', version: '1.2.3', externalRef: 'timeclock' })).toEqual({
			state: 'installed',
			version: '1.2.3',
			external_ref: 'timeclock'
		});
		expect(installStatusReport({ state: 'installing', version: '1.2.3', detail: 'unknown' })).toEqual({
			state: 'installing'
		});
		expect(() => installStatusReport({ state: 'delivered' as never })).toThrow(TypeError);
	});
});
