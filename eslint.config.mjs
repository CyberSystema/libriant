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
    files: ['apps/web/public/sw.js', 'apps/site/public/sw.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, ...globals.browser },
    },
    rules: { 'no-undef': 'off' },
  },
  {
    // Plain-ESM operational scripts run by node directly rather than through
    // tsx, so they stay dependency-free and can run before the workspace is
    // installed. They are Node programs: process and console are the point.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
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
    /**
     * A staff SCREEN may not talk to a host directly. Phase 6 of the 2.0
     * program (`docs/architecture/libriant-2.0/MASTER-ARCHITECTURE.md`).
     *
     * WHY. M8 replaces the Electron shell — which is a browser in a box, so
     * every one of these calls happens to work in it — with a Tauri client over
     * a Rust core and an encrypted local replica. There is no `/lbr-api` origin
     * there, no session cookie, no `window.open`, and frequently no network. A
     * screen that reaches for the browser directly cannot run on that client,
     * and sixty such screens is a rewrite rather than three new classes.
     *
     * So the rule: screens depend on `DataPort` / `PlatformPort` / `PrintPort`
     * (`@libriant/shared/ports`) and the root chooses an implementation once
     * (`apps/web/lib/ports`). The implementations themselves live in
     * `apps/web/lib/**`, which is deliberately NOT covered here — that is where
     * the browser is allowed to be named.
     *
     * This ships with ZERO exemptions. The four multipart uploads, the nine
     * `/lbr-api` asset URLs, the three clipboard writes and the two
     * connectivity listeners were converted in the same commit, because a rule
     * that needs `eslint-disable` on day one is a rule nobody believes.
     */
    files: ['apps/web/app/**/*.{ts,tsx}', 'apps/web/components/**/*.{ts,tsx}'],
    ignores: [
      // Next route handlers are SERVERS that happen to live under `app/`. They
      // have no port and no native equivalent — `app/api/readyz` proxies the
      // API's own readiness probe for the orchestrator, not for a screen.
      'apps/web/app/api/**',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='fetch']",
          message:
            "A screen must not call fetch(). Use dataPort() from '@/lib/ports' — get/post/patch/put/delete/upload — so the same screen runs on the native client (2.0 phase 6).",
        },
        {
          selector:
            "MemberExpression[object.name=/^(window|globalThis|self)$/][property.name='fetch']",
          message:
            "A screen must not call fetch(). Use dataPort() from '@/lib/ports' (2.0 phase 6).",
        },
        {
          selector: 'Literal[value=/\\/lbr-api(\\/|$)/]',
          message:
            "'/lbr-api' is one host's rewrite, not part of the API contract. Use dataPort().resourceUrl('/t/…') for a URL the browser loads, or a dataPort() method to fetch it (2.0 phase 6).",
        },
        {
          selector: 'TemplateElement[value.cooked=/\\/lbr-api(\\/|$)/]',
          message:
            "'/lbr-api' is one host's rewrite, not part of the API contract. Use dataPort().resourceUrl(`/t/${…}`) (2.0 phase 6).",
        },
        {
          selector: "MemberExpression[object.name='window'][property.name='open']",
          message:
            "A screen must not call window.open(). Use platformPort().openExternal(url) for a link, or printPort().print(target) for a document (2.0 phase 6).",
        },
        {
          selector: "MemberExpression[object.name='navigator'][property.name='clipboard']",
          message:
            'A screen must not touch navigator.clipboard. Use platformPort().copyText(text), which returns an ack instead of throwing on a denied permission (2.0 phase 6).',
        },
        {
          selector: "MemberExpression[object.name='navigator'][property.name='onLine']",
          message:
            'A screen must not read navigator.onLine. Use platformPort().isOnline() (2.0 phase 6).',
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(add|remove)EventListener$/][arguments.0.value=/^(online|offline)$/]",
          message:
            'A screen must not subscribe to the browser online/offline events. Use platformPort().onOnlineChange(listener), which returns an unsubscribe function (2.0 phase 6).',
        },
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
