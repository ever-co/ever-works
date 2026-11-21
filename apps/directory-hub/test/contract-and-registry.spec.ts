import { describe, expect, it } from 'vitest';

import { matchesTaxonomy, normalizeText, prepareText, scoreItem, tokenize, tokenScore } from '../src/contract';
import { httpsOrigin, parseRegistry, RegistryError, resolveEntry } from '../src/registry';
import { registryDocument } from './fixtures';

describe('Contract v1 helpers', () => {
	const text = prepareText({ name: 'Toggl Track', description: 'Simple time tracker', taxonomy: ['Timers'] });

	it('pins the Contract v1 token weights', () => {
		expect(tokenScore('toggl track', text)).toBe(8); // whole name
		expect(tokenScore('tog', text)).toBe(5); // a name word starts with it
		expect(tokenScore('ggl', text)).toBe(3); // the name contains it
		expect(tokenScore('timer', text)).toBe(2); // category only ("time tracker" does not contain "timer")
		expect(tokenScore('track', text)).toBe(5 + 1); // name word prefix + description ("tracker")
		expect(tokenScore('simple', text)).toBe(1); // description only
		expect(tokenScore('nothing', text)).toBe(0);
	});

	it('requires every token, adds +10 for the whole name and +0.5 when featured', () => {
		expect(scoreItem(['toggl', 'nothing'], text)).toBe(0);
		expect(scoreItem(['toggl'], text)).toBe(5);
		expect(scoreItem(['toggl', 'track'], text, 'toggl track', true)).toBe(5 + 6 + 10 + 0.5);
	});

	it('normalizes accents and tokenizes any script', () => {
		expect(normalizeText('Café Éclair')).toBe('cafe eclair');
		expect(tokenize('Open-source CRM, open source!')).toEqual(['open', 'source', 'crm']);
		expect(tokenize('東京 tools')).toEqual(['東京', 'tools']);
	});

	it('matches taxonomy by id, name or slug, and non-Latin names as text', () => {
		expect(matchesTaxonomy(['sales-crm'], ['Sales CRM'], 'Sales CRM')).toBe(true);
		expect(matchesTaxonomy(['sales-crm'], ['Sales CRM'], 'sales-crm')).toBe(true);
		expect(matchesTaxonomy(['x'], ['東京'], '東京')).toBe(true);
		expect(matchesTaxonomy(['x'], ['大阪'], '東京')).toBe(false);
	});
});

describe('Directory Registry', () => {
	it('keeps listed HTTPS origins, derives ids, drops duplicates', () => {
		const registry = parseRegistry(registryDocument());
		expect(registry.name).toBe('Test directories');
		expect(registry.entries.map((entry) => entry.id)).toEqual([
			'timetrack',
			'crm',
			'mcp-servers',
			'managed-databases',
			'old',
			'down',
			'mismatch'
		]);
		const crm = registry.entries.find((entry) => entry.id === 'crm');
		expect(crm?.url).toBe('https://crm.ever.works');
		expect(crm?.aliases).toEqual(['customer relationship management']);
	});

	it('accepts a Contract v1 items.json as a "directory of directories"', () => {
		const registry = parseRegistry({
			version: 1,
			items: [
				{
					slug: 'crm',
					name: 'Awesome CRM',
					website: 'https://crm.ever.works',
					categories: ['Sales'],
					tags: ['CRM']
				},
				{ slug: 'no-site', name: 'No website' }
			]
		});
		expect(registry.entries).toHaveLength(1);
		expect(registry.entries[0]).toMatchObject({
			id: 'crm',
			url: 'https://crm.ever.works',
			topics: ['Sales', 'CRM']
		});
	});

	it('rejects documents of any other shape', () => {
		expect(() => parseRegistry({ version: 2, directories: [] })).toThrow(RegistryError);
		expect(() => parseRegistry({ version: 1 })).toThrow(RegistryError);
		expect(() => parseRegistry(null)).toThrow(RegistryError);
	});

	it('only accepts https origins without credentials', () => {
		expect(httpsOrigin('https://crm.ever.works/a/b?c')).toBe('https://crm.ever.works');
		expect(httpsOrigin('http://crm.ever.works')).toBeNull();
		expect(httpsOrigin('https://user:pass@crm.ever.works')).toBeNull();
		expect(httpsOrigin('javascript:alert(1)')).toBeNull();
	});

	it('resolves ids, hostnames and origins, and nothing outside the registry', () => {
		const registry = parseRegistry(registryDocument());
		expect(resolveEntry(registry, 'CRM')?.id).toBe('crm');
		expect(resolveEntry(registry, 'crm.ever.works')?.id).toBe('crm');
		expect(resolveEntry(registry, 'https://crm.ever.works/')?.id).toBe('crm');
		expect(resolveEntry(registry, 'https://attacker.example.com')).toBeUndefined();
		expect(resolveEntry(registry, 'hidden')).toBeUndefined();
		expect(resolveEntry(registry, '')).toBeUndefined();
	});
});
