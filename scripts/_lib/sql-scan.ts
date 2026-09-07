/**
 * Strip SQL down to the parts a checker may reason about.
 *
 * Pattern-matching raw migration SQL is how a linter earns a reputation for
 * lying. This repository's migrations are unusually comment-heavy — the
 * `20260826090000_catalog_natural_key_uniqueness` file spends 90 lines
 * explaining the constraint before creating it — and those comments quote the
 * very constructs a safety gate looks for. `-- Not CONCURRENTLY, because
 * prisma migrate deploy wraps each file in a transaction` appears in SEVEN
 * migrations, and a naive `grep CONCURRENTLY` fails all seven.
 *
 * (That sentence is, as it happens, false — measured in phase 9: deploy does
 * not wrap a file, and a mid-file failure leaves earlier DDL committed. The
 * four applied migrations that state it are left exactly as written, because
 * Prisma checksums a migration and refuses to deploy when one it has recorded
 * no longer hashes the same. Correcting history here would break every database
 * that has run them, which is the same reason this repository fixes a bad
 * migration with a NEW migration. The claim is corrected where it is still
 * load-bearing: `online-track.ts` and `check-migration-safety.ts`.)
 *
 * So: remove line comments, block comments and ordinary string literals, and
 * KEEP dollar-quoted bodies, because a `$function$ … $function$` block is
 * executable code and everything a gate cares about can hide in one.
 *
 * A dollar-quoted body is scrubbed RECURSIVELY, not kept verbatim. PL/pgSQL is
 * code, and code has comments: `20260826090000_catalog_natural_key_uniqueness`
 * carries the line `-- MUST be UTC wall time, not bare \`now()\`` inside a
 * DO block, and keeping the body whole reported that warning as the very
 * violation it warns about.
 *
 * Positions are preserved. Every removed character is replaced by a space (or
 * a newline, so line numbers survive), which means an offset in the scrubbed
 * text is the same offset in the original and a finding can name a real line.
 */

export interface ScrubbedSql {
  /** Same length as the input; comments and string literals blanked out. */
  readonly code: string;
  readonly original: string;
}

const DOLLAR_TAG = /\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/y;

export function scrubSql(sql: string): ScrubbedSql {
  const out = new Array<string>(sql.length);
  let i = 0;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) out[k] = sql[k] === '\n' ? '\n' : ' ';
  };
  const keep = (from: number, to: number) => {
    for (let k = from; k < to; k += 1) out[k] = sql[k] as string;
  };

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (two === '/*') {
      // Postgres block comments nest.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === '/*') {
          depth += 1;
          j += 2;
        } else if (sql.slice(j, j + 2) === '*/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (sql[i] === '$') {
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(sql);
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? sql.length : close + tag.length;
        const bodyStart = i + tag.length;
        const bodyEnd = close === -1 ? sql.length : close;
        // The delimiters are code; the body is code that itself needs scrubbing.
        keep(i, bodyStart);
        const inner = scrubSql(sql.slice(bodyStart, bodyEnd)).code;
        for (let k = 0; k < inner.length; k += 1) out[bodyStart + k] = inner[k] as string;
        keep(bodyEnd, end);
        i = end;
        continue;
      }
    }

    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (sql[i] === '"') {
      // A quoted identifier is code, not a literal — Prisma quotes every one.
      let j = i + 1;
      while (j < sql.length && sql[j] !== '"') j += 1;
      j = Math.min(j + 1, sql.length);
      keep(i, j);
      i = j;
      continue;
    }

    out[i] = sql[i] as string;
    i += 1;
  }

  return { code: out.join(''), original: sql };
}

/** 1-indexed line number for a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/** The source line containing an offset, trimmed. */
export function lineTextAt(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset) + 1;
  const end = text.indexOf('\n', offset);
  return text.slice(start, end === -1 ? text.length : end).trim();
}
