/**
 * Libriant — interactive secrets & credentials manager.
 *
 * One place to CREATE, ASSIGN, CHANGE (rotate), and PRINT every credential,
 * secret, API key and security variable the platform uses. Operates ENTIRELY
 * LOCALLY on an env file on the host (default `/srv/libriant/.env.prod`) — it
 * never phones home and never writes secrets anywhere except that file and (on
 * explicit request) your terminal.
 *
 * It complements `scripts/ensure-env.sh` (the non-interactive deploy-time
 * generator): same env-file format, same "never overwrite an existing value"
 * safety. This tool adds a human-friendly, classified, interactive surface and
 * a password-manager export.
 *
 * Every variable is CLASSIFIED so you know, at a glance:
 *   • origin     — who creates it:
 *                    generated → this tool can auto-generate it
 *                    human     → you type it (a chosen password / email)
 *                    external  → you paste it from another service (Stripe/SMTP)
 *                    config    → non-secret machine/operator setting
 *   • secret     — whether the value is sensitive (masked unless you reveal)
 *   • save       — whether to store it in your PASSWORD MANAGER:
 *                    yes / recommended / no  (+ the reason)
 *   • rotation   — safe / caution / never  (+ what breaks if you rotate it)
 *   • store      — env (this file) or github-actions (CI secret, shown for
 *                  completeness so your password-manager list is exhaustive)
 *
 * USAGE
 *   pnpm secrets                      # interactive menu (default)
 *   pnpm secrets print                # masked inventory (non-interactive)
 *   pnpm secrets print --reveal --yes # full values (DANGER: plaintext)
 *   pnpm secrets print --format pwmanager --reveal --yes
 *   pnpm secrets init [--yes]         # generate every missing generated secret
 *   pnpm secrets set KEY [VALUE]      # set one (omit VALUE → prompt/generate)
 *   pnpm secrets rotate KEY [--yes]   # regenerate one (with safety warnings)
 *   pnpm secrets audit                # report missing / insecure / weak values
 *   pnpm secrets gen [--length 24]    # standalone password/secret generator
 *   pnpm secrets --file ./.env.local  # operate on a different env file
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const SCRIPT = 'secrets';

// ───────────────────────────── classification model ─────────────────────────

type Origin = 'generated' | 'human' | 'external' | 'config';
type Store = 'env' | 'github-actions';
type Rotation = 'safe' | 'caution' | 'never';
type SaveRec = 'yes' | 'recommended' | 'no';
type GenSpec =
  | { kind: 'hex'; bytes: number }
  | { kind: 'password'; length: number; urlSafe?: boolean }
  | { kind: 'ssh-ed25519' }
  | { kind: 'none' };

interface VarDef {
  key: string;
  group: string;
  category: string;
  origin: Origin;
  secret: boolean;
  store: Store;
  save: SaveRec;
  saveReason: string;
  rotation: Rotation;
  rotationNote?: string;
  gen: GenSpec;
  /** When is a value required for a healthy PRODUCTION boot? */
  requirement: 'prod' | 'optional' | 'conditional';
  /** For conditional requirement, returns true when the value is required. */
  requiredWhen?: (get: (k: string) => string | undefined) => boolean;
  /** Returns an error string if the value is invalid, else null. */
  validate?: (v: string) => string | null;
  /** A development default the app uses — INSECURE if it leaks into prod. */
  insecureDefault?: string;
  description: string;
}

const HEX32: GenSpec = { kind: 'hex', bytes: 32 };

