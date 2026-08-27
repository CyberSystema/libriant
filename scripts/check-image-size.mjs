#!/usr/bin/env node
// The production images are 1.18 GB and 1.03 GB, and nothing in this repository
// has ever objected.
//
// supply-chain-03 was closed on the claim that the production image ships no
// dev tooling. verify.yml's `image-contents` job checks that half now: it lists
// `node_modules/.pnpm` inside both images and greps for the banned set. The
// other half of the same finding is a claim about SIZE, and that half has never
// been checked by anything at all. The only reason the two figures above are
// known is that a `docker image ls` step which had been passing two references
// to a command that takes one — and had therefore never once run — was fixed on
// 2026-08-27 and finally printed a number.
//
// Two totals in a log are neither a diagnostic nor a gate, so this is both:
//
//   --report    per-layer breakdown, biggest first. `docker history` has never
//               been run against these images. It is the first thing anyone
//               debugging size needs and the thing nobody thinks to run.
//   --enforce   (the default) fail when an image leaves the band recorded
//               below.
//
// It needs Docker and both images already built, so it is deliberately NOT part
// of `pnpm check:all` — that gate is the one you can run on a laptop, and this
// one cannot be. It runs inside the job that already builds both images, so the
// gate costs no extra build.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

// Docker's own unit. `docker image ls` prints base-1000 sizes ("1.18GB"), so a
// budget in MiB would be a budget in a unit nobody reading the log is holding.
const MB = 1_000_000;

// ---------------------------------------------------------------------------
// THE BUDGET.
//
// Editing these two numbers is the entire mechanism. A ceiling that lives in an
// env var or a workflow input gets raised by whoever is unblocking themselves,
// and the diff reads `1240` → `1600` with no argument attached to it. Here it
// costs a commit, a reviewer and a paragraph.
//
// `measuredMb` is what CI actually reported, never an aspiration. `headroomMb`
// is how far the image may move before someone has to look.
//
// THESE ARE PRE-WAVE NUMBERS AND MUST BE TIGHTENED. They are the 2026-08-27
// measurement, taken before the changes intended to make these images smaller.
// The first run after those land will trip the FLOOR and print the new figure;
// paste it into `measuredMb` and leave the headroom alone. That failure is the
// mechanism working, not a fault in it.
//
// Why the band is two-sided, and why the floor is not pedantry:
//
//   Ceiling — catches a regression. The Dockerfiles' own comments carry the
//   measured size of every tree that has been thrown out of these images: next
//   198 MB, @next/swc 84.8 MB, @prisma/client 74.9 MB, @prisma/studio-core
//   42.2 MB, the Prisma CLI 41.9 MB, @electric-sql/pglite 23.2 MB. Each of
//   those got in the same way — one workspace manifest in a `deps` COPY list —
//   and each can come back the same way. The smallest is 41.9 MB, so the
//   ceiling has to sit below that or it is not guarding the door it was put on.
//
//   Floor — catches a prune that took too much. Nothing in CI boots the WEB
//   image; the job only asserts that `next --version` resolves inside it. A
//   prune that ate 300 MB of framework would pass every other check in that job
//   and be found by a library. A sudden drop is either that or a real saving,
//   and a real saving is a number worth writing down, so either way it should
//   stop and make someone look.
//
// Why 30. The size of these images is a pure function of committed files:
// `--frozen-lockfile` means no dependency moves without a lockfile diff, and
// supply-chain-05 pins the base image by digest so upstream cannot republish
// underneath it. There is no routine drift to absorb — only build
// nondeterminism, worth a few MB, and the ±5 MB of rounding in the 1.18GB /
// 1.03GB figures below, which `docker image ls` prints to three significant
// figures. 30 MB is six times that slack and still well under the 41.9 MB
// smallest regression above. The rounding slack disappears the first time
// someone updates a number from THIS script's output, which reports the exact
// `docker image inspect` byte count.
//
// `awaitingMeasurement` — the one honest way to land a change before its number
// exists.
//
// This wave removed a duplicated copy of /app from both images, ~86–95 MiB of
// source maps and type declarations, four database engines' worth of Prisma
// query compilers, and Turbopack's build cache. Every one is deliberate and
// every one is explained in the Dockerfile that made it. The projections are
// ~535 MB and ~450 MB, which means both images fail the FLOOR recorded above by
// several hundred megabytes — the floor doing exactly its job, on the one
// occasion when the drop is intended.
//
// Setting `measuredMb` to a projection would be the easy fix and would quietly
// destroy the property that makes this file worth having: that every number in
// it is something CI actually reported. So a budget may instead declare that it
// is waiting for a measurement. In that state the script REPORTS the size, does
// not enforce, and prints the exact line to paste — loudly, on every run, in a
// shape nobody can mistake for a pass. An unenforced budget that announces
// itself on every build is a state that gets fixed; a projection written into
// `measuredMb` is one that never does.
const BUDGETS = [
  // Was 1180 MB on the verify run of 2026-08-27; projected ~535 MB after this
  // wave. Enforcement resumes when someone pastes the real figure.
  { image: 'libriant-api:verify', measuredMb: 1180, headroomMb: 30, awaitingMeasurement: true },
  // Was 1030 MB, same run; projected ~450 MB.
  { image: 'libriant-web:verify', measuredMb: 1030, headroomMb: 30, awaitingMeasurement: true },
];
// ---------------------------------------------------------------------------

