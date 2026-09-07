# Libriant 2.0 — architecture of record

This directory holds the design Libriant is being built to. It exists here, in
the repository, for the same reason `docs/audit/` does: the reasoning behind a
decision has to be readable next to the code that implements it, years later,
by someone who was not in the room.

## What is here

| File                                                 | What it is                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`MASTER-ARCHITECTURE.md`](./MASTER-ARCHITECTURE.md) | The plan of record. Target architecture, the bibliographic-core decision with its DDL, the 2.0 tenant schema, nine cross-cutting contracts each with exactly one owner, the standards compliance matrix, the phased roadmap, what is deliberately not built, and the top risks. |

## How it was produced, and what that means for trusting it

Eight domain architectures were designed independently — bibliographic core,
circulation, acquisitions/serials/ERM/ILL, interoperability, the native desktop
client, search and AI, patron experience, and platform. Three adversarial
reviewers then read all eight together: one for merge coherence (contradictions,
duplication, seams with no owner), one for library-standards correctness, and
one for deliverability and sequencing. The master document is the synthesis, and
it resolves every conflict by CHOOSING — where two specs disagreed, one option
is in the document and the other is deleted rather than deferred.

That process is worth knowing about because of what the standards reviewer
caught. Several of the eight specs were confidently wrong in ways that would
have shipped:

- **MARC leader.** Three specs said to store and re-emit Leader/10, /11 and
  /20-23 verbatim. Those positions are FIXED in MARC 21 (`2`, `2`, `4500`).
  Records written that way are rejected by Koha, Alma, Voyager and
  `yaz-marcdump`. The rule is asymmetric: honour what a record declares on
  read, always emit the fixed values on write.
- **ISO 28560.** Part 2 and part 3 were described the wrong way round, and the
  RFID **AFI polarity was inverted** — `0xC2` is secured/in-library and `0x07`
  is unsecured/on-loan. Shipped as specified, the security gate would have
  alarmed on every book a patron legitimately checked out and stayed silent for
  every book that walked out unissued.
- **SIP2.** Messages 96 and 97 were described in the wrong direction. `96` is
  Request ACS Resend (self-check to server); `97` is Request SC Resend. Reversed,
  every self-check unit drops its connection.
- **COUNTER.** Release 5.1 restructured `Attribute_Performance` and removed
  `Section_Type`. A 5.0-shaped parser fed a 5.1 report finds zero metrics and
  silently produces cost-per-use figures a library puts in a budget submission.
- **KBART.** One spec cited "RP-2014-001", which does not exist. The standard is
  NISO RP-9-2014 (Phase II).
- **Bath Profile.** No spec mentioned it. A Z39.50 server that answers only the
  attribute combinations its authors imagined is unusable by OCLC Connexion,
  Koha and VuFind — and unverifiable in a public tender.

Every one of those corrections is carried in the master document. They are the
argument for why it is worth reading before writing code in this area, and the
reason the standards matrix cites version numbers rather than bare names.

## What this document is not

It is not a specification anyone has agreed to implement verbatim, and it is not
a substitute for reading the code. Where the two disagree, **the code is what
runs** — but a divergence is a fact worth recording here rather than leaving for
the next person to rediscover. Phases amend it as they land.

## Divergences recorded as phases land

**Phase 5 — metrics registry + queue consolidation.** Two sub-items of the
master document's phase-5 line describe a repository that does not exist yet,
and were deliberately not implemented:

- _"the merged **six-queue** list wired into worker.ts"_ — the six queues named
  in §1 (`notices`, `catalog`, `search`, `report`, `acquisitions`, `webhook`)
  arrive with the milestones that produce them; the notices queue is phase 22.
  What exists today is five (`email-outbox`, `scheduled`, `import`,
  `maintenance`, `export`), and registering six consumers for queues nothing
  produces would pin `/readyz` at 503 permanently, because readiness is now
  strictly "every registered consumer is running". The consolidation — one list,
  four surfaces derived from it — is what phase 5 owed and shipped;
  `apps/api/src/queues/consumers.ts` is where the sixth is added.