const REGISTRY: VarDef[] = [
  // ── App secrets (JWT/HMAC) — generated, store in PW manager for recovery ──
  {
    key: 'SESSION_SECRET',
    group: 'App secrets',
    category: 'JWT signing secret (tenant sessions)',
    origin: 'generated',
    secret: true,
    store: 'env',
    save: 'yes',
    saveReason: 'Recover it if the env file is lost; rotating it logs out every library user.',
    rotation: 'caution',
    rotationNote: 'Invalidates ALL active tenant sessions — everyone must sign in again.',
    gen: HEX32,
    requirement: 'prod',
    insecureDefault: 'dev-only-session-secret-CHANGE-IN-PROD',
    description: 'HMAC secret signing tenant session JWTs.',
  },
  {
    key: 'ADMIN_SESSION_SECRET',
    group: 'App secrets',
    category: 'JWT signing secret (admin sessions)',
    origin: 'generated',
    secret: true,
    store: 'env',
    save: 'yes',
    saveReason: 'Recovery; rotating it logs out all platform admins.',
    rotation: 'caution',
    rotationNote: 'Invalidates active admin sessions — admins must sign in again.',
    gen: HEX32,
    requirement: 'prod',
    insecureDefault: 'dev-only-admin-session-secret-CHANGE-IN-PROD',
    description: 'HMAC secret signing platform-admin session JWTs (separate from tenant).',
  },
  {
    key: 'IMPERSONATION_SECRET',
    group: 'App secrets',
    category: 'JWT signing secret (support impersonation)',
    origin: 'generated',
    secret: true,
    store: 'env',
    save: 'yes',
    saveReason: 'Recovery; rotating it ends active support sessions.',
    // SEC-10: 'caution', not 'safe' — consistent with the other session-signing
    // secrets (SESSION_SECRET / ADMIN_SESSION_SECRET). Rotating it DROPS any
    // in-progress support/impersonation session, so an operator should not do it
    // unprompted mid-session.
    rotation: 'caution',
    rotationNote:
      'Ends any in-progress support/impersonation session immediately; end-users unaffected.',
    gen: HEX32,
    requirement: 'prod',
    insecureDefault: 'dev-only-impersonation-secret-CHANGE-IN-PROD',
    description: 'HMAC secret signing support-impersonation JWTs (distinct from admin).',
  },
  {
    key: 'STORAGE_SIGNING_SECRET',
    group: 'App secrets',
    category: 'HMAC secret (signed download URLs)',
    origin: 'generated',
    secret: true,
    store: 'env',
    save: 'yes',
    saveReason: 'Recovery; rotating it invalidates outstanding signed file URLs.',
    rotation: 'caution',
    rotationNote: 'Outstanding signed download links 403 until reissued (low impact).',
    gen: HEX32,
    requirement: 'prod',
    description: 'HMAC secret for signed file-download URLs (kept separate so it rotates alone).',
  },
  {
    key: 'MFA_MASTER_KEY',
    group: 'App secrets',
    category: 'AES-256-GCM master key (admin TOTP at rest)',
    origin: 'generated',
    secret: true,
    store: 'env',
    save: 'yes',
    saveReason: 'CRITICAL recovery — the only thing that can decrypt stored admin TOTP secrets.',
    rotation: 'never',
    rotationNote:
      'Rotating ORPHANS every admin TOTP enrollment (they decrypt with the old key). Only rotate with a planned re-enrollment of all admins.',
    gen: HEX32, // 32 bytes → 64 hex chars
    requirement: 'prod',
    insecureDefault: '0011223344556677889900112233445566778899001122334455667788990011',
    validate: (v) =>
      /^[0-9a-fA-F]{64}$/.test(v) ? null : 'must be exactly 64 hex characters (32 bytes).',
    description: 'AES-256-GCM key encrypting admin TOTP secrets in the DB.',
  },

  // ── Database credential ──
  {
    key: 'POSTGRES_PASSWORD',
    group: 'Database',
    category: 'Postgres role password',
    origin: 'generated',
    secret: true,
    store: 'env',
    save: 'yes',
    saveReason:
      'CRITICAL — the running cluster is keyed to it; losing it can lock you out of the DB.',
    // `never`, not `caution`: this tool only edits the env file. Rotating the
    // value here WITHOUT the matching `ALTER ROLE libriant PASSWORD ...` desyncs
    // from the live cluster and locks the app out of its own DB. The rotate
    // command refuses; do it as a coordinated maintenance procedure.
    rotation: 'never',
    rotationNote:
      'The running cluster + data volume use this password. Change it ONLY as a coordinated maintenance step: `ALTER ROLE libriant PASSWORD ...` in Postgres AND update this value together — never rotate it here alone.',
    gen: { kind: 'hex', bytes: 24 }, // hex → URL-safe (interpolated into a DB URL)
    requirement: 'prod',
    // Must be URL-safe: it is interpolated into postgresql://libriant:<pw>@host.
    // `@ : / ? # [ ]` etc. would corrupt the connection URL or leak into the
    // host/path. Restrict to RFC3986 unreserved characters.
    validate: (v) =>
      /^[A-Za-z0-9\-._~]+$/.test(v)
        ? null
        : 'must be URL-safe (letters, digits, and - . _ ~ only) — it goes into the DB connection URL.',
    description:
      'Password for the `libriant` Postgres role; interpolated into the DB connection URLs.',
  },

  // ── First admin (bootstrap) ──
  {
    key: 'ADMIN_BOOTSTRAP_EMAIL',
    group: 'First admin',
    category: 'Platform admin login (email)',
    origin: 'human',
    secret: false,
    store: 'env',
    save: 'recommended',
    saveReason: 'Your platform-admin identity — keep it with the password.',
    rotation: 'safe',
    gen: { kind: 'none' },
    requirement: 'optional',
    validate: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'not a valid email address.'),
    description: 'Email of the first platform admin, auto-created on deploy (idempotent).',
  },
  {
    key: 'ADMIN_BOOTSTRAP_PASSWORD',
    group: 'First admin',
    category: 'Platform admin login (password)',
    origin: 'human',
    secret: true,
    store: 'env',
    save: 'yes',
    saveReason: 'The first-admin sign-in password — you need it to log in the first time.',
    rotation: 'safe',
    rotationNote: 'Only used to create the first admin; ignored once that admin exists.',
    gen: { kind: 'password', length: 20 },
    requirement: 'optional',
    validate: (v) => (v.length >= 12 ? null : 'use at least 12 characters.'),
    description:
      'Password for the auto-created first admin. Enroll MFA in the browser after login.',
  },

  // ── External APIs / credentials (you paste these from the provider) ──
  {
    key: 'STRIPE_API_KEY',
    group: 'External APIs',
    category: 'Stripe secret API key',
    origin: 'external',
    secret: true,
    store: 'env',
    save: 'yes',
    saveReason: 'Issued by Stripe; store a copy. Rotate/revoke from the Stripe dashboard.',
    rotation: 'caution',
    rotationNote: 'Roll the key in the Stripe dashboard, then paste the new value here.',
    gen: { kind: 'none' },
    requirement: 'conditional',
    requiredWhen: (g) => (g('STRIPE_DRIVER') ?? '').toLowerCase() === 'real',
    validate: (v) =>
      /^sk_(test|live)_/.test(v) ? null : 'expected a Stripe secret key (sk_test_… / sk_live_…).',
    description: 'Stripe secret API key. Required when STRIPE_DRIVER=real.',
  },
  {
    key: 'STRIPE_WEBHOOK_SECRET',
    group: 'External APIs',
    category: 'Stripe webhook signing secret',
    origin: 'external',
    secret: true,
    store: 'env',
    save: 'yes',
    saveReason: 'Issued by Stripe per webhook endpoint; store a copy.',
    rotation: 'caution',
    gen: { kind: 'none' },
    requirement: 'conditional',
    requiredWhen: (g) => (g('STRIPE_DRIVER') ?? '').toLowerCase() === 'real',
    validate: (v) => (/^whsec_/.test(v) ? null : 'expected a Stripe webhook secret (whsec_…).'),
    description: 'Stripe webhook signing secret. Required when STRIPE_DRIVER=real.',
  },
  {
    key: 'SMTP_URL',
    group: 'External APIs',
    category: 'SMTP connection URL (contains credentials)',
    origin: 'external',
    secret: true,
    store: 'env',
    save: 'yes',
    saveReason: 'Embeds your SMTP username + password.',
    rotation: 'caution',
    gen: { kind: 'none' },
    requirement: 'conditional',
    requiredWhen: (g) => (g('EMAIL_DRIVER') ?? '').toLowerCase() === 'smtp',
    validate: (v) =>
      /^smtps?:\/\//.test(v) ? null : 'expected smtp://user:pass@host:port (or smtps://).',
    description: 'SMTP connection URL used by the mailer. Required when EMAIL_DRIVER=smtp.',
  },
  {
    key: 'BACKUP_HEARTBEAT_URL',
    group: 'External APIs',
    category: 'Backup dead-man-switch ping URL',
    origin: 'external',
    secret: true,
    store: 'env',
    save: 'recommended',
    saveReason: 'Contains a per-check token (e.g. healthchecks.io URL).',
    rotation: 'safe',
    gen: { kind: 'none' },
    requirement: 'optional',
    description: 'Optional URL pinged after a successful backup so a dead cron is detected.',
  },

  // ── Deploy secrets (live in GitHub Actions, NOT in this env file) ──
  {
    key: 'DEPLOY_SSH_KEY',
    group: 'Deploy (GitHub Actions)',
    category: 'SSH private key (CI → host)',
    origin: 'generated',
    secret: true,
    store: 'github-actions',
    save: 'yes',
    saveReason: 'Root-equivalent deploy key; store the private key securely.',
    rotation: 'caution',
    rotationNote:
      "Add the new public key to each host's authorized_keys BEFORE replacing the secret.",
    gen: { kind: 'ssh-ed25519' },
    requirement: 'optional',
    description:
      'Private SSH key the deploy workflow uses to reach hosts. Set in GitHub → Secrets.',
  },
  {
    key: 'DEPLOY_KNOWN_HOSTS',
    group: 'Deploy (GitHub Actions)',
    category: 'Pinned SSH host keys',
    origin: 'human',
    secret: false,
    store: 'github-actions',
    save: 'recommended',
    saveReason: 'Pinned host keys prevent deploy MITM; keep a copy.',
    rotation: 'safe',
    gen: { kind: 'none' },
    requirement: 'optional',
    description:
      'Output of `ssh-keyscan <host>` captured once, set in GitHub → Secrets (see deploy.yml).',
  },

  // ── Hosts / config (operator-set, non-secret) ──
  cfg(
    'PUBLIC_HOST',
    'Hosts',
    'Public apex domain',
    'human',
    'recommended',
    'Public domain — handy reference.',
  ),
  cfg('ADMIN_HOST', 'Hosts', 'Admin host', 'human', 'no', 'Admin console host.'),
  cfg(
    'ACME_EMAIL',
    'Hosts',
    'ACME/TLS contact email',
    'human',
    'no',
    'Email for TLS cert issuance.',
  ),
  cfg(
    'IMAGE_OWNER',
    'Hosts',
    'GHCR owner/org (lowercase)',
    'human',
    'no',
    'GitHub owner the images are pushed under.',
  ),
  cfg('EMAIL_FROM', 'Email', 'Default From: envelope', 'config', 'no', 'Optional From: header.'),
  cfg(
    'EMAIL_REPLY_TO',
    'Email',
    'Default Reply-To: envelope',
    'config',
    'no',
    'Optional Reply-To: header.',
  ),
  cfg(
    'RCLONE_REMOTE',
    'Backups',
    'Off-site backup remote',
    'human',
    'recommended',
    'rclone remote, e.g. storagebox:libriant-backups.',
  ),

  // ── Pure machine/config toggles (non-secret, don't save) ──
  cfg(
    'IMAGE_TAG',
    'Config',
    'Deployed image tag',
    'config',
    'no',
    'Set by deploy to the commit SHA; override to roll back.',
  ),
  cfg(
    'BILLING_ENABLED',
    'Config',
    'Plan/quota enforcement switch',
    'config',
    'no',
    'true = enforce plans; false = everything free.',
  ),
  cfg(
    'STRIPE_DRIVER',
    'Config',
    'Stripe driver',
    'config',
    'no',
    'fake (no charges) | real (live Stripe).',
  ),
  cfg(
    'EMAIL_DRIVER',
    'Config',
    'Email driver',
    'config',
    'no',
    'console (log only) | smtp (deliver).',
  ),
  cfg(
    'MAINTENANCE_HARD',
    'Config',
    'Edge maintenance page',
    'config',
    'no',
    'true = Caddy serves the static maintenance page.',
  ),
  cfg(
    'BACKUP_KEEP_DAYS',
    'Config',
    'Local backup retention (days)',
    'config',
    'no',
    'How many daily backups to keep locally.',
  ),
  cfg(
    'BACKUP_ALLOW_LOCAL_ONLY',
    'Config',
    'Acknowledge local-only backups',
    'config',
    'no',
    '1 = silence the "no off-site backup" warning.',
  ),
  cfg(
    'COMPOSE_PROJECT_NAME',
    'Config',
    'Compose project name',
    'config',
    'no',
    'Docker compose project name (volume namespace).',
  ),
  cfg(
    'LIBRIANT_DATA_ROOT',
    'Config',
    'Host data root',
    'config',
    'no',
    'Where persistent volumes are bind-mounted.',
  ),
];

