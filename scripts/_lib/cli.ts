import { parseArgs as nodeParseArgs } from 'node:util';

/**
 * Thin wrapper around `node:util#parseArgs` that uppercases its
 * error messages and exits on bad input rather than throwing. Keeps
 * the per-script entry points readable.
 */
export function parseArgs<
  T extends Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>,
>(opts: { name: string; description: string; options: T; required?: ReadonlyArray<keyof T> }) {
  try {
    const { values, positionals } = nodeParseArgs({
      options: opts.options as never,
      allowPositionals: true,
      strict: true,
    });
    if (opts.required) {
      const missing = opts.required.filter((k) => values[k as string] === undefined);
      if (missing.length) {
        die(
          opts.name,
          `missing required flag(s): ${missing.map((m) => `--${String(m)}`).join(', ')}`,
        );
      }
    }
    return { values, positionals };
  } catch (err) {
    die(opts.name, (err as Error).message);
  }
}

export function die(name: string, msg: string): never {
  process.stderr.write(`[${name}] ${msg}\n`);
  process.exit(1);
}

export function log(name: string, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[${name}] ${msg}`);
}

export function isYes(v: unknown): boolean {
  return v === true || v === 'true' || v === 'yes' || v === '1';
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `Slug must be 2–50 chars, lowercase letters/digits/hyphens, no leading/trailing hyphen. Got "${slug}".`,
    );
  }
}

/**
 * Build a per-database Postgres URL by swapping the path component on
 * the superuser URL. Same shape used by TenantProvisioningService.
 */
export function urlForDb(baseUrl: string, dbName: string): string {
  const u = new URL(baseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** `cmpp...` → `tenant_cmpp...`. Safe for Postgres identifier. */
export function dbNameForTenant(tenantId: string): string {
  return `tenant_${tenantId.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
}
