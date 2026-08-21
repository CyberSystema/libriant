// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * Flat ESLint config for the whole monorepo (NestJS API + worker, Next.js
 * web, shared TS libraries, and the provisioning scripts).
 *
 * Philosophy: typescript-eslint's (non-type-checked) recommended ruleset
 * for real correctness signal, plus `no-console` — exactly the rules the
 * codebase's existing `eslint-disable` comments anticipate. Stylistic /
 * opinion rules that the tsc build already covers are kept as warnings so
 * `pnpm lint` fails only on genuine errors.
 *
 * NOTE: the `@next/eslint-plugin-next` rules are Next-specific
 * optimizations rather than correctness checks and have had ESLint-version
 * API churn, so the plugin is not loaded here. Revisit if we want the
 * framework's own lint rules.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/.turbo/**',
      // Wrangler's generated dev/deploy bundles — not source.
      '**/.wrangler/**',
      '**/coverage/**',
      '**/.prisma/**',
      '.dev-storage/**',
      '**/*.config.{js,cjs,mjs,ts}',
      'apps/web/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // tsc owns undefined-symbol detection for TS; the core rule produces
      // false positives on type-only and ambient references.
      'no-undef': 'off',
      // Prefer let/const; the one legitimate `var` (a `declare global`
      // singleton) carries its own disable directive.
      'no-var': 'error',
      // New in ESLint 10 recommended — flags `let x = default; try { x = … }`
      // initializer patterns the codebase uses deliberately for safe
      // fallbacks. Restructuring would trip TS definite-assignment checks,
      // so leave it off.
      'no-useless-assignment': 'off',
      // App/lib code shouldn't `console.log`, but `warn`/`error` are
      // legitimate (dev diagnostics, fallbacks).
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The PWA service worker runs in a ServiceWorkerGlobalScope (self, caches,
    // clients, fetch, …) — not Node or the DOM window.
    files: ['apps/web/public/sw.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.browser },
    },
    rules: { 'no-undef': 'off' },
  },
  {
    // Node-side build hooks (e.g. the electron-builder afterPack hook) are
    // CommonJS scripts the packager runs on the build host — not bundled app
    // code. They legitimately use require/exports/process and log progress.
    files: ['apps/desktop/build/**/*.{js,cjs}'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // CLI scripts + tests legitimately log freely and use looser types.
    // They predate this config, so silence now-redundant disable directives
    // there rather than churn every file.
    files: [
      '**/*.spec.ts',
      '**/test/**/*.ts',
      'scripts/**/*.ts',
      'apps/site/build.ts',
      'packages/*/scripts/**/*.ts',
      'packages/*/prisma/**/*.ts',
    ],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // ESLint 10 wants `{ cause }` on rethrows; CLI scripts throw simple
      // top-level errors where a cause adds no value.
      'preserve-caught-error': 'off',
    },
  },
);