- _"`EMITTERS` widened to `apps/protocol-gateway/src` and a Rust declaration
  file"_ — neither exists (`ls apps` is api, desktop, site, web; there is no
  `Cargo.toml` in the repository). Adding those roots would read as coverage and
  cover nothing, which is the failure mode `check:alerts` exists to prevent.
  `SOURCES` in `scripts/check-alerts.ts` is the one place to widen when the
  gateway lands, and a declaration whose `source` has no entry there fails the
  build.

Phase 5 also shipped more than the line asked for, because the both-directions
check found it: five alert rules for metrics that were emitted and unalerted, a
`libriant-web` scrape job for two gauges that had been rendered and collected by
nobody since the app was first deployed, and the wiring for
`renderScheduledJobMetrics` — exported, unit-tested and documented as being
called by `worker.ts`, which never called it.

**Phase 6 — the port boundary + public-API registry skeleton.** The master
document's line is delivered as written: `DataPort` / `PlatformPort` /
`PrintPort` in `@libriant/shared/ports`, `HttpDataPort` and its two siblings in
`apps/web/lib/ports/`, `apps/api/src/public-api/registry.ts` with
`defineEndpoint`, the `class-validator` → JSON Schema deriver, and `check:openapi`
as the sixteenth gate against an empty registry. Four things are worth recording.

- **The ESLint rule is wider than "no `fetch(` in a screen", and ships with no
  exemptions.** It also refuses a hard-coded `/lbr-api` literal, `window.open`,
  `navigator.clipboard`, `navigator.onLine` and the browser online/offline
  events, because those are the same defect — a screen naming a host it will not
  have on the Tauri client. Seventeen call sites were converted in the same
  commit so the rule turns on at `error` with zero `eslint-disable` comments; a
  rule that needs exemptions on day one is a rule nobody believes. This is NOT
  the "extract the 1.0 screens" work the master document declines: every
  conversion is a one-line substitution in a screen that phase 20 replaces.
  Route handlers under `apps/web/app/api/` are excluded — they are servers that
  happen to live under `app/`.
- **`DataPort.upload` does not take a `FormData`.** `FormData` is an HTTP
  encoding; a native host writing to a local replica has a filename and bytes.
  It takes `{ file: { name, type, data }, fields? }` and `HttpDataPort` builds
  the multipart body. Note that `packages/shared`'s tsconfig does NOT enforce
  this — `@types/node` declares `FormData` globally, so `tsc` accepts the DOM
  type there. It is a rule the reviewer keeps.
- **The deriver cannot resolve `@ValidateNested` on its own**, so contract 4.9's
  "JSON Schema derives from `class-validator`'s own `getMetadataStorage()`" is
  true with one exception. The nested class comes from `@Type(() => X)`, which is
  class-transformer metadata reachable only through the unexported deep path
  `class-transformer/cjs/storage`. Rather than reach into a package's private
  build, the deriver requires the class to be named at the endpoint and throws
  without it. It throws on an unmapped validator for the same reason: a
  published contract that understates what the server enforces is the failure
  the gate exists to prevent.
- **`check:openapi` must run as `tsx --tsconfig apps/api/tsconfig.json`**, with
  `import 'reflect-metadata'` first. There is no `tsconfig.json` at the
  repository root, so a plain `tsx` transpiles the DTOs with TC39 standard
  decorators and they throw at class-definition time with `TypeError: Cannot
read properties of undefined (reading 'constructor')` inside class-validator
  — which reads like a library bug and is a transpiler-configuration bug. This
  is the first gate that imports decorated classes; `check:permissions` and
  `check:alerts` import plain modules and never hit it. The gate asserts both
  conditions rather than trusting them, and declares no decorated classes of its
  own, because `tsx` applies that tsconfig only to files its `include` covers.

With no public endpoints until M6, the document comparison alone would be nearly
vacuous — the phase-5 lesson. So the gate also proves the derived schema AGREES
with `validateDto()` on fixture DTOs: every property the schema calls required
is genuinely rejected when omitted, every optional one genuinely accepted, and
an unknown key genuinely refused, which is what licenses
`additionalProperties: false`. That check found two real defects in the deriver
before it shipped — `@ValidateIf` being read as `@IsOptional` (both record
`conditionalValidation`; only the latter carries `name: 'isOptional'`), and a
truthiness test that made `@Equals(false)` throw.

