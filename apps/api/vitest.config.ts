import { defineConfig } from 'vitest/config';

/**
 * Two suites:
 *
 *   "unit"        — pure-TS specs colocated with sources (`src/**\/*.spec.ts`).
 *                  All collaborators are mocked; no DB / Redis / network.
 *                  Fast — should complete in < 1 s.
 *
 *   "integration" — under `test/integration/` and explicitly opted into via
 *                  `vitest run --project integration`. Requires the dev
 *                  postgres + redis containers to be running. Sequential
 *                  (no `threads`) to keep the cross-tenant invariants
 *                  reasonable about shared DB state.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          environment: 'node',
          // Decorators are part of the production code we're testing,
          // so vitest's esbuild needs to accept them. The package's
          // tsconfig already turns this on but we pin it here too for
          // belt-and-braces.
          typecheck: { tsconfig: './tsconfig.json' },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.spec.ts'],
          setupFiles: ['./test/integration/setup.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // Real DB → no parallelism inside the project. Tests use
          // unique slugs but a shared schema, so race conditions show
          // up at scale.
          fileParallelism: false,
          sequence: { concurrent: false },
        },
      },
    ],
  },
});
