import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	// Like every first-party AI provider: the SDK (and the zero-dependency
	// contracts it reads the wire vocabulary from) ship inside the bundle.
	noExternal: ['@ever-works/plugin', '@ever-works/contracts'],
	format: ['esm', 'cjs'],
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true,
	target: 'es2021',
	outDir: 'dist'
});
