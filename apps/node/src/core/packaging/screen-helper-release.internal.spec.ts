import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFleetHelperManifest } from '@ever-works/contracts';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The screen helper builds a node release publishes (FL-07, FR-21) → the
 * manifest `build.js` bakes into `cli.js` and the assets the release hosts.
 * 0.2.10 shipped an empty manifest because nothing produced one; these pin the
 * producer: every fingerprint is taken from the bytes, and nothing a release
 * asked for can go missing without failing the build.
 */
const appRoot = join(__dirname, '../../..');

interface HelperAsset {
	target: string;
	fileName: string;
	source: string;
	sha256: string;
}
interface HelperRelease {
	manifest: { schemaVersion: 1; version: string; targets: Record<string, { sha256: string; url: string }> };
	assets: HelperAsset[];
}
interface ReleaseModule {
	collectHelperRelease(options: { dir: string; urlBase: string; requiredTargets?: string | string[] }): HelperRelease;
	writeHelperReleaseAssets(outDir: string, release: HelperRelease): void;
	defaultUrlBase(repository: string, nodeVersion: string): string;
}
interface BuildModule {
	screenHelperRelease(nodeVersion: string, env: Record<string, string | undefined>): HelperRelease;
}

const load = <T>(file: string): T => createRequire(__filename)(join(appRoot, file)) as T;
const release = load<ReleaseModule>('screen-helper-release.js');

const BASE = 'https://github.com/ever-co/ever-works/releases/download/node-v9.9.9';
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

let dirs: string[] = [];
const tempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'ew-helper-release-'));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

/** One build as the build scripts leave it: the binary and its metadata, in `folder`. */
function writeBuild(
	folder: string,
	target: string,
	options: { bytes?: string; version?: string; metadataSha?: string; bom?: boolean; reproducible?: boolean } = {}
): string {
	mkdirSync(folder, { recursive: true });
	const bytes = options.bytes ?? `helper bytes for ${target}`;
	writeFileSync(join(folder, target === 'win32-x64' ? 'ever-works-screen.exe' : 'ever-works-screen'), bytes);
	const metadata = {
		schemaVersion: 1,
		artifact: 'ever-works-screen',
		version: options.version ?? '0.1.0',
		target,
		sha256: options.metadataSha ?? sha256(bytes),
		reproducible: options.reproducible ?? true,
		productionEligible: false
	};
	writeFileSync(
		join(folder, 'unsigned-release-metadata.json'),
		`${options.bom ? '﻿' : ''}${JSON.stringify(metadata, null, 2)}`
	);
	return sha256(bytes);
}

/** The four targets laid out like the publish workflow's downloaded artifacts. */
function allTargets(root: string): Record<string, string> {
	return {
		'linux-x64': writeBuild(join(root, 'screen-helper-linux-x64'), 'linux-x64'),
		'win32-x64': writeBuild(join(root, 'screen-helper-win32-x64'), 'win32-x64', { bom: true }),
		'darwin-arm64': writeBuild(join(root, 'ever-works-screen-macOS-unsigned'), 'darwin-arm64'),
		'darwin-x64': writeBuild(join(root, 'ever-works-screen-macOS-unsigned', 'darwin-x64'), 'darwin-x64')
	};
}

