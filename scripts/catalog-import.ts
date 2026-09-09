/**
 * Libriant — load a MARC file into a library's 2.0 catalogue.
 *
 * The ingest route is bounded on purpose: `bib.constants.ts` records that
 * `CATALOG_INGEST_MAX_RECORDS` is 1,000 because an ingest in flight when a
 * deploy lands must finish inside `SHUTDOWN_DEADLINE_MS`, which is 20 seconds.
 * A real file is bigger than that, so something has to chunk it, and this is
 * that something.
 *
 * IT SPLITS WITH `splitIso2709` — the SAME function the server uses. A chunk
 * boundary therefore always falls between records, never inside one, which is
 * the whole reason this exists rather than a `split -b` in a shell. (The server
 * refuses a chunk whose last record has no terminator precisely so that a
 * hand-cut file cannot get in.)
 *
 * This is the primitive, not the migration tool. Phase 35 brings the ABEKT,
 * Koha and Aleph adapters with their field-level coverage report, dry run and
 * credential policy; phase 30 brings copy cataloguing with overlay rules. What
 * this does is put a `.mrc` file into a catalogue and tell you what happened to
 * every record in it.
 *
 *   ENV:
 *     LIBRIANT_API_URL   — e.g. http://localhost:3001 (default)
 *     LIBRIANT_COOKIE    — a staff session cookie for the library
 *
 *   USAGE:
 *     pnpm catalog:import --slug=acme --file=./nlg-export.mrc
 *     pnpm catalog:import --slug=acme --file=./big.mrc --chunk=500
 *     pnpm catalog:import --slug=acme --file=./big.mrc --dry-run
 *
 *   EXIT:
 *     0  every record was created
 *     1  the file could not be read, the API refused, or any record failed
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
// A RELATIVE import, like `catalog-verify.ts`'s reach into `apps/api`. The
// root workspace does not depend on `@libriant/marc`, and adding a dependency
// so one script can call one function would put a package in the production
// closure that `check:supply-chain` would then have to account for.
import { splitIso2709 } from '../packages/marc/src/iso2709.js';
import { die, isYes, log, parseArgs } from './_lib/cli.js';

const SCRIPT = 'catalog-import';

const args = parseArgs({
  name: SCRIPT,
  description: "Load a MARC file into a library's 2.0 catalogue, chunk by chunk.",
  options: {
    slug: { type: 'string' },
    file: { type: 'string' },
    chunk: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
  required: ['slug', 'file'],
});

const slug = String(args.values.slug);
const file = String(args.values.file);
const dryRun = isYes(args.values['dry-run']);
/** The server's own cap. Sending more is a wasted round trip that gets truncated. */
const chunkSize = Math.max(1, Math.min(1000, Number(args.values.chunk ?? 1000)));

const base = (process.env.LIBRIANT_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const cookie = process.env.LIBRIANT_COOKIE ?? '';

type IngestResult = {
  total: number;
  processed: number;
  truncated: boolean;
  created: number;
  failed: number;
  results: { index: number; ok: boolean; code?: string; message?: string; roundtrips?: boolean }[];
};

async function main(): Promise<void> {
  if (!cookie && !dryRun) {
    die(SCRIPT, 'Set LIBRIANT_COOKIE to a staff session cookie for this library.');
  }

  const bytes = new Uint8Array(readFileSync(file));
  const slices = splitIso2709(bytes);
  if (slices.length === 0) die(SCRIPT, `${file} holds no ISO 2709 record.`);
  log(SCRIPT, `${file}: ${slices.length} record(s), ${(bytes.length / 1e6).toFixed(2)} MB`);

  // Chunks are built by CONCATENATING WHOLE SLICES, so every chunk is a valid
  // MARC file in its own right. Reassembling from the slices rather than
  // slicing the original buffer also means a file with junk between records
  // arrives at the server without it.
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < slices.length; i += chunkSize) {
    chunks.push(concat(slices.slice(i, i + chunkSize)));
  }
  log(SCRIPT, `${chunks.length} chunk(s) of at most ${chunkSize}`);

  if (dryRun) {
    log(SCRIPT, 'dry run: nothing was sent.');
    return;
  }

  let created = 0;
  let failed = 0;
  for (const [n, chunk] of chunks.entries()) {
    // THE KEY IS DERIVED FROM THE BYTES.
    //
    // The idempotency interceptor keys on tenant + method + path + key and does
    // NOT look at the body, so a key reused across two different chunks would
    // replay the first chunk's response and silently drop the second. Deriving
    // it from the content makes that impossible: two chunks with different bytes
    // cannot collide, and a retry of the SAME chunk is exactly what should
    // replay.
    const key = createHash('sha256').update(chunk).digest('hex').slice(0, 32);
    const res = await fetch(`${base}/t/${slug}/catalog/bib/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/marc',
        'Idempotency-Key': key,
        Cookie: cookie,
      },
      body: chunk,
    });
    const body = (await res.json()) as IngestResult & { message?: string; code?: string };
    if (!res.ok) {
      die(SCRIPT, `chunk ${n + 1}/${chunks.length} refused (${res.status}): ${body.message ?? ''}`);
    }
    // A replayed chunk means the key collided with an earlier request, which
    // with a content-derived key means the same bytes were sent twice. Worth
    // saying out loud rather than silently counting its records again.
    if (res.headers.get('x-idempotent-replay')) {
      log(SCRIPT, `chunk ${n + 1}/${chunks.length}: replayed (identical bytes already sent)`);
    }
    created += body.created;
    failed += body.failed;
    const notRoundTripped = body.results.filter((r) => r.ok && r.roundtrips === false).length;
    log(
      SCRIPT,
      `chunk ${n + 1}/${chunks.length}: ${body.created} created, ${body.failed} failed` +
        (notRoundTripped > 0 ? `, ${notRoundTripped} not byte-reproducible` : '') +
        (body.truncated ? ` (TRUNCATED at ${body.processed}/${body.total})` : ''),
    );
    for (const r of body.results.filter((x) => !x.ok).slice(0, 10)) {
      log(SCRIPT, `  record ${r.index}: ${r.code} — ${r.message}`);
    }
  }

  log(SCRIPT, `${created} record(s) created, ${failed} failed, from ${slices.length} in the file`);
  if (failed > 0 || created + failed < slices.length) process.exitCode = 1;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

main().catch((err: unknown) => die(SCRIPT, String((err as Error).message)));
