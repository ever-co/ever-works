/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Stage the publishable `ever-works-node` package under `dist-bundle/`.
 *
 * The workspace package stays `private` — its manifest depends on
 * `workspace:*` packages (`@ever-works/contracts`, `@ever-works/plugin`,
 * `@ever-works/local-workspace-plugin`), some of which are not on the
 * public registry, so publishing it as-is would produce a package nobody
 * can install. Instead, like `apps/cli`, the CLI is bundled with esbuild
 * into ONE file with those packages inlined, and a small public manifest
 * is generated beside it:
 *
 *   dist-bundle/
 *     cli.js            the whole node, single file, CommonJS, shebang
 *     package.json      public manifest (bin, engines, optional native addons)
 *     helper-manifest.json  the screen helper builds this version publishes
 *                       (the copy baked into cli.js is the one the node reads)
 *     packaging/        systemd unit + Windows install/uninstall scripts
 *     README.md, LICENSE
 *
 * The screen helper (FL-07): with SCREEN_HELPER_RELEASE_DIR pointing at the
 * helper's reproducible release builds (one folder per target, each with its
 * `unsigned-release-metadata.json`), their fingerprints and download URLs are
 * baked into `cli.js` (`src/core/screen/helper/helper-manifest.ts`) and the
 * binaries are staged in `dist-screen-helper/` under their release names, for
 * the release to host. See `screen-helper-release.js`. Optional:
 *   SCREEN_HELPER_URL_BASE          where those assets are hosted (default: this
 *                                   repository's GitHub release `node-v<version>`)
 *   SCREEN_HELPER_REQUIRED_TARGETS  comma list; fail unless each one is built
 * Without SCREEN_HELPER_RELEASE_DIR the bundle publishes no helper (`helper
 * install` says so), unless SCREEN_HELPER_REQUIRED_TARGETS asks for one.
 *
 * The runtime dependencies left external are native addons, each
 * `require()`d lazily by a caller that degrades without it, so each ships
 * as an OPTIONAL dependency (see `bundleExternals`):
 *   - `@napi-rs/keyring` — the secret store; without it the credential
 *     stays in the owner-locked config file instead of the keychain;
 *   - the PTY prebuild — the `pty-local` terminal host; without it a live
 *     view's terminal channel runs on that plugin's pipe floor, and the
 *     session daemon withdraws `sessions`.
 *
 * Optional, not regular, on purpose: the PTY addon's install falls back to
 * `node-gyp rebuild` on a platform it has no prebuild for, and as a regular
 * dependency that failure would abort `npm install -g ever-works-node` on
 * that machine instead of degrading it. The price is that npm skips an
 * optional dependency without a word (0.2.10 pinned `^0.13.1`, whose
 * engines stop below Node 25, so every Node 26 machine lost its terminal
 * silently). The node names the skipped package, its range and the install
 * command itself instead: the session daemon's reason, the heartbeat the
 * app shows, and `ever-works-node doctor` (see `pty-host.ts`).
 *
 * Run `pnpm --filter ever-works-node build` first (type-check + the
 * workspace dependencies must be built); `build:bundle` then calls this.
 */
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const {
	collectHelperRelease,
	defaultUrlBase,
	parseTargetList,
	readHelperCrateVersion,
	unreleasedManifest,
	writeHelperReleaseAssets
} = require('./screen-helper-release');

const here = __dirname;
const repoRoot = path.resolve(here, '..', '..');
const outDir = path.join(here, 'dist-bundle');
/** The screen helper binaries a release hosts, under their release names (see `screen-helper-release.js`). */
const helperOutDir = path.join(here, 'dist-screen-helper');
const helperCrateDir = path.join(here, 'native', 'ever-works-screen');
/** The repository whose GitHub release hosts the helper by default (the published manifest's `repository`). */
const RELEASE_REPOSITORY = 'ever-co/ever-works';
/** The global `src/core/screen/helper/helper-manifest.ts` reads the baked manifest from. */
const HELPER_MANIFEST_GLOBAL = '__EVER_WORKS_SCREEN_HELPER_MANIFEST__';

const KEYRING_RANGE = '^1.1.0';
/** The PTY prebuild the bundled `pty-local` plugin requires lazily. */
const PTY_ADDON = '@homebridge/node-pty-prebuilt-multiarch';

/**
 * Every runtime dependency the bundle leaves EXTERNAL, with the range the
 * published manifest installs it at. The esbuild `external` list and the
 * manifest's `optionalDependencies` are both built from this one map, so a
 * native addon can never be kept out of the bundle without also being
 * shipped beside it.
 *
 * The PTY range is read from the `pty-local` plugin's own manifest (the
 * package that requires it) rather than restated: that plugin is inlined
 * into `cli.js`, so its manifest is never published, and a range copied
 * here would drift from the one it is built and tested against.
 */
function bundleExternals() {
	const ptyManifest = JSON.parse(
		fs.readFileSync(path.join(repoRoot, 'packages', 'plugins', 'pty-local', 'package.json'), 'utf8')
	);
	const ptyRange = ptyManifest.optionalDependencies?.[PTY_ADDON] ?? ptyManifest.dependencies?.[PTY_ADDON];
	if (typeof ptyRange !== 'string' || !ptyRange) {
		throw new Error(`packages/plugins/pty-local/package.json no longer declares ${PTY_ADDON}`);
	}
	return { '@napi-rs/keyring': KEYRING_RANGE, [PTY_ADDON]: ptyRange };
}

async function main() {
	const externals = bundleExternals();
	const manifest = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
	const version = readVersionSource();
	if (version !== manifest.version) {
		throw new Error(
			`apps/node/src/version.ts (${version}) and apps/node/package.json (${manifest.version}) disagree — bump both`
		);
	}

	const helperRelease = screenHelperRelease(version, process.env);

	fs.rmSync(outDir, { recursive: true, force: true });
	fs.mkdirSync(outDir, { recursive: true });
	fs.rmSync(helperOutDir, { recursive: true, force: true });

	await esbuild.build({
		entryPoints: [path.join(here, 'src', 'cli.ts')],
		bundle: true,
		platform: 'node',
		target: 'node22',
		format: 'cjs',
		outfile: path.join(outDir, 'cli.js'),
		// No banner: esbuild keeps the entry point's own `#!/usr/bin/env node`
		// (src/cli.ts) as the first line — a second copy is a syntax error.
		// Native addon, loaded lazily by the secret store; ships as an
		// optional dependency rather than being inlined.
		// The PTY prebuild the `pty-local` terminal host requires at runtime
		// is the same kind of addon: kept external, and without it a live
		// view's terminal channel runs on that plugin's pipe floor.
		external: Object.keys(externals),
		// The screen helper builds this version publishes (FL-07): read by
		// src/core/screen/helper/helper-manifest.ts, empty targets without a release.
		define: { [HELPER_MANIFEST_GLOBAL]: JSON.stringify(helperRelease.manifest) },
		keepNames: true,
		minify: false,
		sourcemap: false,
		legalComments: 'none',
		logLevel: 'info'
	});

	const publishable = buildPublishableManifest(manifest, version, externals);
	fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(publishable, null, 2)}\n`);
	// The manifest baked into cli.js, also shipped as a file for anyone checking a release.
	fs.writeFileSync(path.join(outDir, 'helper-manifest.json'), `${JSON.stringify(helperRelease.manifest, null, 2)}\n`);
	if (helperRelease.assets.length) writeHelperReleaseAssets(helperOutDir, helperRelease);

	fs.cpSync(path.join(here, 'packaging'), path.join(outDir, 'packaging'), { recursive: true });
	fs.copyFileSync(path.join(here, 'README.md'), path.join(outDir, 'README.md'));
	const licence = ['LICENSE', 'LICENSE.md', 'LICENSES.md']
		.map((name) => path.join(repoRoot, name))
		.find(fs.existsSync);
	if (licence) fs.copyFileSync(licence, path.join(outDir, 'LICENSE'));

	assertBundleShape(path.join(outDir, 'cli.js'), helperRelease.manifest);
	const size = fs.statSync(path.join(outDir, 'cli.js')).size;
	console.log(
		`ever-works-node ${version} staged in ${path.relative(repoRoot, outDir)} (cli.js ${Math.round(size / 1024)} KB)`
	);
	const published = Object.entries(helperRelease.manifest.targets);
	console.log(
		published.length
			? `screen helper ${helperRelease.manifest.version} published for ${published
					.map(([target, entry]) => `${target} (${entry.sha256.slice(0, 12)}…)`)
					.join(', ')}; assets in ${path.relative(repoRoot, helperOutDir)}`
			: 'screen helper: none published (set SCREEN_HELPER_RELEASE_DIR to bake release builds)'
	);
}

/**
 * The screen helper builds this node version publishes (FL-07, FR-21): from
 * SCREEN_HELPER_RELEASE_DIR when set, else none. SCREEN_HELPER_REQUIRED_TARGETS
 * makes a missing build an error instead of a node that publishes no helper.
 */
function screenHelperRelease(nodeVersion, env) {
	const dir = env.SCREEN_HELPER_RELEASE_DIR?.trim();
	const required = parseTargetList(env.SCREEN_HELPER_REQUIRED_TARGETS);
	if (!dir) {
		if (required.length) {
			throw new Error(
				`SCREEN_HELPER_REQUIRED_TARGETS asks for ${required.join(', ')} but SCREEN_HELPER_RELEASE_DIR is not set`
			);
		}
		return { manifest: unreleasedManifest(readHelperCrateVersion(helperCrateDir)), assets: [] };
	}
	const urlBase = env.SCREEN_HELPER_URL_BASE?.trim() || defaultUrlBase(RELEASE_REPOSITORY, nodeVersion);
	return collectHelperRelease({ dir: path.resolve(dir), urlBase, requiredTargets: required });
}

/**
 * The public manifest staged beside `cli.js`. Every external the bundle
 * leaves out is an OPTIONAL dependency here: each is a native addon its
 * caller degrades without, so an install whose prebuild is unavailable
 * still works.
 */
function buildPublishableManifest(manifest, version, externals) {
	return {
		name: 'ever-works-node',
		version,
		description: manifest.description,
		author: manifest.author,
		license: manifest.license,
		homepage: 'https://ever.works',
		repository: {
			type: 'git',
			url: 'git+https://github.com/ever-co/ever-works.git',
			directory: 'apps/node'
		},
		bugs: { url: 'https://github.com/ever-co/ever-works/issues' },
		keywords: ['ever-works', 'fleet', 'agent', 'node', 'runner', 'claude-code', 'codex'],
		// No leading './': npm normalises bin targets and warns (misleadingly, "script name … was invalid and
		// removed") when the written value differs from the normalised one. It is kept, not removed.
		bin: { 'ever-works-node': 'cli.js' },
		main: './cli.js',
		files: ['cli.js', 'helper-manifest.json', 'packaging', 'README.md', 'LICENSE'],
		engines: { node: '>=22.0.0' },
		optionalDependencies: { ...externals },
		publishConfig: { access: 'public' }
	};
}

/**
 * Cheap invariants on the staged file, so a broken bundle fails HERE and
 * not on the first machine that runs `npm install -g`: exactly one shebang
 * on line 1 (esbuild keeps the source one; a banner would double it),
 * no `workspace:` specifier left behind (every workspace package must be
 * inlined), the keyring still required by name (it stays external,
 * shipped as an optional dependency), and every screen helper fingerprint
 * this version publishes baked in (the `define` reached the manifest).
 */
function assertBundleShape(file, helperManifest) {
	const bundle = fs.readFileSync(file, 'utf8');
	const lines = bundle.split('\n', 2);
	if (lines[0] !== '#!/usr/bin/env node' || (lines[1] ?? '').startsWith('#!')) {
		throw new Error(`${file}: expected exactly one shebang on line 1`);
	}
	if (/workspace:[*^~]/.test(bundle)) {
		throw new Error(`${file}: a workspace:* specifier survived bundling`);
	}
	if (!/require\(["']@napi-rs\/keyring["']\)/.test(bundle)) {
		throw new Error(`${file}: @napi-rs/keyring is no longer required by name (it must stay external)`);
	}
	// esbuild names the define in a comment; an unreplaced READ is what must not survive.
	if (bundle.includes(`typeof ${HELPER_MANIFEST_GLOBAL}`)) {
		throw new Error(
			`${file}: ${HELPER_MANIFEST_GLOBAL} was not replaced (the screen helper manifest is not baked in)`
		);
	}
	for (const [target, entry] of Object.entries(helperManifest.targets)) {
		if (!bundle.includes(entry.sha256) || !bundle.includes(entry.url)) {
			throw new Error(`${file}: the ${target} screen helper fingerprint is not baked in`);
		}
	}
}

/** The version the binary reports, read from the one source the code uses. */
function readVersionSource() {
	const source = fs.readFileSync(path.join(here, 'src', 'version.ts'), 'utf8');
	const match = /NODE_APP_VERSION\s*=\s*'([^']+)'/.exec(source);
	if (!match) throw new Error('apps/node/src/version.ts: NODE_APP_VERSION not found');
	return match[1];
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}

// For the packaging spec (`src/core/packaging/publishable-manifest.internal.spec.ts`);
// `node build.js` runs `main()` above and ignores these.
module.exports = { assertBundleShape, bundleExternals, buildPublishableManifest, screenHelperRelease };