/** Shorthand for a non-secret config var. */
function cfg(
  key: string,
  group: string,
  category: string,
  origin: Origin,
  save: SaveRec,
  description: string,
): VarDef {
  return {
    key,
    group,
    category,
    origin,
    secret: false,
    store: 'env',
    save,
    saveReason:
      save === 'no' ? 'Non-secret config; reproducible from docs/deploy.' : 'Useful reference.',
    rotation: 'safe',
    gen: { kind: 'none' },
    requirement: 'optional',
    description,
  };
}

const BY_KEY = new Map(REGISTRY.map((d) => [d.key, d]));

// ───────────────────────────── env file model ───────────────────────────────

interface Line {
  raw: string;
  key?: string;
}
interface EnvModel {
  path: string;
  lines: Line[];
}

function parseValue(rhs: string): string {
  const t = rhs.trim();
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1);
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    return t.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  }
  // SEC-08: strip an unquoted trailing `# comment` to match how the shell
  // sources the file (`set -a; . file`): an inline comment after whitespace is
  // not part of the value. Only applies to BAREWORD (unquoted) values — a `#`
  // inside quotes is handled by the branches above. Without this the
  // fingerprint/length the tool showed for a commented value was wrong.
  const noComment = t.replace(/\s+#.*$/, '');
  return noComment.trim();
}

