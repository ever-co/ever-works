import { parseFleetHelperManifest, type FleetHelperManifest } from '@ever-works/contracts';

/**
 * Desktop view & control (FL-07, FR-21) — the fingerprints of the screen
 * helper builds THIS node package accepts, baked in at publish.
 *
 * `apps/node/build.js` replaces the global below with the manifest of the
 * helper builds the release hosts (`screen-helper-release.js`: per target the
 * SHA-256 of the reproducible build and the https URL `helper install`
 * downloads it from). The released bundle also carries it as
 * `helper-manifest.json`. A build without helper builds (`tsc`, the tests, a
 * bundle staged without SCREEN_HELPER_RELEASE_DIR) publishes no target:
 * `helper install` then says so and points at building the helper, and
 * `helper admit` needs `--allow-unpublished` and records the admission as
 * unpublished.
 *
 * Shape: `apps/node/native/ever-works-screen/helper-manifest.schema.json`.
 */
declare const __EVER_WORKS_SCREEN_HELPER_MANIFEST__: unknown;

/** What a node built without helper builds publishes: nothing. */
const UNRELEASED_MANIFEST: FleetHelperManifest = {
	schemaVersion: 1,
	version: '0.1.0',
	targets: {}
};

const RAW_MANIFEST: unknown =
	typeof __EVER_WORKS_SCREEN_HELPER_MANIFEST__ === 'undefined'
		? UNRELEASED_MANIFEST
		: __EVER_WORKS_SCREEN_HELPER_MANIFEST__;

export const BAKED_HELPER_MANIFEST: FleetHelperManifest = parseFleetHelperManifest(RAW_MANIFEST) ?? UNRELEASED_MANIFEST;