**Phase 7 — `packages/marc`, the codec.** Delivered: the record model, the
ISO 2709 reader and writer with the asymmetric leader rule, MARCXML both ways,
MARC-in-JSON both ways, the MARC-8 codec, the path grammar, `applyOps` with
`undo`, `diff`, and the canonical hash — all of it with `types: []` in the
package's tsconfig, so `Buffer`, `process` and every `node:` specifier are
compile errors rather than review findings. Seven things diverge from the
phase-7 line and each one is a decision rather than an omission.

- **The plan's leader regex cannot match a leader.** `^.{10}22.{9}4500$` is
  25 characters wide (10 + 2 + 9 + 4) for a 24-byte leader; positions 12-19 are
  eight characters, not nine. Corrected to `^.{10}22.{8}4500$` in the test rather
  than worked around, because the natural response to a correct writer failing
  every record is to weaken the assertion — and a weakened one stops catching a
  genuinely wrong /10-11 or /20-23.

- **The ≥98 % byte-exact figure over 5,000 real records is replaced, not
  reported.** There are no real MARC records in this repository and none were
  obtainable. The corpus is generated by a byte-level emitter in
  `src/__fixtures__/corpus.ts` that shares no code with the serializer — two
  independent implementations of ISO 2709 agreeing is real evidence, the same
  kind `check:greek-folding` already relies on. But a percentage over a corpus
  the same session authored is tunable to any number by editing one probability,
  so what is asserted instead is strictly stronger: **field-for-field
  idempotence on all 5,000 records including the malformed ones; byte identity
  on 100 % of conforming records with zero tolerance; and every non-conforming
  record asserting the specific reason it cannot be reproduced.** Measured: only
  leader positions 0-4, 12-16 and 20-23 — the ones the writer is required to
  recompute or fix — ever change. A later session with real ABEKT, Koha, Aleph
  and Evergreen exports should keep all three assertions and add the corpus.

- **MARC-8 ships two graphic sets, not five.** The plan's cut list promises
  Latin, Greek, Cyrillic, Hebrew and Arabic with only EACC stubbed. Committed
  here: Basic Latin and Extended Latin (ANSEL) — the two DEFAULT designations,
  reached with no escape sequence, which is every Latin-script record with a
  diacritic in it. LC's `codetables.xml` is not in the repository and was not
  reachable; hand-typing a Greek, Cyrillic, Hebrew or Arabic table would put an
  uncheckable transcription into the one product sold to Greek libraries, where
  one wrong row is a name catalogued under a letter it does not contain, found by
  a librarian rather than by a test. An unsupported set instead raises
  `marc8-unsupported-charset`, substitutes U+FFFD so the damage is VISIBLE, and
  leaves the bytes in `source_blob` — recoverable, which a wrong mapping is not.
  `pnpm marc8:tables` closes this the moment somebody puts LC's file at
  `vendor/marc/codetables.xml`; until then `--check` skips with a printed reason.

  The consequence for the named acceptance vector: **the Greek-245-then-Latin-260
  test runs with ANSEL designated into G0 instead of Basic Greek.** It exercises
  the identical mechanism — a non-default designation in one field that must not
  leak into the next — and it fails if the reset is removed. It is not the Greek
  vector, and it does not pretend to be.

  Four table-free checks stand in for "round-trips LC's codetable vectors", each
  ruling out a class of transcription error: every combining byte maps to
  something Unicode itself calls a mark (and nothing else does); every byte
  decodes and re-encodes to itself; every combining target is inert under NFC and
  NFD; and the two sets occupy disjoint byte ranges. The second of those found a
  real encoder bug before it shipped — ANSEL carries `Ơ` as one byte, but `Ơ`
  decomposes under NFD to a horn ANSEL has no byte for, so an encoder that
  decomposed up front refused a character its own table contained.