function loadModel(path: string): EnvModel {
  const lines: Line[] = [];
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    for (const raw of text.split('\n')) {
      // SEC-08: accept an optional `export ` prefix so `export KEY=…` lines are
      // recognised as definitions (they are valid in a sourced shell env file).
      // Without this they parsed as plain comments → false MISSING reports and
      // duplicate appends.
      const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      lines.push(m ? { raw, key: m[1] } : { raw });
    }
    // Drop a single trailing empty line artifact from split.
    if (lines.length && lines[lines.length - 1]!.raw === '') lines.pop();
  }
  return { path, lines };
}

function getValue(model: EnvModel, key: string): string | undefined {
  for (let i = model.lines.length - 1; i >= 0; i--) {
    const l = model.lines[i]!;
    if (l.key === key) {
      const eq = l.raw.indexOf('=');
      return parseValue(l.raw.slice(eq + 1));
    }
  }
  return undefined;
}

/** A value is a "safe bareword" if it needs no quoting in a sourced env file. */
function isBareword(v: string): boolean {
  return /^[A-Za-z0-9_.:/@%+=-]*$/.test(v);
}

function serializeKV(key: string, value: string): string {
  // secrets-tool-new: reject newlines / control chars. A value containing a
  // newline (e.g. a pasted PEM-ish string, or a credential copied with a
  // trailing newline) would be written as a corrupt multi-line entry —
  // truncated to its first line with a dangling `<rest>'` orphan line — while
  // still printing "✓ updated". The env-file model is one KEY=VALUE per line, so
  // a newline simply cannot be represented; refuse it (mirrors ensure-env.sh,
  // which only ever writes shell-safe single-line values).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(value)) {
    throw new Error(
      `value for ${key} contains a newline or control character, which can't be stored in a single-line env entry — choose a single-line value.`,
    );
  }
  if (isBareword(value)) return `${key}=${value}`;
  if (value.includes("'")) {
    // Single quotes can't be represented inside a single-quoted env value.
    throw new Error(
      `value for ${key} contains a single quote (') which can't be stored safely — choose a value without one.`,
    );
  }
  return `${key}='${value}'`;
}

function setValue(model: EnvModel, key: string, value: string): void {
  const serialized = serializeKV(key, value);
  // SEC-07: update the LAST occurrence, not the first. getValue() reads
  // last-wins (matching `set -a; . file` shell semantics, where a later
  // assignment shadows an earlier one). If we updated the FIRST occurrence on a
  // file with a duplicated key, `set`/`rotate` would report success while the
  // value the app actually loads (the last one) stayed stale — a silent no-op.
  let lastIdx = -1;
  for (let i = model.lines.length - 1; i >= 0; i--) {
    if (model.lines[i]!.key === key) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx >= 0) model.lines[lastIdx] = { raw: serialized, key };
  else model.lines.push({ raw: serialized, key });
}

function saveModel(model: EnvModel): void {
  const dir = dirname(model.path);
  // SEC-09: create parent dirs locked down (0o700) — the file holds secrets and
  // may live under ./.env.* in a shared/world-traversable dir, not only the
  // root-owned /srv/libriant.
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = model.lines.map((l) => l.raw).join('\n') + '\n';
  // SEC-09: use a RANDOMIZED temp name in the same dir, opened with the 'wx'
  // flag (O_CREAT|O_EXCL). O_EXCL refuses to follow a symlink or clobber an
  // existing file, closing the predictable-temp-name + symlink-following write
  // gap. The rename over the target is still atomic.
  const tmp = `${model.path}.tmp-${randomBytes(8).toString('hex')}`;
  writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
  chmodSync(tmp, 0o600);
  renameSync(tmp, model.path);
  chmodSync(model.path, 0o600);
}

// ───────────────────────────── generators ───────────────────────────────────

const PW_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' + '!@#%^&*-_=+.?';
const URLSAFE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

function genHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function genPassword(length: number, urlSafe = false): string {
  const alphabet = urlSafe ? URLSAFE_ALPHABET : PW_ALPHABET;
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

function generateFor(def: VarDef): string | null {
  switch (def.gen.kind) {
    case 'hex':
      return genHex(def.gen.bytes);
    case 'password':
      return genPassword(def.gen.length, def.gen.urlSafe);
    default:
      return null;
  }
}

function describeGen(gen: GenSpec): string {
  switch (gen.kind) {
    case 'hex':
      return `auto: ${gen.bytes * 2} hex chars (${gen.bytes} bytes)`;
    case 'password':
      return `auto: ${gen.length}-char ${gen.urlSafe ? 'URL-safe ' : ''}password`;
    case 'ssh-ed25519':
      return 'auto: ssh-keygen ed25519 (run `ssh-keygen -t ed25519`)';
    default:
      return 'manual: you provide it';
  }
}

// ───────────────────────────── display helpers ──────────────────────────────

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};
const useColor = stdout.isTTY;
function col(s: string, c: string): string {
  return useColor ? `${c}${s}${C.reset}` : s;
}

