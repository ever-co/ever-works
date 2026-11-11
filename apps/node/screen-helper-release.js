/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Desktop view & control (FL-07, FR-21) — the screen helper builds an
 * `ever-works-node` release publishes, turned into the manifest the node bakes in.
 *
 * Input: a folder holding the outputs of the helper's reproducible release
 * builds (`apps/node/native/ever-works-screen/build-release-linux.sh`,
 * `build-release.sh`, `build-release.ps1`): for each target, the binary and its
 * `unsigned-release-metadata.json`, in any sub-folder (one per CI artifact).
 * Output: the manifest (`helper-manifest.schema.json`: per target the SHA-256 and
 * the https URL `helper install` downloads it from) and the release assets, the
 * binaries under the names those URLs end in, with a `SHA256SUMS` beside them.
 *
 * Every fingerprint is taken from the bytes, not only from the metadata: a
 * binary that does not hash to its metadata's `sha256` fails, so the node can
 * never bake a fingerprint of a file the release does not host. Nothing is
 * dropped quietly: an unreadable metadata file, a target built twice, two helper
 * versions or a missing required target all fail.
 *
 * Used by `build.js` (SCREEN_HELPER_RELEASE_DIR, see there) and, as a check
 * without a monorepo install, by the Screen Helper workflow:
 *   node screen-helper-release.js --dir <builds> --url-base <https://…> [--require a,b] [--out <dir>]
 * Node built-ins only, on purpose.
 */
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** The targets a helper is built for (contracts `FLEET_HELPER_TARGETS`). */
const HELPER_TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'];
const METADATA_FILE = 'unsigned-release-metadata.json';
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const HELPER_VERSION = /^[A-Za-z0-9.+_-]{1,32}$/;
/** What contracts `parseFleetHelperManifest` accepts as a target URL. */
const HTTPS_URL = /^https:\/\/[^\s]{1,2000}$/;

/** The file a target's build writes, and the name its release asset carries. */
function binaryFileName(target) {
	return target === 'win32-x64' ? 'ever-works-screen.exe' : 'ever-works-screen';
}

function assetFileName(version, target) {
	return `ever-works-screen-${version}-${target}${target === 'win32-x64' ? '.exe' : ''}`;
}

/** Where a release's assets live: this repository's GitHub release for the node's tag. */
function defaultUrlBase(repository, nodeVersion) {
	return `https://github.com/${repository}/releases/download/node-v${nodeVersion}`;
}

function sha256Of(file) {
	return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Every metadata file below `dir` (three folders deep at most: one per CI artifact, one per target). */
function findMetadataFiles(dir, depth = 0) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const full = path.join(dir, entry.name);
		if (entry.isFile() && entry.name === METADATA_FILE) found.push(full);
		else if (entry.isDirectory() && depth < 3 && entry.name !== 'signed')
			found.push(...findMetadataFiles(full, depth + 1));
	}
	return found;
}

function readMetadata(file) {
	// build-release.ps1 writes UTF-8, with a byte order mark on Windows PowerShell 5.1.
	const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
	let value;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`${file}: not JSON (${error.message})`);
	}
	const problems = [];
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file}: not an object`);
	if (value.schemaVersion !== 1) problems.push('schemaVersion is not 1');
	if (value.artifact !== 'ever-works-screen') problems.push('artifact is not ever-works-screen');
	if (!HELPER_TARGETS.includes(value.target)) problems.push(`unknown target ${JSON.stringify(value.target)}`);
	if (typeof value.version !== 'string' || !HELPER_VERSION.test(value.version)) problems.push('bad version');
	if (typeof value.sha256 !== 'string' || !HEX_SHA256.test(value.sha256)) problems.push('bad sha256');
	if (value.reproducible !== true) problems.push('not a reproducible build (reproducible is not true)');
	if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`);
	return value;
}

function normaliseUrlBase(urlBase) {
	const base = String(urlBase ?? '').replace(/\/+$/, '');
	if (!/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(base)) {
		throw new Error(`the helper URL base must be an https URL without query or fragment (got "${urlBase}")`);
	}
	return base;
}

function parseTargetList(value) {
	if (value === undefined || value === null || value === '') return [];
	const list = (Array.isArray(value) ? value : String(value).split(','))
		.map((target) => String(target).trim())
		.filter(Boolean);
	for (const target of list) {
		if (!HELPER_TARGETS.includes(target)) throw new Error(`unknown helper target "${target}"`);
	}
	return [...new Set(list)];
}

/**
 * Read the release builds under `dir` → `{ manifest, assets }`.
 * `assets`: `{ target, fileName, source, sha256 }`, sorted by target.
 */
