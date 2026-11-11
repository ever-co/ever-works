import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// CI-load resilience: unit specs doing cold `await import()` /
		// vi.resetModules() or real file parsing can drift past vitest's 5s
		// default under the concurrent turbo test load. Matches the 30000ms
		// the packages/tasks + api jest configs already use.
		testTimeout: 30000,
		hookTimeout: 30000,
		environment: 'node',
		// `gc()` for the time guards (`src/__tests__/linear-time.ts`): a step
		// over its bound is timed again from a full collection, so a collection
		// cycle that earlier work left running is not read as growth. On two
		// busy CPUs that alone read 5–17× growth on a linear function.
		execArgv: ['--expose-gc'],
		globals: true,
		include: ['src/**/*.{test,spec}.ts'],
		typecheck: {
			enabled: true,
			include: ['src/**/*.spec-d.ts']
		},
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html']
		}
	}
});