function fingerprint(v: string): string {
  return createHash('sha256').update(v).digest('hex').slice(0, 8);
}

function maskedDisplay(def: VarDef, v: string | undefined): string {
  if (v === undefined || v === '') return col('(unset)', C.dim);
  if (!def.secret) return v;
  return col(`•••••••• · ${v.length} ch · fp:${fingerprint(v)}`, C.dim);
}

function originLabel(o: Origin): string {
  switch (o) {
    case 'generated':
      return col('machine·gen', C.cyan);
    case 'human':
      return col('human', C.yellow);
    case 'external':
      return col('human·ext', C.yellow);
    case 'config':
      return col('machine·cfg', C.dim);
  }
}

function saveLabel(s: SaveRec): string {
  if (s === 'yes') return col('SAVE ✓', C.green);
  if (s === 'recommended') return col('save~', C.green);
  return col('—', C.dim);
}

function rotationLabel(r: Rotation): string {
  if (r === 'never') return col('never', C.red);
  if (r === 'caution') return col('caution', C.yellow);
  return col('safe', C.dim);
}

function statusOf(model: EnvModel, def: VarDef): { label: string; level: 'ok' | 'warn' | 'err' } {
  const v = getValue(model, def.key);
  const get = (k: string) => getValue(model, k);
  const isReq =
    def.requirement === 'prod' ||
    (def.requirement === 'conditional' && def.requiredWhen?.(get) === true);
  if (def.store === 'github-actions') return { label: col('GH secret', C.dim), level: 'ok' };
  if (v === undefined || v === '') {
    if (isReq) return { label: col('MISSING', C.red), level: 'err' };
    return { label: col('unset', C.dim), level: 'ok' };
  }
  if (def.insecureDefault && v === def.insecureDefault)
    return { label: col('DEV-DEFAULT!', C.red), level: 'err' };
  if (def.validate) {
    const e = def.validate(v);
    if (e) return { label: col('INVALID', C.red), level: 'err' };
  }
  return { label: col('set', C.green), level: 'ok' };
}

// ───────────────────────────── prints ───────────────────────────────────────

function printInventory(model: EnvModel, reveal: boolean): void {
  console.log('');
  console.log(col(`Libriant secrets — ${model.path}`, C.bold));
  console.log(
    col(
      'origin: machine·gen=auto-generated · human=you type · human·ext=paste from provider · machine·cfg=config',
      C.dim,
    ),
  );
  if (reveal) console.log(col('⚠  REVEALING PLAINTEXT SECRETS BELOW', C.red));
  let group = '';
  for (const def of REGISTRY) {
    if (def.group !== group) {
      group = def.group;
      console.log('');
      console.log(col(`▸ ${group}`, C.bold));
    }
    const v = getValue(model, def.key);
    const shown = reveal ? (v ?? col('(unset)', C.dim)) : maskedDisplay(def, v);
    const st = statusOf(model, def);
    console.log(
      `  ${def.key.padEnd(24)} ${originLabel(def.origin).padEnd(useColor ? 22 : 11)} ` +
        `${saveLabel(def.save).padEnd(useColor ? 16 : 7)} ${rotationLabel(def.rotation).padEnd(useColor ? 16 : 7)} ` +
        `${st.label.padEnd(useColor ? 22 : 12)} ${shown}`,
    );
  }
  console.log('');
  console.log(col('Legend  SAVE ✓ = store in password manager · save~ = recommended', C.dim));
}

function printPasswordManagerExport(model: EnvModel): void {
  console.log('');
  console.log('# ===========================================================');
  console.log('# Libriant — password-manager export');
  console.log(`# file: ${model.path}`);
  console.log('# Store these entries in your password manager. PLAINTEXT below.');
  console.log('# ===========================================================');
  const toSave = REGISTRY.filter((d) => d.save !== 'no');
  for (const store of ['env', 'github-actions'] as Store[]) {
    const group = toSave.filter((d) => d.store === store);
    const present = group.filter((d) => store === 'github-actions' || getValue(model, d.key));
    if (!present.length) continue;
    console.log('');
    console.log(
      store === 'env'
        ? '# --- Stored in the env file ---'
        : '# --- Stored in GitHub Actions secrets (set in the repo, not this file) ---',
    );
    for (const def of present) {
      const v = getValue(model, def.key);
      console.log('');
      console.log(`# ${def.category}`);
      console.log(
        `#   origin: ${def.origin} · save: ${def.save} · rotation: ${def.rotation}` +
          (def.rotationNote ? ` (${def.rotationNote})` : ''),
      );
      console.log(`#   why save: ${def.saveReason}`);
      if (store === 'github-actions' && !v) {
        console.log(`${def.key}=<set in GitHub → Settings → Secrets>`);
      } else {
        console.log(`${def.key}=${v ?? '<unset>'}`);
      }
    }
  }
  console.log('');
}