// Wide enough for `RUN node scripts/docker-prune-dev-modules.mjs --root . --root apps/api …`
// to still say which prune it is, narrow enough that the size column stays
// readable when the Actions log wraps.
const MAX_COMMAND = 96;

const mode = process.argv.includes('--report') ? 'report' : 'enforce';

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Accepts both `--human=false` byte counts and the human strings docker falls
// back to, because a size gate that dies on its own output format is worse than
// no size gate. Docker's decimal abbreviations are B/kB/MB/GB/TB.
const UNITS = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
};

function parseSize(text) {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]{0,3})\s*$/.exec(text);
  if (!m) return null;
  const unit = UNITS[(m[2] || 'B').toUpperCase()];
  return unit === undefined ? null : Number(m[1]) * unit;
}

function layersOf(image) {
  const raw = docker([
    'history',
    '--no-trunc',
    '--human=false',
    '--format',
    '{{.Size}}\t{{.CreatedBy}}',
    image,
  ]);

  const layers = [];
  for (const line of raw.split('\n')) {
    const tab = line.indexOf('\t');
    const bytes = tab === -1 ? null : parseSize(line.slice(0, tab));
    if (bytes === null) {
      // A multi-line `RUN` keeps its line breaks inside a single history
      // record, so a line with no leading size belongs to the record above it
      // rather than being a layer of its own. Splitting on newlines alone would
      // silently invent layers and drop their commands.
      if (layers.length && line.trim()) layers[layers.length - 1].createdBy += ` ${line.trim()}`;
      continue;
    }
    layers.push({ bytes, createdBy: line.slice(tab + 1) });
  }
  // `docker history` prints newest first; number them in build order so a layer
  // can be found by reading the Dockerfile top to bottom.
  layers.reverse().forEach((l, i) => (l.step = i + 1));
  return layers;
}