function collectHelperRelease({ dir, urlBase, requiredTargets = [] }) {
	if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
		throw new Error(`the screen helper builds folder does not exist: ${dir}`);
	}
	const base = normaliseUrlBase(urlBase);
	const required = parseTargetList(requiredTargets);
	const metadataFiles = findMetadataFiles(dir);
	if (metadataFiles.length === 0) throw new Error(`no ${METADATA_FILE} under ${dir}`);

	const byTarget = new Map();
	let version = null;
	for (const file of metadataFiles) {
		const metadata = readMetadata(file);
		if (byTarget.has(metadata.target)) {
			throw new Error(
				`two builds for ${metadata.target}: ${byTarget.get(metadata.target).metadataFile} and ${file}`
			);
		}
		if (version !== null && metadata.version !== version) {
			throw new Error(
				`the builds are of different helper versions (${version} and ${metadata.version} in ${file})`
			);
		}
		version = metadata.version;
		const source = path.join(path.dirname(file), binaryFileName(metadata.target));
		if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
			throw new Error(`${file}: the ${metadata.target} binary is not beside it (${source})`);
		}
		const sha256 = sha256Of(source);
		if (sha256 !== metadata.sha256) {
			throw new Error(
				`${source} hashes to ${sha256}, but its metadata says ${metadata.sha256}: not the build the metadata describes`
			);
		}
		byTarget.set(metadata.target, { metadataFile: file, source, sha256 });
	}
	const missing = required.filter((target) => !byTarget.has(target));
	if (missing.length) {
		throw new Error(`no build for the required target(s) ${missing.join(', ')} under ${dir}`);
	}

	const targets = {};
	const assets = [];
	for (const target of HELPER_TARGETS.filter((t) => byTarget.has(t)).sort()) {
		const { source, sha256 } = byTarget.get(target);
		const fileName = assetFileName(version, target);
		const url = `${base}/${encodeURIComponent(fileName)}`;
		if (!HTTPS_URL.test(url)) throw new Error(`not a URL the node accepts: ${url}`);
		targets[target] = { sha256, url };
		assets.push({ target, fileName, source, sha256 });
	}
	return { manifest: { schemaVersion: 1, version, targets }, assets };
}

/** The manifest of a node built without helper builds: nothing published (`helper install` says so). */
function unreleasedManifest(version) {
	if (!HELPER_VERSION.test(version)) throw new Error(`bad helper version "${version}"`);
	return { schemaVersion: 1, version, targets: {} };
}

/** The helper version the crate declares (Cargo.toml `version`). */
function readHelperCrateVersion(crateDir) {
	const cargo = fs.readFileSync(path.join(crateDir, 'Cargo.toml'), 'utf8');
	const match = /^version\s*=\s*"([^"]+)"/m.exec(cargo);
	if (!match) throw new Error(`${crateDir}/Cargo.toml: no version`);
	return match[1];
}

/** Copy the assets to `outDir` under their release names, with `SHA256SUMS` and the manifest. */
function writeHelperReleaseAssets(outDir, { manifest, assets }) {
	fs.rmSync(outDir, { recursive: true, force: true });
	fs.mkdirSync(outDir, { recursive: true });
	const sums = [];
	for (const asset of assets) {
		const destination = path.join(outDir, asset.fileName);
		fs.copyFileSync(asset.source, destination);
		if (sha256Of(destination) !== asset.sha256) throw new Error(`${destination}: changed while copying`);
		sums.push(`${asset.sha256}  ${asset.fileName}`);
	}
	fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
	fs.writeFileSync(path.join(outDir, 'helper-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function parseArgs(argv) {
	const options = {};
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (!['--dir', '--url-base', '--require', '--out'].includes(flag) || value === undefined) {
			throw new Error(
				'usage: node screen-helper-release.js --dir <builds> --url-base <https://…> [--require a,b] [--out <dir>]'
			);
		}
		options[flag.slice(2)] = value;
		i += 1;
	}
	if (!options.dir || !options['url-base']) throw new Error('--dir and --url-base are required');
	return options;
}

if (require.main === module) {
	try {
		const options = parseArgs(process.argv.slice(2));
		const release = collectHelperRelease({
			dir: options.dir,
			urlBase: options['url-base'],
			requiredTargets: options.require
		});
		if (options.out) writeHelperReleaseAssets(options.out, release);
		process.stdout.write(`${JSON.stringify(release.manifest, null, 2)}\n`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}

module.exports = {
	HELPER_TARGETS,
	assetFileName,
	collectHelperRelease,
	defaultUrlBase,
	parseTargetList,
	readHelperCrateVersion,
	unreleasedManifest,
	writeHelperReleaseAssets
};