function printAudit(model: EnvModel): number {
  console.log('');
  console.log(col(`Audit — ${model.path}`, C.bold));
  const get = (k: string) => getValue(model, k);
  const problems: string[] = [];
  const warns: string[] = [];
  for (const def of REGISTRY) {
    if (def.store === 'github-actions') continue;
    const v = getValue(model, def.key);
    const isReq =
      def.requirement === 'prod' ||
      (def.requirement === 'conditional' && def.requiredWhen?.(get) === true);
    if ((v === undefined || v === '') && isReq) {
      problems.push(`${def.key}: MISSING but required for production (${def.category}).`);
      continue;
    }
    if (v === undefined || v === '') continue;
    if (def.insecureDefault && v === def.insecureDefault)
      problems.push(`${def.key}: still the insecure DEV default — regenerate before production.`);
    if (def.validate) {
      const e = def.validate(v);
      if (e) problems.push(`${def.key}: invalid — ${e}`);
    }
    if (def.gen.kind === 'hex' && /^[0-9a-fA-F]+$/.test(v) && v.length < def.gen.bytes * 2)
      warns.push(`${def.key}: shorter than the expected ${def.gen.bytes * 2} hex chars.`);
  }
  if (!problems.length && !warns.length) {
    console.log(col('  ✓ No problems found.', C.green));
  }
  for (const p of problems) console.log(col(`  ✗ ${p}`, C.red));
  for (const w of warns) console.log(col(`  ! ${w}`, C.yellow));
  console.log('');
  return problems.length;
}

// ───────────────────────────── interactive prompts ──────────────────────────

async function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

async function confirm(q: string): Promise<boolean> {
  const a = (await ask(`${q} [y/N] `)).toLowerCase();
  return a === 'y' || a === 'yes';
}

