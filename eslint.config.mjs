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
/**
 * The two halves of phase 13's circulation `Date` ban, named so the exemption
 * below is scoped to ONE of them rather than to a whole file. The argument for
 * both — and for the split — is on the `apps/api/src/policy/**` block that uses
 * them.
 */

/** Asking the machine what time it is. */
const CIRCULATION_CLOCK_READS = [
  {
    selector: "MemberExpression[object.name='Date'][property.name='now']",
    message:
      'Circulation must not read the process clock. Inject TenantClockService and call clock.now() ONCE per operation, then pass that instant down — every function in @libriant/circ-policy takes an explicit instant so that a single checkout cannot straddle midnight between two reads (2.0 phase 13).',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message:
      'new Date() is Date.now() wearing a constructor. Use clock.now(), or clock.at(value) for an instant a caller supplied. new Date(value) WITH an argument is legitimate and is not restricted (2.0 phase 13).',
  },
];

/** Computing a civil date in milliseconds. */
const CIRCULATION_DATE_ARITHMETIC = [
  {
    selector:
      "BinaryExpression[operator='+'] > CallExpression[callee.property.name=/^(getTime|valueOf)$/]",
    message:
      'Adding milliseconds to an instant does not produce a due date. Use computeDueDate() from @libriant/circ-policy, which has the branch calendar and its zone: measured, a loan taken 25 March 2026 at 18:00 in Athens plus 14 × 86_400_000 falls due at 19:00 on 8 April — an hour after the desk shuts — because Greece springs forward on 29 March (2.0 phase 13).',
  },
  {
    selector:
      "BinaryExpression[operator='-'][left.callee.property.name=/^(getTime|valueOf)$/][right.callee.property.name!=/^(getTime|valueOf)$/]",
    message:
      'Subtracting milliseconds from an instant does not produce an earlier civil date. Use computeDueDate() / accrueOverdue() from @libriant/circ-policy. Subtracting one instant from another — a.getTime() - b.getTime() — is an ELAPSED duration and is deliberately not restricted (2.0 phase 13).',
  },
  {
    selector: "Identifier[name=/^MS_PER_(MINUTE|HOUR|DAY|WEEK|MONTH)$/]",
    message:
      'A day is not 86_400_000 ms. Six 1.0 services and jobs re-declare MS_PER_DAY, and loans.service.ts:386 floors (returnedAt − dueAt) / MS_PER_DAY into "days overdue" — measured, a book due Saturday 28 March 2026 at 18:00 in Athens and returned Sunday the 29th at 17:30 is 22.5 elapsed hours, so that floor charges ZERO overdue days for a book a day late. Use accrueOverdue() / computeDueDate() from @libriant/circ-policy (2.0 phase 13).',
  },
  {
    selector: 'Literal[value=86400000]',
    message:
      'The same day-length assumption without the name. Use computeDueDate() / accrueOverdue() from @libriant/circ-policy, and DurationUnit to say whether the policy meant elapsed hours or civil days (2.0 phase 13).',
  },
  {
    selector:
      "CallExpression[callee.property.name=/^set(Date|FullYear|Hours|Milliseconds|Minutes|Month|Seconds|Time)$/]",
    message:
      "Mutating a Date in place computes a civil date in the SERVER's zone, which is UTC in every container we ship and is nobody's opening hours. Use computeDueDate() from @libriant/circ-policy, or clock.civil(instant, branch.timezone) to read a wall clock (2.0 phase 13).",
  },
  {
    selector: "CallExpression[callee.property.name=/^setUTC[A-Z]/]",
    message:
      'Naming UTC explicitly does not make it the library’s calendar — a branch in Europe/Athens is +2 or +3, so a UTC midnight is 02:00 or 03:00 local and lands on the wrong civil day for two hours of every day. Use clock.civil(instant, branch.timezone) and the calendar helpers in @libriant/circ-policy (2.0 phase 13).',
  },
];

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
    /**
     * Circulation may not ask the machine what time it is, and may not do date
     * arithmetic in milliseconds. Phase 13 of the 2.0 program
     * (`docs/architecture/libriant-2.0/MASTER-ARCHITECTURE.md`).
     *
     * WHY. `packages/circ-policy` is pure and every function in it takes an
     * explicit instant — `purity.test.ts` greps the source to be sure. That
     * design buys nothing if the layer above supplies forty separately-read
     * instants and then does the calendar arithmetic itself anyway, which is
     * what 1.0 does: six services and jobs each re-declare
     * `MS_PER_DAY = 86_400_000`.
     *
     * The failures are seasonal rather than theoretical. Athens springs forward
     * at 03:00 on 29 March 2026. A loan taken on the 25th at 18:00 local and
     * given "+14 days" by millisecond addition falls due at 19:00 on 8 April,
     * an hour after the desk shuts. A book due Saturday the 28th at 18:00 and
     * returned Sunday the 29th at 17:30 is 22.5 elapsed hours, so
     * `loans.service.ts:386` floors it to ZERO overdue days and the patron is
     * charged nothing for a book that is a day late. Elapsed and civil are
     * different quantities — that distinction is the entire reason
     * `DurationUnit` exists (`01-enums.prisma:261-268`) — and millisecond
     * arithmetic can only express the elapsed half while looking like both.
     *
     * The `circ-5` comment at `loans.service.ts:377-387` already documents the
     * second failure and says the honest fix needs "a per-tenant timezone (no
     * such column exists today)". `branches.timezone` is that column
     * (`20-org.prisma:73`) and the snapshot this directory builds is what puts
     * it in `computeDueDate`'s hands, so the excuse expires here and the rule
     * is what stops it being written again.
     *
     * WHAT IT COSTS. `apps/api/src/circulation/` does not exist yet — phase 16
     * creates it. Landing the rule now is the argument
     * `apps/api/src/platform/locks.ts:35-48` makes for the phase-16
     * advisory-lock gate, in the other direction: a gate that arrives after the
     * code has reached 25 call sites ships with 25 allowlist entries and checks
     * nothing while looking like coverage. This one lands against a directory
     * that does not exist yet and one whose every file was written this phase,
     * so it lands clean and phase 16 never writes the idiom in the first place
     * — which is the only moment a rule like this is ever free. Test files
     * are covered too, deliberately: a circulation test that reads the wall
     * clock is precisely the suite that fails once, at 23:59, in March.
     *
     * WHAT IT DOES NOT BAN. `new Date(value)` builds an instant from a value
     * the caller supplied; it is pervasive, correct, and untouched — only the
     * argless `new Date()` is a clock read, which is the same line
     * `packages/circ-policy/src/purity.test.ts` draws. `a.getTime() -
     * b.getTime()` is an elapsed duration rather than a fabricated date: it is
     * how you sort and how you compare, and `policy-snapshot.loader.ts:444`
     * orders fixed-due-date ranges with it. Only arithmetic mixing an instant
     * with a NUMBER is restricted. And these selectors are syntactic, so
     * `+someDate` and `Number(someDate)` slip past — there is no type
     * information here to recognise a Date, and saying so is better than
     * implying a completeness the rule does not have.
     *
     * THE ONE EXEMPTION, scoped in two directions rather than one. Two files
     * may name the clock. `tenant-clock.service.ts` IS the clock — the phase-6
     * block's `apps/web/lib/**` in miniature, since the implementation of a
     * seam has to name the thing it wraps. `policy-snapshot.service.ts` reads
     * `Date.now()` four times to measure CACHE AGE, which is wall-clock by
     * nature, local to the process, never reaches a receipt, and has no branch
     * timezone to be wrong about.
     *
     * That is expressed as a second block below carrying the ARITHMETIC half
     * rather than as an `ignores` entry, which would have been one line shorter
     * and would have exempted both files from everything. Neither needs that
     * much: the cache does no date arithmetic, and for the clock service the
     * residual ban enforces its own stated refusal to grow a `clock.addDays()`
     * beside `now()`.
     */
    files: ['apps/api/src/policy/**/*.ts', 'apps/api/src/circulation/**/*.ts'],
    ignores: [
      'apps/api/src/policy/tenant-clock.service.ts',
      'apps/api/src/policy/policy-snapshot.service.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...CIRCULATION_CLOCK_READS,
        ...CIRCULATION_DATE_ARITHMETIC,
      ],
    },
  },
  {
    // The two files above that may name the clock — the clock itself, and the
    // snapshot cache measuring its own entries' age. They keep the arithmetic
    // half of the rule; see the block above for why that is the whole point.
    files: [
      'apps/api/src/policy/tenant-clock.service.ts',
      'apps/api/src/policy/policy-snapshot.service.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...CIRCULATION_DATE_ARITHMETIC],
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