describe('screen helper release manifest', () => {
	it('publishes every build with its own fingerprint and its release URL, in the shape the node reads', () => {
		const root = tempDir();
		const hashes = allTargets(root);
		// A signed copy (sign-release.*) is not an unsigned build and is never picked up.
		writeBuild(join(root, 'ever-works-screen-macOS-unsigned', 'signed'), 'darwin-arm64', { bytes: 'signed' });

		const result = release.collectHelperRelease({
			dir: root,
			urlBase: `${BASE}/`,
			requiredTargets: 'linux-x64,win32-x64,darwin-arm64,darwin-x64'
		});

		expect(result.manifest).toEqual({
			schemaVersion: 1,
			version: '0.1.0',
			targets: {
				'darwin-arm64': { sha256: hashes['darwin-arm64'], url: `${BASE}/ever-works-screen-0.1.0-darwin-arm64` },
				'darwin-x64': { sha256: hashes['darwin-x64'], url: `${BASE}/ever-works-screen-0.1.0-darwin-x64` },
				'linux-x64': { sha256: hashes['linux-x64'], url: `${BASE}/ever-works-screen-0.1.0-linux-x64` },
				'win32-x64': { sha256: hashes['win32-x64'], url: `${BASE}/ever-works-screen-0.1.0-win32-x64.exe` }
			}
		});
		// The node re-validates the baked manifest: nothing it would drop.
		expect(parseFleetHelperManifest(result.manifest)).toEqual(result.manifest);
		expect(result.assets.map((asset) => asset.fileName)).toEqual([
			'ever-works-screen-0.1.0-darwin-arm64',
			'ever-works-screen-0.1.0-darwin-x64',
			'ever-works-screen-0.1.0-linux-x64',
			'ever-works-screen-0.1.0-win32-x64.exe'
		]);
	});

	it('refuses a binary that is not the build its metadata describes', () => {
		const root = tempDir();
		writeBuild(join(root, 'linux'), 'linux-x64', { metadataSha: 'a'.repeat(64) });
		expect(() => release.collectHelperRelease({ dir: root, urlBase: BASE })).toThrow(/not the build the metadata/);
	});

	it('fails when a required target was not built, instead of publishing a node without it', () => {
		const root = tempDir();
		writeBuild(join(root, 'linux'), 'linux-x64');
		expect(() =>
			release.collectHelperRelease({ dir: root, urlBase: BASE, requiredTargets: ['linux-x64', 'win32-x64'] })
		).toThrow(/required target\(s\) win32-x64/);
	});

	it('refuses two builds of one target, two helper versions, a non-reproducible build and a non-https base', () => {
		const twice = tempDir();
		writeBuild(join(twice, 'a'), 'linux-x64');
		writeBuild(join(twice, 'b'), 'linux-x64', { bytes: 'other' });
		expect(() => release.collectHelperRelease({ dir: twice, urlBase: BASE })).toThrow(/two builds for linux-x64/);

		const versions = tempDir();
		writeBuild(join(versions, 'a'), 'linux-x64', { version: '0.1.0' });
		writeBuild(join(versions, 'b'), 'win32-x64', { version: '0.2.0' });
		expect(() => release.collectHelperRelease({ dir: versions, urlBase: BASE })).toThrow(
			/different helper versions/
		);

		const unreproducible = tempDir();
		writeBuild(join(unreproducible, 'a'), 'linux-x64', { reproducible: false });
		expect(() => release.collectHelperRelease({ dir: unreproducible, urlBase: BASE })).toThrow(/reproducible/);

		const plain = tempDir();
		writeBuild(join(plain, 'a'), 'linux-x64');
		expect(() => release.collectHelperRelease({ dir: plain, urlBase: 'http://example.com/x' })).toThrow(/https/);
		expect(() => release.collectHelperRelease({ dir: tempDir(), urlBase: BASE })).toThrow(/no unsigned-release/);
	});

	it('stages the assets under their release names with a SHA256SUMS that sha256sum --check reads', () => {
		const root = tempDir();
		const hashes = allTargets(root);
		const out = join(tempDir(), 'assets');
		const result = release.collectHelperRelease({ dir: root, urlBase: BASE });

		release.writeHelperReleaseAssets(out, result);

		expect(readdirSync(out).sort()).toEqual([
			'SHA256SUMS',
			'ever-works-screen-0.1.0-darwin-arm64',
			'ever-works-screen-0.1.0-darwin-x64',
			'ever-works-screen-0.1.0-linux-x64',
			'ever-works-screen-0.1.0-win32-x64.exe',
			'helper-manifest.json'
		]);
		expect(readFileSync(join(out, 'SHA256SUMS'), 'utf8')).toBe(
			[
				`${hashes['darwin-arm64']}  ever-works-screen-0.1.0-darwin-arm64`,
				`${hashes['darwin-x64']}  ever-works-screen-0.1.0-darwin-x64`,
				`${hashes['linux-x64']}  ever-works-screen-0.1.0-linux-x64`,
				`${hashes['win32-x64']}  ever-works-screen-0.1.0-win32-x64.exe`,
				''
			].join('\n')
		);
		expect(sha256(readFileSync(join(out, 'ever-works-screen-0.1.0-linux-x64')))).toBe(hashes['linux-x64']);
		expect(JSON.parse(readFileSync(join(out, 'helper-manifest.json'), 'utf8'))).toEqual(result.manifest);
	});
});

describe('build.js screen helper input', () => {
	const build = load<BuildModule>('build.js');

	it('publishes no helper without builds, and refuses that when the release requires one', () => {
		const none = build.screenHelperRelease('9.9.9', {});
		expect(none.manifest.targets).toEqual({});
		expect(none.manifest.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(none.assets).toEqual([]);

		expect(() => build.screenHelperRelease('9.9.9', { SCREEN_HELPER_REQUIRED_TARGETS: 'linux-x64' })).toThrow(
			/SCREEN_HELPER_RELEASE_DIR is not set/
		);
	});

	it('points the downloads at the GitHub release of the node version tag unless told otherwise', () => {
		const root = tempDir();
		writeBuild(join(root, 'linux'), 'linux-x64');

		const tagged = build.screenHelperRelease('9.9.9', { SCREEN_HELPER_RELEASE_DIR: root });
		expect(tagged.manifest.targets['linux-x64']?.url).toBe(
			`${release.defaultUrlBase('ever-co/ever-works', '9.9.9')}/ever-works-screen-0.1.0-linux-x64`
		);
		expect(release.defaultUrlBase('ever-co/ever-works', '9.9.9')).toBe(BASE);

		const elsewhere = build.screenHelperRelease('9.9.9', {
			SCREEN_HELPER_RELEASE_DIR: root,
			SCREEN_HELPER_URL_BASE: 'https://downloads.example.test/helper'
		});
		expect(elsewhere.manifest.targets['linux-x64']?.url).toBe(
			'https://downloads.example.test/helper/ever-works-screen-0.1.0-linux-x64'
		);
	});

	it('bakes the manifest into the bundle through the define helper-manifest.ts reads', async () => {
		const esbuild = createRequire(join(appRoot, 'build.js'))('esbuild') as typeof import('esbuild');
		const manifest = {
			schemaVersion: 1,
			version: '0.1.0',
			targets: { 'linux-x64': { sha256: 'b'.repeat(64), url: `${BASE}/ever-works-screen-0.1.0-linux-x64` } }
		};
		const result = await esbuild.build({
			entryPoints: [join(appRoot, 'src/core/screen/helper/helper-manifest.ts')],
			bundle: true,
			write: false,
			platform: 'node',
			format: 'cjs',
			external: ['@ever-works/contracts'],
			define: { __EVER_WORKS_SCREEN_HELPER_MANIFEST__: JSON.stringify(manifest) },
			logLevel: 'silent'
		});
		const code = result.outputFiles[0]?.text ?? '';
		expect(code).toContain('b'.repeat(64));
		// esbuild names the define in a comment; no unreplaced read of the global survives.
		expect(code).not.toContain('typeof __EVER_WORKS_SCREEN_HELPER_MANIFEST__');
	});
});