/** Masked input via raw mode (echoes '*'). Falls back to plain read off a TTY. */
function askHidden(q: string): Promise<string> {
  if (!stdin.isTTY) return ask(q);
  return new Promise((resolve) => {
    stdout.write(q);
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (d: Buffer) => {
      for (const ch of d.toString('utf8')) {
        const code = ch.charCodeAt(0);
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          return resolve(buf);
        }
        if (code === 3) {
          // Ctrl-C
          stdout.write('\n');
          process.exit(130);
        }
        if (code === 127 || code === 8) {
          if (buf.length) {
            buf = buf.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (code < 32) continue;
        buf += ch;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

// ───────────────────────────── actions ──────────────────────────────────────

/** Prompt for (or generate) a value for one var, validating before returning. */
async function promptValue(def: VarDef): Promise<string | null> {
  console.log('');
  console.log(col(`${def.key}`, C.bold) + col(`  — ${def.category}`, C.dim));
  console.log(col(`  ${def.description}`, C.dim));
  console.log(col(`  origin: ${def.origin} · save: ${def.save} · ${describeGen(def.gen)}`, C.dim));
  if (def.gen.kind === 'ssh-ed25519') {
    console.log(col('  This is a GitHub Actions secret. Generate a keypair with:', C.yellow));
    console.log(col('    ssh-keygen -t ed25519 -C libriant-deploy -f ./libriant_deploy', C.yellow));
    console.log(
      col('  Add the .pub to each host’s authorized_keys; paste the private key into', C.yellow),
    );
    console.log(
      col('  GitHub → Settings → Secrets → DEPLOY_SSH_KEY. (Not stored in this file.)', C.yellow),
    );
    return null;
  }

  const canGen = def.gen.kind !== 'none';
  for (;;) {
    let value: string;
    if (canGen) {
      const choice = await ask(`  [Enter]=auto-generate · type a value · 'c' to cancel: `);
      if (choice.toLowerCase() === 'c') return null;
      if (choice === '') {
        value = generateFor(def)!;
        console.log(col(`  generated (${value.length} chars, fp:${fingerprint(value)})`, C.green));
      } else {
        value = choice;
      }
    } else {
      const typed = def.secret ? await askHidden('  value (hidden): ') : await ask('  value: ');
      if (typed === '') {
        if (await confirm('  empty value — cancel?')) return null;
        continue;
      }
      value = typed;
    }
    if (def.validate) {
      const e = def.validate(value);
      if (e) {
        console.log(col(`  ✗ ${e}`, C.red));
        continue;
      }
    }
    try {
      serializeKV(def.key, value); // validate it can be stored
    } catch (err) {
      console.log(col(`  ✗ ${(err as Error).message}`, C.red));
      continue;
    }
    return value;
  }
}

async function actionSet(model: EnvModel, key: string, value?: string): Promise<void> {
  const def = BY_KEY.get(key);
  if (!def) {
    console.log(col(`Unknown key "${key}". Run \`print\` to see the catalog.`, C.red));
    return;
  }
  if (def.store === 'github-actions') {
    console.log(col(`${key} lives in GitHub Actions secrets, not this env file.`, C.yellow));
    await promptValue(def); // prints guidance for ssh keys
    return;
  }
  let next = value;
  if (next === undefined) {
    const got = await promptValue(def);
    if (got === null) {
      console.log('  cancelled.');
      return;
    }
    next = got;
  } else if (def.validate) {
    const e = def.validate(next);
    if (e) {
      console.log(col(`✗ ${e}`, C.red));
      return;
    }
  }
  // secrets-tool-new-actionSet: serializeKV (via setValue) can reject the value
  // (single quote / newline / control char). On the explicit-value path that
  // would otherwise throw an uncaught error and exit-1 mid-task — print a
  // friendly message instead, as promptValue's loop already does. The write is
  // aborted before saveModel, so nothing is persisted.
  try {
    setValue(model, key, next);
  } catch (err) {
    console.log(col(`✗ ${(err as Error).message}`, C.red));
    return;
  }
  saveModel(model);
  console.log(col(`✓ ${key} updated in ${model.path}`, C.green));
}

async function actionRotate(model: EnvModel, key: string, assumeYes: boolean): Promise<void> {
  const def = BY_KEY.get(key);
  if (!def) {
    console.log(col(`Unknown key "${key}".`, C.red));
    return;
  }
  if (def.store === 'github-actions') {
    console.log(
      col(`${key} lives in GitHub Actions secrets — rotate it there, not in this file.`, C.yellow),
    );
    if (def.rotationNote) console.log(col(`   ${def.rotationNote}`, C.yellow));
    return;
  }
  if (def.gen.kind === 'none' || def.gen.kind === 'ssh-ed25519') {
    console.log(
      col(
        `${key} can't be auto-generated here (origin: ${def.origin}). Use \`set\` to replace it.`,
        C.yellow,
      ),
    );
    return;
  }
  if (def.rotation === 'never') {
    // Hard refusal — NOT just a warning. Rotating these in this file alone is
    // destructive (MFA_MASTER_KEY orphans every admin's TOTP; POSTGRES_PASSWORD
    // desyncs from the live cluster and locks the app out). They require an
    // out-of-band, coordinated procedure, so the tool will not do it.
    console.log(col(`⛔ ${key} must NOT be rotated with this tool.`, C.red));
    if (def.rotationNote) console.log(col(`   ${def.rotationNote}`, C.red));
    console.log(col(`   Refusing. Follow the documented coordinated procedure instead.`, C.red));
    return;
  }
  if (def.rotation === 'caution') {
    console.log(col(`⚠  Rotating ${key} has side effects:`, C.yellow));
    if (def.rotationNote) console.log(col(`   ${def.rotationNote}`, C.yellow));
  }
  if (!assumeYes && !(await confirm(`Rotate ${key} now?`))) {
    console.log('  cancelled.');
    return;
  }
  const value = generateFor(def)!;
  setValue(model, key, value);
  saveModel(model);
  console.log(col(`✓ ${key} rotated (new fp:${fingerprint(value)}) in ${model.path}`, C.green));
}

async function actionInit(model: EnvModel, assumeYes: boolean): Promise<void> {
  const created: string[] = [];
  for (const def of REGISTRY) {
    if (def.store !== 'env' || def.gen.kind === 'none' || def.gen.kind === 'ssh-ed25519') continue;
    const existing = getValue(model, def.key);
    if (existing && existing !== '') continue; // never overwrite
    const value = generateFor(def)!;
    setValue(model, def.key, value);
    created.push(def.key);
  }
  if (!created.length) {
    console.log(col('Nothing to generate — every generated secret already has a value.', C.green));
  } else {
    saveModel(model);
    console.log(col(`✓ Generated ${created.length} secret(s): ${created.join(', ')}`, C.green));
    console.log(
      col(
        '  NOTE: POSTGRES_PASSWORD was only generated if it was unset — never regenerate it on a DB that is already initialized.',
        C.dim,
      ),
    );
  }
  // Surface still-missing human/external requirements.
  const get = (k: string) => getValue(model, k);
  const missing = REGISTRY.filter(
    (d) =>
      d.store === 'env' &&
      (d.requirement === 'prod' ||
        (d.requirement === 'conditional' && d.requiredWhen?.(get) === true)) &&
      !getValue(model, d.key),
  );
  if (missing.length) {
    console.log('');
    console.log(col('Still need a value (set them with `set` / option 3):', C.yellow));
    for (const d of missing) console.log(col(`  - ${d.key}  (${d.category})`, C.yellow));
  }
  void assumeYes;
}

async function actionGenerate(): Promise<void> {
  console.log('');
  console.log(col('Standalone generator', C.bold));
  const kind = await ask('  [1] strong password  [2] URL-safe password  [3] hex key : ');
  if (kind === '3') {
    const bytes = Number((await ask('  bytes (default 32): ')) || '32');
    console.log('');
    console.log(col(genHex(Number.isFinite(bytes) && bytes > 0 ? bytes : 32), C.bold));
  } else {
    const len = Number((await ask('  length (default 20): ')) || '20');
    const n = Number.isFinite(len) && len > 0 ? len : 20;
    console.log('');
    console.log(col(genPassword(n, kind === '2'), C.bold));
  }
  console.log('');
}

// ───────────────────────────── interactive menu ─────────────────────────────

async function chooseKey(filter: (d: VarDef) => boolean, title: string): Promise<VarDef | null> {
  const items = REGISTRY.filter(filter);
  console.log('');
  console.log(col(title, C.bold));
  items.forEach((d, i) =>
    console.log(`  ${String(i + 1).padStart(2)}) ${d.key.padEnd(24)} ${col(d.category, C.dim)}`),
  );
  const a = await ask('  number (or blank to cancel): ');
  if (a === '') return null;
  const idx = Number(a) - 1;
  return items[idx] ?? null;
}

async function menu(model: EnvModel): Promise<void> {
  for (;;) {
    console.log('');
    console.log(col('═══ Libriant secrets manager ═══', C.bold));
    console.log(col(`file: ${model.path}`, C.dim));
    console.log('  1) Show inventory (masked + classification)');
    console.log('  2) Reveal one secret');
    console.log('  3) Set / assign a variable');
    console.log('  4) Generate a password / key');
    console.log('  5) Rotate (regenerate) a secret');
    console.log('  6) Initialize — generate every missing secret');
    console.log('  7) Audit — missing / insecure / weak');
    console.log('  8) Export for password manager (reveals secrets)');
    console.log('  9) Change file');
    console.log('  0) Quit');
    const choice = await ask('  > ');
    switch (choice) {
      case '1':
        printInventory(model, false);
        break;
      case '2': {
        const def = await chooseKey((d) => d.store === 'env', 'Reveal which secret?');
        if (def) {
          const v = getValue(model, def.key);
          console.log('');
          console.log(v === undefined ? col('(unset)', C.dim) : `${def.key}=${v}`);
        }
        break;
      }
      case '3': {
        const def = await chooseKey(() => true, 'Set which variable?');
        if (def) await actionSet(model, def.key);
        break;
      }
      case '4':
        await actionGenerate();
        break;
      case '5': {
        const def = await chooseKey(
          (d) => d.store === 'env' && d.gen.kind !== 'none',
          'Rotate which secret?',
        );
        if (def) await actionRotate(model, def.key, false);
        break;
      }
      case '6':
        await actionInit(model, false);
        break;
      case '7':
        printAudit(model);
        break;
      case '8':
        if (await confirm('This prints PLAINTEXT secrets to the terminal. Continue?'))
          printPasswordManagerExport(model);
        break;
      case '9': {
        const p = await ask('  new env file path: ');
        if (p) {
          model = loadModel(p);
          console.log(col(`switched to ${p}`, C.green));
        }
        break;
      }
      case '0':
      case 'q':
        return;
      default:
        console.log(col('  unknown choice', C.yellow));
    }
  }
}

// ───────────────────────────── entry point ──────────────────────────────────

function resolveDefaultFile(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.SECRETS_ENV_FILE) return process.env.SECRETS_ENV_FILE;
  for (const c of ['/srv/libriant/.env.prod', './.env.prod', './.env.local']) {
    if (existsSync(c)) return c;
  }
  return '/srv/libriant/.env.prod';
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgsLocal();
  const file = resolveDefaultFile(values.file);
  const model = loadModel(file);
  if (!existsSync(file)) {
    console.log(
      col(`Note: ${file} does not exist yet; it will be created on first write.`, C.yellow),
    );
  }

  const sub = positionals[0];
  if (!sub) {
    if (!stdin.isTTY) {
      console.log(
        'Non-interactive with no subcommand. Try: print | init | set | rotate | audit | gen',
      );
      return;
    }
    await menu(model);
    return;
  }

  switch (sub) {
    case 'print': {
      const fmt = values.format ?? 'table';
      const reveal = !!values.reveal;
      if (reveal && !values.yes && stdin.isTTY) {
        if (!(await confirm('Reveal PLAINTEXT secrets?'))) return;
      }
      if (fmt === 'pwmanager') {
        if (!reveal) {
          console.log(col('pwmanager format prints secrets — pass --reveal --yes.', C.yellow));
          return;
        }
        printPasswordManagerExport(model);
      } else if (fmt === 'json') {
        printJson(model, reveal);
      } else if (fmt === 'env') {
        // Raw env dump is full plaintext (every secret) — same exposure as
        // pwmanager, so require the same explicit opt-in.
        if (!reveal) {
          console.log(
            col('env format prints all secrets in plaintext — pass --reveal --yes.', C.yellow),
          );
          return;
        }
        for (const l of model.lines) console.log(l.raw);
      } else {
        printInventory(model, reveal);
      }
      break;
    }
    case 'init':
      await actionInit(model, !!values.yes);
      break;
    case 'set':
      if (!positionals[1]) {
        console.log('usage: set KEY [VALUE]');
        break;
      }
      await actionSet(model, positionals[1], positionals[2]);
      break;
    case 'rotate':
      if (!positionals[1]) {
        console.log('usage: rotate KEY');
        break;
      }
      await actionRotate(model, positionals[1], !!values.yes);
      break;
    case 'audit': {
      const n = printAudit(model);
      if (n > 0) process.exitCode = 2;
      break;
    }
    case 'gen': {
      // SEC-06: validate the parsed number. A bad --length/--hex (e.g. `l8`
      // with a letter ell, or a typo) parses to NaN, which silently produced an
      // EMPTY secret — an operator could paste a blank value into a credential
      // field believing it was generated. Reject NaN/<=0 loudly and clamp the
      // upper bound (mirrors actionGenerate's guards).
      if (values.hex !== undefined) {
        const bytes = Number(values.hex);
        if (!Number.isInteger(bytes) || bytes <= 0) {
          console.log(col(`✗ --hex must be a positive integer (got "${values.hex}").`, C.red));
          process.exitCode = 1;
          break;
        }
        console.log(genHex(Math.min(bytes, 4096)));
      } else {
        const len = Number(values.length ?? '20');
        if (!Number.isInteger(len) || len <= 0) {
          console.log(
            col(`✗ --length must be a positive integer (got "${values.length}").`, C.red),
          );
          process.exitCode = 1;
          break;
        }
        console.log(genPassword(Math.min(len, 4096), false));
      }
      break;
    }
    default:
      console.log(`Unknown command "${sub}". Try: print | init | set | rotate | audit | gen`);
  }
}

interface CliValues {
  file?: string;
  format?: string;
  reveal?: boolean;
  yes?: boolean;
  length?: string;
  hex?: string;
}
function parseArgsLocal(): { values: CliValues; positionals: string[] } {
  const argv = process.argv.slice(2);
  const values: CliValues = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--reveal') values.reveal = true;
    else if (a === '--yes' || a === '-y') values.yes = true;
    else if (a === '--file') values.file = argv[++i];
    else if (a.startsWith('--file=')) values.file = a.slice(7);
    else if (a === '--format') values.format = argv[++i];
    else if (a.startsWith('--format=')) values.format = a.slice(9);
    else if (a === '--length') values.length = argv[++i];
    else if (a.startsWith('--length=')) values.length = a.slice(9);
    else if (a === '--hex') values.hex = argv[++i];
    else if (a.startsWith('--hex=')) values.hex = a.slice(6);
    else if (a === '--prod') values.file = '/srv/libriant/.env.prod';
    else if (a === '--dev') values.file = './.env.local';
    else if (a.startsWith('-')) {
      // ignore unknown flags rather than crash an operator mid-task
    } else positionals.push(a);
  }
  return { values, positionals };
}

function printJson(model: EnvModel, reveal: boolean): void {
  const out = REGISTRY.map((d) => {
    const v = getValue(model, d.key);
    return {
      key: d.key,
      group: d.group,
      category: d.category,
      origin: d.origin,
      secret: d.secret,
      store: d.store,
      save: d.save,
      saveReason: d.saveReason,
      rotation: d.rotation,
      rotationNote: d.rotationNote ?? null,
      status: statusOf(model, d).level,
      value: d.secret && !reveal ? (v ? `•••(${v.length})` : null) : (v ?? null),
    };
  });
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  process.stderr.write(`[${SCRIPT}] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
