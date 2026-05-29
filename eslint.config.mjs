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
 * NOTE: `@next/eslint-plugin-next@14` targets ESLint 8's rule API
 * (`context.getAncestors`) and crashes under ESLint 9, so it is not loaded
 * here. Its rules are Next-specific optimizations rather than correctness
 * checks; revisit when the app moves to Next 15 (whose plugin is ESLint-9
 * compatible).
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/.turbo/**',
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
    // CLI scripts + tests legitimately log freely and use looser types.
    // They predate this config, so silence now-redundant disable directives
    // there rather than churn every file.
    files: [
      '**/*.spec.ts',
      '**/test/**/*.ts',
      'scripts/**/*.ts',
      'packages/*/scripts/**/*.ts',
      'packages/*/prisma/**/*.ts',
    ],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