function tidy(createdBy) {
  const text = createdBy
    .replace(/\s+/g, ' ')
    .replace(/\s*#\s*buildkit\s*$/, '')
    .trim();
  return text.length > MAX_COMMAND ? `${text.slice(0, MAX_COMMAND - 1)}…` : text;
}

const mb = (bytes) => (bytes / MB).toFixed(1);

function summary(markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  try {
    appendFileSync(path, markdown);
  } catch {
    // The breakdown is already on stdout; losing the prettier copy is not worth
    // failing a build over.
  }
}

// A missing daemon is the difference between "this image is fine" and "nothing
// was measured". Report mode is wired with `if: always()`, so on a run where the
// build itself failed it must not pile a second red X onto the real failure.
try {
  docker(['version', '--format', '{{.Server.Version}}']);
} catch {
  const message =
    'docker is not available, so no image could be measured. This check needs both ' +
    'images built — see the `image-contents` job in .github/workflows/verify.yml.';
  if (mode === 'report') {
    console.log(`::notice::${message}`);
    process.exit(0);
  }
  console.error(`✗ ${message}`);
  process.exit(1);
}

let failures = 0;

for (const { image, measuredMb, headroomMb, awaitingMeasurement } of BUDGETS) {
  const ceilingMb = measuredMb + headroomMb;
  const floorMb = measuredMb - headroomMb;

  let bytes = NaN;
  try {
    bytes = Number(docker(['image', 'inspect', '--format', '{{.Size}}', image]).trim());
  } catch {
    // Falls through to the not-a-number branch below with the same message: a
    // missing image and an unreadable one are the same fact here — nothing was
    // measured — and both must fail rather than quietly pass. `NaN > ceiling`
    // and `NaN < floor` are both false, so without this the comparisons below
    // would report an unmeasured image as inside its budget.
  }
  if (!Number.isFinite(bytes) || bytes <= 0) {
    if (mode === 'report') {
      console.log(`::notice::${image} could not be measured — it was probably never built.`);
      continue;
    }
    console.error(`✗ ${image} could not be measured, so its budget proved nothing.`);
    failures++;
    continue;
  }

  const sizeMb = bytes / MB;
  console.log(
    `\n${image}  ${mb(bytes)} MB  (budget ${floorMb}–${ceilingMb} MB, ` +
      `recorded ${measuredMb} MB ±${headroomMb})`,
  );

  if (mode === 'report') {
    // `--report` runs under `if: always()` so it still prints after a failure
    // earlier in the job. That makes it the one mode that must never ADD a red
    // X of its own — the size was already reported above, and a breakdown is a
    // diagnostic, not a gate. `docker history` sat outside every guard here, so
    // one unparseable line would have failed a step whose whole contract is
    // that it cannot.
    let layers;
    try {
      layers = layersOf(image);
    } catch (err) {
      console.log(
        `::notice::${image}: no layer breakdown — ${(err && err.message) || err}. ` +
          'The size above is unaffected.',
      );
      continue;
    }
    const empty = layers.filter((l) => l.bytes === 0).length;
    const rows = layers
      .filter((l) => l.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes)
      .map((l) => ({ ...l, share: (l.bytes / bytes) * 100 }));

    console.log(`  ${'size'.padStart(10)}  share  layer`);
    for (const r of rows) {
      const share = `${r.share.toFixed(1)}%`.padStart(5);
      console.log(
        `  ${`${mb(r.bytes)} MB`.padStart(10)}  ${share}  #${String(r.step).padEnd(2)} ${tidy(r.createdBy)}`,
      );
    }
    console.log(`  ${empty} further layer(s) carry metadata only (0 B).`);

    summary(
      `\n### ${image} — ${mb(bytes)} MB\n\n| size | share | layer |\n| ---: | ---: | --- |\n` +
        rows
          .map(
            (r) =>
              `| ${mb(r.bytes)} MB | ${r.share.toFixed(1)}% | \`${tidy(r.createdBy).replace(/\|/g, '\\|')}\` |`,
          )
          .join('\n') +
        `\n\nPlus ${empty} metadata-only layer(s). Budget ${floorMb}–${ceilingMb} MB.\n`,
    );
    continue;
  }

  // Report the number, name the state, print the fix, and do not enforce.
  // Deliberately BEFORE the ceiling/floor comparisons: a recorded figure that is
  // known to be stale must not be allowed to pass judgement on a real one.
  if (awaitingMeasurement) {
    console.log(
      `::warning::${image} BUDGET NOT ENFORCED — waiting for a measurement. ` +
        `Now ${mb(bytes)} MB; the recorded ${measuredMb} MB predates the change that shrank it.`,
    );
    console.log('    Paste this into BUDGETS in scripts/check-image-size.mjs and drop');
    console.log('    `awaitingMeasurement`, which re-arms the ceiling and the floor:');
    console.log(
      `      { image: '${image}', measuredMb: ${Math.round(sizeMb)}, headroomMb: ${headroomMb} },`,
    );
    continue;
  }

  if (sizeMb > ceilingMb) {
    console.error(
      `✗ ${image} is ${mb(bytes)} MB — ${(sizeMb - ceilingMb).toFixed(1)} MB over its ` +
        `${ceilingMb} MB ceiling.`,
    );
    console.error('    Read the top rows of the `Image size and layer breakdown` step above:');
    console.error('    they name the layer that grew. The usual cause is a workspace manifest');
    console.error('    added to a `deps` COPY list, which installs a whole tree. If the growth');
    console.error('    is intended, raise `measuredMb` in scripts/check-image-size.mjs and say');
    console.error('    in the commit message what grew and why it is worth carrying.');
    failures++;
  } else if (sizeMb < floorMb) {
    console.error(
      `✗ ${image} is ${mb(bytes)} MB — ${(floorMb - sizeMb).toFixed(1)} MB under the ` +
        `${floorMb} MB floor recorded for it.`,
    );
    console.error('    Either the image lost something it needs — nothing in CI boots the web');
    console.error('    image at all, so a prune that ate the framework would look exactly like');
    console.error('    this — or a real saving landed and nobody wrote it down.');
    console.error(
      `    If it is the saving: set this image's measuredMb to ${Math.round(sizeMb)} in`,
    );
    console.error('    scripts/check-image-size.mjs, so the next regression is measured against');
    console.error('    what this image actually is rather than what it used to be.');
    failures++;
  } else {
    console.log('  ✓ inside budget');
  }
}

if (failures) {
  console.error(`\n::error::${failures} image(s) failed the size budget.`);
  process.exit(1);
}

if (mode === 'enforce') {
  console.log(`\nimage-size check passed: ${BUDGETS.length} image(s) inside their recorded band.`);
}