- **`$6` renumbering is a policy, and the default is not the plan's wording.**
  The plan asks that inserting a paired field "renumbers every `$6` on both
  sides". LC is explicit that the occurrence number exists "to permit the
  matching of the associated fields (not to sequence the fields within the
  record)" and is "assigned at random", so renumbering is legal and gratuitous —
  and on a real imported record, whose numbers arrive sparse, a compacting pass
  rewrites `$6` on the very first save, floods the diff and breaks the byte
  round-trip this same phase is measured on. Two policies ship: `repair` (the
  default: allocate the lowest free number, break collisions, never touch a
  correct link, never allocate or overwrite `00`) and `compact`, which is the
  plan's literal behaviour and has the plan's literal test. The criterion that
  should replace the line is the invariant both maintain: after any batch every
  `$6` pairs bijectively, no number is used twice, and `00` is untouched.

- **`applyOps` resolves every path against the ORIGINAL record, and a BATCH is
  not invertible.** The first half is the plan's intent: the obvious sequential
  implementation passes every single-op test and edits the wrong field in a batch
  that deletes `650[0]` and edits `650[1]`.

  The second half is a correction to this phase's own first draft, and fuzzing
  found it. `insertField.at`, `deleteField.at` and `moveField`'s indices are
  POSITIONS resolved against the record the batch was handed, so a batch that
  both inserts and deletes has no position-preserving inverse: a reverse-and-
  invert restored 3,023 of 3,804 generated multi-op batches and **silently
  corrupted the rest**. There is therefore no `invertAll` and no `undo` — undoing
  a batch is a snapshot restore, which is what the architecture already specifies
  and for exactly this reason ("restore version N is a copy rather than a replay
  and cannot be subtly wrong the way a chain can"). `invert(op)` remains exact
  for a single op, property-tested over 20,000 generated cases with zero
  failures, which is what the AI-suggestion review UI and a one-edit undo need.

  The same fuzz showed `moveField` did not invert even alone, because it was
  defined as "place before whatever is at `to`". It is now splice semantics —
  remove, then insert at `to` in the list that remains — which is the definition
  under which `{from, to}` is undone by `{from: to, to: from}`.

- **An op path must index every repeatable level** — `008[0]/07-10`, never
  `008/07-10`. The codec has no format definition (that is phase 8), so it cannot
  know which tags repeat, and a path whose meaning depends on a MARCspec default
  means something else in somebody else's tool.

- **Phase 7 is purely additive.** `apps/api/src/import` is untouched, and the
  reading that the 1.0 import path is "replaced at phase 20" is wrong: phase 20
  deletes `{catalog,loans,reservations,fines,members}` and does not mention
  `import/`, and phase 35 layers the migration adapters onto those same parsers.
  Beyond the three defects the plan names, the 1.0 reader has three more that
  this codec fixes by construction — the binary path ignores the encoding option
  entirely while the import wizard offers "Windows-1253 (Greek)"; `trim()` takes
  a 40-character 008 down to 38 and shifts every position after it; and
  `parseInt` accepts a sign, so a directory entry of `-0012` indexes from the END
  of the record and serves one field's bytes under another field's tag.

Four defects in this phase's own first draft are worth recording, because a
check or a fuzz found each of them rather than a reviewer — which is the whole
argument for writing the property assertions before believing the code.

- `new TextDecoder('latin1')` is **windows-1252** on every platform (measured:
  `.encoding === 'windows-1252'`, byte 0x80 decodes to U+20AC), so the
  structural decoder is now an explicit byte-to-code-point loop.
- The MARC-8 escape reader consumed `ESC ) ! E` as a set named `"!"`, leaving the
  real final byte to appear as a literal `E` in the middle of the field.
- The MARC-8 encoder normalized to NFC up front, and NFC canonically REORDERS
  marks of different combining class — so a record with a dot below and a cedilla
  came back with the two swapped, and `write(read(b)) === b` was false for a
  record nobody edited. Composition is now attempted per cluster, where it can
  only help (ANSEL has `Ơ` and no combining horn), and the pieces are emitted as
  written. Found by fuzzing decode→encode over 60,000 random byte strings: 22 of
  4,622 clean decodes came back reordered; it is now 0, with every encodable
  input byte-identical.
- The bijectivity check on the ANSEL table found the encoder refusing `Ơ`
  outright, because it decomposed everything first and ANSEL has no combining
  horn to rebuild it from.

Two fuzz harnesses are worth re-running when this code changes and are not
committed as tests because they take minutes rather than seconds: 20,000
byte-mutated records through read-then-write (zero non-`MarcError` exceptions in
either direction, which is the module's stated contract), and 20,000 generated
single ops through apply-then-invert (zero failures).

**Phase 7, review round.** A five-dimension adversarial review of the committed
codec raised 33 candidate findings; 28 survived independent verification and all
28 are fixed. They are worth listing because most are the same shape — a
promise the module header made that the code did not keep — and because two of
them corrupted data silently:

- **A subfield delimiter inside a VALUE was emitted raw**, and the reader then
  split one subfield into two, with no anomaly on either side. The MARC-8 branch
  already refused those bytes; the default UTF-8 branch was the only path that
  corrupted, so an exported record was not re-importable to itself and its
  content hash changed without an edit. All three separator bytes are now
  refused on write with `data-not-encodable`.
- **`normalizeLinkage('repair')` broke `$6` pairs apart** — and it runs on every
  `applyOps`. Given four fields sharing an occurrence number (two genuine pairs)
  it reallocated field-wise, keeping one member of each pair and renumbering the
  others: two correct pairs became four dangling links, which is the precise
  invariant its own docstring claims to maintain. Reallocation is now per
  partner set, and both policies end at the same invariant.
- **`setTag` wrote the new tag during the resolve pass**, so every later op in
  the same batch addressed a renumbered record — breaking the one rule a batch
  has. It is now staged like deletes and moves, and it addresses a field by
  INDEX rather than by path, because a path names a field by tag and could not
  invert once the tag changed.
- **`diff` reported "identical" for a record whose subfields were reordered**,
  directly contradicting `contentHash`. Subfields are now aligned by content
  with the same LCS the fields use, and a reorder is a `moved`.
- **`readMarcXml` kept numeric character references as literal text**, so a
  record from any of the many exporters that escape non-ASCII imported with
  `&#x0391;` in its title. `htmlEntities: true`.
- **The collection writer re-indented by splitting each record on newlines**,
  injecting the indent into the middle of any value that contained one — a 505
  contents note, which is where they live. Indentation now happens at
  generation.
- **`Ơ`'s lowercase `ơ` and `Ư`'s `ư` were missing from ANSEL**, so every
  Vietnamese lowercase horn was unencodable. A new table check closes the class
  rather than the two rows: an uppercase Latin letter must have its lowercase in
  one of the two tables. And precomposed horn letters (`Ớ`, `ờ`, `Ự`, `ữ`) were
  refused outright, because ANSEL has `Ơ` but no combining horn — the encoder
  now composes the base with each following mark in turn, preserving the
  original mark order, which a first attempt did not and which cost one
  instability in 2,657 round-trips.

Also fixed: a non-Latin-1 tag escaping as a bare `RangeError`; a leader
overstating its length swallowing the following record (settled by cross-checking
against the record's own directory); a truncated escape leaking its intermediate
byte into the field text; `compact` leaving a collision intact; a bare `Error`
from `allocateOccurrence`; `writeRange`/`readRange` disagreeing about padding so
a fixed-field edit could not be undone; a character range past the end of a
variable-length subfield being padded into existence instead of refused;
`fromMarcJson` stringifying an object into a title and accepting a leader of any
length; a `$6` repointed at a different tag classified as housekeeping; a
one-subfield field that could never be classified `normalization-only`; and the
move detection discarding its result whenever the moved field was also edited.

Four of the review's findings were about the TESTS rather than the code, and are
the ones most worth repeating elsewhere: four assertions were unconditionally
true; the MARC-8 "property test over 60,000 random byte strings" drew from a
generator periodic in its inner index and asserted on 76 distinct inputs, none
longer than six bytes; and nothing asserted the suite's own size, although the
package's `test` script is a glob and `node --test` exits 0 when a glob matches
nothing. A `pretest` script now fails below five test files — from outside the
glob's blind spot, which is the only place such a check can work.

After the round: 111 package tests, and three fuzz harnesses re-run — 20,000
byte-mutated records through read-then-write with zero non-`MarcError`
exceptions, 200,000 random byte strings through MARC-8 decode-then-encode with
11,222 encodable and **100 % byte-identical**, and 20,000 generated single ops
through apply-then-invert with zero failures.
