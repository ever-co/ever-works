import { describe, expect, it } from 'vitest';
import { normalizeEverPlatformCode } from '../connection.js';

/** A code typed by a person is recognised by its kind, whatever its case, spacing or dashes. */
describe('normalizeEverPlatformCode', () => {
	it('answers the canonical spelling of a connect code and of a link code', () => {
		expect(normalizeEverPlatformCode('EVC-7K2M-9QXR-4HTB', 'connect')).toBe('EVC-7K2M-9QXR-4HTB');
		expect(normalizeEverPlatformCode('  evc-7k2m-9qxr-4htb ', 'connect')).toBe('EVC-7K2M-9QXR-4HTB');
		expect(normalizeEverPlatformCode('EVC7K2M9QXR4HTB', 'connect')).toBe('EVC-7K2M-9QXR-4HTB');
		expect(normalizeEverPlatformCode('evl 7k2m 9qxr 4htb', 'link')).toBe('EVL-7K2M-9QXR-4HTB');
	});

	it('a code of the other kind is not one', () => {
		expect(normalizeEverPlatformCode('EVL-7K2M-9QXR-4HTB', 'connect')).toBeNull();
		expect(normalizeEverPlatformCode('EVC-7K2M-9QXR-4HTB', 'link')).toBeNull();
	});

	it('refuses anything else', () => {
		for (const input of [
			'',
			'EVC',
			'EVC-7K2M-9QXR',
			'EVC-7K2M-9QXR-4HTB-0000',
			// The letters I, L, O and U never appear in a code.
			'EVC-IIII-9QXR-4HTB',
			'EVC-7K2M-LLLL-4HTB',
			'EVC-7K2M-9QXR-OOOO',
			'EVC-UUUU-9QXR-4HTB',
			'EVC-7K2M-9QXR-4HT!',
			'x'.repeat(65),
			null,
			undefined,
			42,
			{}
		]) {
			expect(normalizeEverPlatformCode(input, 'connect')).toBeNull();
		}
	});
});
