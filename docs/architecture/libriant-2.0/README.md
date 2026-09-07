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

**Phase 8 — format definitions and the validator.** Delivered: the Avram-shaped
definition model, the layered loader, the validator, `validateDelta`, rule packs
and templates as data, `check:marc-schema` as the seventeenth gate, and
`scripts/gen-marc-schema.ts`. What diverges is almost all about the same thing —
phase 8's central input is exactly as absent as phase 7's `codetables.xml` — and
the shape of the answer is different, because the failure mode is different.

- **A validator's failure is a FALSE ACCUSATION, so its refusal is silence.**
  Phase 7 made damage loud (U+FFFD plus a typed anomaly) because a wrong MARC-8
  mapping corrupts data silently. A wrong validation rule does the opposite: it
  accuses a correct record, and a librarian who cannot save because of it
  switches validation off — after which it protects nothing. That is the failure
  the architecture already names at line 163. So every unverified rule here is
  SILENT, and three mechanisms make that safe rather than useless:

  **Open world.** A tag, subfield code or indicator the definition does not
  mention produces no issue at all. MARC 21 reserves 9XX and every X9X for local
  use and LC's own distributed records carry 906, 925, 955; a closed-world
  validator flags a library's own fields on every save. It also makes a partial
  definition safe — an undescribed field is unconstrained rather than wrong.

  **A confidence cap.** The shipped definition declares
  `coverage.confidence: "transcribed"`, and the validator caps every rule it
  reads out of that file — repeatability, indicator lists, subfield lists,
  obsolescence, field length — at WARNING. Only STRUCTURAL rules, which come from
  the format rather than from a row somebody typed (an indicator is two
  characters; a control field has no subfields), are errors. So a mistranscribed
  row costs a spurious warning and can never refuse a save. Running
  `scripts/gen-marc-schema.ts` against a vendored authority is what flips it to
  `"generated"` and turns the same rules into errors — that one word is the whole
  of what this phase owes a later session.

  **A coverage channel.** "No issues" from a definition describing 41 tags is a
  lie of omission and would make this phase worse than nothing, so `validate`
  returns `uncheckedTags` beside the issues, and a caller that shows a green tick
  without showing them is misreporting.

- **One definition ships, not five.** MARC 21 bibliographic, 41 fields,
  hand-transcribed. MARC 21 authority and holdings and UNIMARC bibliographic and
  authorities are **declared and refused** — `shippedSchema('unimarc/bibliographic')`
  throws naming the profile and the reason, rather than returning an empty
  definition that would validate every record clean. UNIMARC is the exact
  analogue of phase 7's Greek MARC-8 table: it is what ABEKT exports and
  therefore what the Greek market runs on, which is precisely why it must come
  from IFLA rather than from memory.

  Absent from the definition on purpose and recorded in its own `coverage.limits`:
  the material-specific 008/18-34 and 006/01-17 blocks (seven layouts
  discriminated by Leader/06 and /07), all fifteen 007 layouts, and 880 — whose
  indicators MIRROR the field it links to, so giving it a list of its own would
  be wrong for every record that has one.

- **"Zero false positives on LC-published-valid records" is replaced.** There are
  no LC records here. What `check:marc-schema` asserts instead is that the
  definition raises **zero errors on all 5,000 records of the phase-7 corpus** —
  which is not a substitute for real records but is not circular either: that
  corpus was written to test byte-level round-tripping, its tags were chosen to
  exercise a serializer, and it predates this definition. A deliberate break
  proved the check bites: marking 650 non-repeatable produced 2,544 errors.

- **`validateDelta` subtracts a MULTISET keyed on `(rule, tag, code, position,
subject)` — and on nothing else.** `subject` is the machine-readable thing the
  rule objects to (the indicator value, the offending code). Deliberately
  excluded: the occurrence ordinal, because deleting the second of five 650s
  renumbers the rest and every pre-existing issue on them would look new; the
  field's content, because a cataloguer fixing a typo in `245 $a` must not be
  blocked by a pre-existing illegal indicator on that same 245; the message text,
  because rewording it in a later release must not turn every stored record's
  issues into new ones; and the severity, because promoting a warning is a policy
  change and not an edit.

  One hole is left open and stated rather than closed: an edit that fixes one
  fault and introduces another with the SAME identity nets to zero and does not
  block. It errs toward letting the librarian save, which is the direction this
  whole design errs in.

- **The issue limit applies to the RESULT, never to either side of a delta.**
  Limiting each side first is the obvious implementation and it is wrong in the
  one direction that matters: a `before` truncated at the limit drops pre-existing
  faults from the subtraction, so they reappear as INTRODUCED and block a save the
  edit had nothing to do with — on exactly the ruined record where the amnesty
  matters most.

- **`ValidationMode` is named here, not in phase 10.** `'block'` is the default
  and the only one a cataloguer's save uses; `'record'` writes the issues and
  flags the record instead of refusing it, which is what the phase-19/20 cutover,
  phase 35's migration adapters, phase 30's overlay and phase 37's batch undo all
  need — none of them may be stopped by a fault that was already in the data.

- **The key names are a reconstruction and say so.** Neither the Avram
  specification nor its companion JSON Schema is in this repository. `fields`,
  `label`, `repeatable`, `indicator1`, `subfields`, `positions`, `codes`,
  `deprecated` are from memory of the language; the shape is right and individual
  spellings may not be. Nothing depends on them being Avram's — it is our own
  file format, read only by our loader — and `coverage.source` records which it
  is. The one place a spelling could have bitten is handled defensively: a blank
  indicator is accepted as `" "`, `"#"` or `"_"`, because reading only one
  spelling would reject every blank indicator in a file that used another, and a
  blank is the most common indicator value in MARC.

Two shape gaps are recorded so a later session does not have to rediscover them.
`AvramField.positions` needs to become a discriminated set of layouts with the
selector expressed as DATA (`{select: ['LDR/06','LDR/07'], layouts: {...}}`) before
the 008/006/007 blocks can land; and phase 28's positional editor will additionally
want a `default` per position and an ORDERED strength list for Leader/17, neither
of which the current shape has.

Three defects in the committed phase-7 codec were found while building this and
are fixed here: `readMarcXml` silently truncated an over-long indicator attribute
with no anomaly, `fromMarcJson` did the same without refusing, and the new
`indicator-truncated` anomaly names both. A stored over-long indicator is
otherwise invisible — every serializer emits two characters while the content
hash remembers three.

**Phase 8, review round.** The completeness critic returned after the phase was
committed and confirmed the shape — open world, the confidence cap, the coverage
channel and the issue identity all stand unchanged — while landing five findings
worth the follow-up commit. Two were real defects:

- **Five name-subject fields carried 650's subfield list verbatim.** So an
  ordinary `600` with `$d 1883-1957` and `$t Zorba`, and a `700` with a
  relationship `$i`, raised three warnings on a perfectly correct record —
  measured before the fix. The cause is that a subfield list is a CLOSED-WORLD
  claim: `subfield-not-allowed` fires only when `def.subfields` exists. So the
  list is now given only where it can be stated completely (010, 020, 022, 040,
  245, 250, 300, 440, 500) and omitted everywhere else, which asserts nothing
  rather than something wrong.

- **`check:marc-schema`'s headline assertion was nearly vacuous.** It required
  zero ERRORS across the corpus — but with `confidence: "transcribed"` no table
  rule CAN produce an error, so the check could not have caught a wrong indicator
  list or a wrong repeatability row. It now requires zero ISSUES of any severity,
  which passes today and therefore cost nothing to tighten. Proved by deleting
  the LCSH value from 650's indicator-2 list: 5,000 hits, where the old assertion
  would have stayed green.

And three design corrections:

- **Rule packs COMPOSE; they do not partition Leader/18.** RDA and ISBD are
  orthogonal — a record coded `i` is both "described under RDA" and "ISBD
  punctuation included" — so `packsFor` returns a list and the gate no longer
  requires the packs to be disjoint. What it checks instead is that every value a
  pack selects on is a Leader/18 code the definition lists, so a pack cannot key
  on a byte that could never appear.

- **Confidence is per-LAYER, not per-schema.** A pack's rules were hand-authored
  here, and inheriting the base definition's confidence meant that the day
  somebody vendors an authority and the base is promoted to `generated`, three
  hand-written RDA rules would start refusing saves. `AvramField.confidence` caps
  a field independently, and the effective severity is the weaker of the two.

- `ValidationResult` was dead code contradicting the design beside it, and
  phase 7's `marc8-tables.ts` header said "two of the ten graphic sets" where the
  codec names twelve. Both fixed.

Left open deliberately, and recorded so the next session does not rediscover it:
a persisted issue set must carry the definition's identity (profile, digest,
confidence) so a definition change is treated as "recompute" rather than
"trust" — that belongs with phase 10's storage, not here. And the validator has
no compiled sidecar yet: at a 5M-record catalogue the per-call work of
normalising indicator code sets and parsing position ranges should be done once
at `loadSchema` rather than per record.

---

## Phase 9 — the 2.0 baseline migration

Delivered as **9a**: the mechanism complete, the tables partial, and the
partiality machine-checked. That is the phase-7/8 precedent — the codec and the
validator shipped whole while the DATA (MARC-8 tables, the Avram definition)
shipped partial and refused rather than faked — and it applies here for a
measured reason.

**The scope, in numbers.** §3 names about 180 tenant tables. The phase-9 line
enumerates 50 of them, and §6 asserts 12 more are "the baseline tables" (phase 14
says "service layer over the baseline tables: categories, patrons, cards,
identifiers, addresses…"), so the honest figure is 62. Of those 62, **ten have a
full `CREATE TABLE` block anywhere in the document**. Eighteen appear _exactly
once_ in 900 lines — the §3 list entry and nowhere else — and `calendar_exceptions`
is one of them, while the phase's own acceptance criterion demands behaviour from
it ("overlapping calendar exceptions raise `23P01`") without ever saying what its
columns are.

Writing 52 tables of invented columns into a SQUASHED BASELINE is the expensive
direction of the asymmetry this program runs on: a later migration that adds a
table is cheap, and a wrong column type is a data migration on a live catalogue.
So 9a builds the ten specified tables, five skeletons forced by their foreign
keys, `audit_log`, and one support table — seventeen — and
`prisma/schema-v2/BASELINE-SCOPE.json` names all 219 tables §3 mentions with a
status each. `check:schema-conventions` fails if a model has no entry, if an
entry claims a table that does not exist, or if either drifts. "We did not build
these" is a fact CI enforces, not an omission a reviewer has to notice.

9b (circulation spine) is authored with phases 12–13, 9c (patron record and item
satellites) with 14–15, 9d (the fee ledger and notices) with 18 and 22 — in each
case with the phase whose design decides the columns. Nothing about "one squashed
migration" is lost: `prisma migrate deploy` applies a FOLDER, and a fresh tenant
still reaches 2.0 in one deploy.

### Four measurements that changed the design

**1. `prisma migrate deploy` does NOT wrap a migration file in a transaction.**
Eight migration files, `scripts/_lib/online-track.ts`,
`scripts/check-migration-safety.ts` and `verify.yml` all said it does. Measured
on Prisma 7.9.1 / Postgres 16.15: a file containing `CREATE TABLE probe_tx_two
(…); SELECT 1/0;` fails with `P3018`, **the table survives**, and a
`finished_at IS NULL` row is left in `_prisma_migrations` that blocks every later
deploy on that tenant until somebody runs `migrate resolve` by hand. An explicit
`BEGIN;`/`COMMIT;` restores atomicity exactly — proved both ways against this
baseline: with the wrapper a deliberately broken copy leaves **0** tables, without
it **44**.

The rule that follows (no `CONCURRENTLY` in the transactional track) is unchanged,
but its reason is now stated correctly: a transactional migration is atomic
because it opens its own transaction. The four APPLIED migrations that state the
old reason are left exactly as written — Prisma checksums a migration and editing
an applied one breaks every database that has run it, which is why this repository
fixes a bad migration with a NEW migration. `sql-scan.ts` records why they stay
wrong.

**2. "A second schema" is literal, and it is what makes the phase possible at
all.** Nine physical table names collide with 1.0, including `loans` — which
cannot be deferred, because phase 16 builds the 2.0 circulation engine on it and
phase 16 precedes the cutover. Two Prisma schema folders solve the _modelling_
collision (`P1012`) and not the Postgres one: `CREATE TABLE loans` still fails
with `42P07`. A second Postgres schema solves both. Measured: `migrate deploy`
against `…?schema=lbr2` creates the schema, keeps `_prisma_migrations` **inside**
it (so the two ledgers are independent rather than shared), and `public.loans`
(14 columns) coexists with `lbr2.loans` (41). `public.audit_log` stays a heap
while `lbr2.audit_log` is partitioned. Phase 20's cutover is then
`ALTER SCHEMA public RENAME TO v1_archive; ALTER SCHEMA lbr2 RENAME TO public;`
— the exact shape §10 already specifies for the rollback, measured to leave every
constraint working.

**3. "A non-IANA timezone is rejected" cannot be a CHECK.** A subquery is refused
outright (`0A000`). An `IMMUTABLE` wrapper over `pg_timezone_names` works and
costs **11.1 ms per row** — 111 seconds for 10,000 inserts against 4.6 ms with no
constraint — because that function walks the tzdata tree on every call, and
marking a wrapper over it IMMUTABLE is false anyway. A foreign key to a seeded
`iana_timezones` costs **8.2 µs**, about 1,350× less, and raises `23503`. Seeded
`MINUS ('Factory','posixrules')`: those are the only two names Postgres knows that
`Intl.DateTimeFormat` refuses (the other 179 it does not list are backward links
it canonicalises), so the table is a strict subset of what the app layer can
format with — and `posixrules` is the single row on which the two Postgres 16.15
builds on this machine disagree, so excluding it makes a seeded tenant identical
on both (597 rows). `+02:00` is refused too, deliberately: a fixed offset has no
DST, which is `circ-5` in a new costume. The check must be in the DATABASE because
phase 19's copy-forward is PL/pgSQL and writes `branches` without going through
TypeScript at all.

**4. `default_toast_compression = lz4` is not an assertable property.** With
database-level lz4 in force, a session that does `SET
default_toast_compression='pglz'` writes a pglz row and `attcompression` stays
empty. So the GUC is set (it is the right default for everything added later) AND
six named TOAST-bearing columns get an explicit `SET COMPRESSION lz4`, which is
durable and is what the census asserts. Note for phase 19: `SET COMPRESSION` does
not rewrite existing rows, so it must be in place before the bulk copy-forward.

### Two additions to §3, both deliberate

**`change_events.commit_xmin`.** §4.2 specifies the read watermark as
`row_version < pg_snapshot_xmin(pg_current_snapshot())`. That does not run —
measured, the function returns `xid8` and `row_version` is `bigint`, so Postgres
refuses with `operator does not exist: bigint < xid8` — and casting would make it
run while still being wrong, since a sequence value and a transaction id are
unrelated counters. The job is real: `seq` is assigned at INSERT and becomes
visible at COMMIT, so a reader that has seen seq=100 can have a transaction
holding seq=99 open beside it, and recording 100 loses 99 forever. A real `xid8`
column defaulted to `pg_current_xact_id()` fixes it, and it is added NOW because
`change_events` is append-only: adding it in phase 16 means backfilling rows whose
commit order is no longer knowable.

**`iana_timezones`.** Not a §3 table; it exists so the timezone check can be a
foreign key. See measurement 3.

### What was chosen rather than derived, and where the reasoning lives

Seven of the twelve enum types §2/§3 use by name have **no value list anywhere in
the document** — `audit_actor_kind`, `branch_kind`, `item_status`,
`event_source`, `fee_status`, `marc_source_format`, `marc_change_kind`. Each is
chosen in `01-enums.prisma` with its reasoning, and each is deliberately MINIMAL,
because adding a label later is a catalogue write while reordering one silently
changes every `ORDER BY` on that column. Enum label order is in the census fixture
for the same reason.

`branches_guard_cycle()` gets one comment line in §3. Three things it does not say
are decided in the migration prose: it raises `23514` (already handled as a
constraint violation everywhere in this codebase, so a cycle surfaces to a
librarian as a refused save rather than a 500); it DOES recompute descendants when
a parent moves — the case an implementer skips, asserted with a three-level tree;
and depth is maintained on every write while the descendant recompute fires only
on an actual change of parent.

`branches.address_*` is a glob in §3, not SQL. It became the five columns the
existing library-profile feature already collects at signup, rather than a third
address shape for the same data. `branches.calendar_id` is left un-FK'd: it is the
only id column in that block written without a `REFERENCES` clause, `calendars` is
9b, and `ADD CONSTRAINT` later is the cheap direction.

`holdings_records`' primary key is `record_id`, not `id` — a deviation from the
§3 convention that is FORCED by the items DDL (`REFERENCES holdings_records(record_id)`),
which is the one thing the document states about that table.
`check:schema-conventions` exempts it by name with that reason rather than
weakening the rule.

### Dropped from phase 9

**`bookings`.** The phase-9 line names it; §6 phase 97 (M12) says "Events, spaces,
equipment, **bookings with the EXCLUDE constraints**, waitlists, iCal". §3 gives it
no `CREATE TABLE` — only an `ALTER` adding the exclusion, referencing a `spaces`
table that is not in phase 9's scope and an unnamed range column. Every column
would be invented and phase 97 would rewrite them. The `btree_gist` justification
survives without it, and the mechanism is proved instead: the integration test
builds a scalar-plus-range `EXCLUDE` in `lbr2` against `btree_gist` installed in
`public` and asserts the real `23P01`.

**`schemaMajor = 2`.** The critic's plan set it; this does not. It records which
generation a database IS, and after this migration a tenant is still a 1.0
database with an empty 2.0 schema beside it. `tenant-migrate --plan` and the
control-plane cache key off that flag, so setting it now would tell every tool the
cutover had happened. Phase 20 sets it, in the transaction that performs one.

### The gates, and what each must survive

`check:schema-conventions` (18) reads the DDL the datamodel RENDERS TO, never
Prisma field names — a gate reading field names would pass a schema with no `@map`
at all. It needs no database (the render is done against a closed port). Seven
break tests were run and all fire: a dropped `@map`; a bare `DateTime` rendering as
`TIMESTAMP` without zone; a `BigInt` amount become `Int`; a model with no manifest
entry (and the reverse); a non-singleton integer id; an exemption that matches
nothing; and **an empty schema folder, which must FAIL rather than pass** —
`migrate diff --from-empty` on an empty folder exits 0 with an empty script, which
is the exact shape of the vacuous gate the last three phases each shipped once.

`check:changelog-coverage` (19) compares the `@replicated` markers against the
COMMITTED migration SQL in both directions, and never against the generator's
output — regenerating the triggers and comparing them to the markers they were
generated from is comparing a function to its own input and cannot fail. The
load-bearing break test is exactly that: one `CREATE TRIGGER` hand-deleted from
the migration WITHOUT re-running the generator, which fails. So do a removed
marker with its trigger left behind, a changed `@@map`, a trigger reading the wrong
primary key, and the truly vacuous state where markers and triggers are both gone.

Both gates also caught a live one: `check:migration-safety` was not scanning
`prisma/migrations-v2` at all, so the largest migration in the repository was
ungated. Its folder list is now explicit and it refuses to report success having
scanned zero migrations.

### Left open, deliberately

`marc_record_contents` has no changelog trigger: it is 1:1 with `marc_records` and
every content write bumps the parent in the same transaction, so one event per edit
is right. If phase 10's `write()` ever writes content without touching the parent,
that reasoning fails and the marker must move. `fees` has none either, for a churn
reason recorded on the model — the nightly accrual sweep would make it the largest
producer in the feed, and no consumer reads it yet.

`change_events.payload` is `to_jsonb(NEW)`, a whole-row projection, and is
deliberately temporary: §4.3 gives phase 11 one projection function serving the
indexer, the OPAC page, the OAI rendition and the report builder, and this is
replaced by a call to it.

The changelog trigger attributes an actor from `current_setting('libriant.actor_kind')`
and falls back to `system`. Nothing sets those yet — the request-scoped middleware
that does is phase 10 — so every event in a phase-9 database is `system`, which is
true rather than convenient.

---

## Phase 10a — the MARC store: the write path

Delivered as **10a**: the write path, versions, diff and restore, complete.
**10b** — `marc_record_locks` and the acquire/heartbeat/expiry/take-over
lifecycle — is deferred, and the manifest says so rather than a comment: its
`BASELINE-SCOPE.json` entry moved from a milestone bucket (`"11-50"`, which is
what made it invisible to phase-10 planning in the first place) to `"10b"` with
the real reason.

The seam is not arbitrary. Four of the five acceptance clauses are write-path
and exactly one is locks; and a record lock is a different mechanism at a
different timescale — a human's intent to hold a record open for ten minutes —
which **must never gate `write()`**, because an import, an overlay, a merge and
a batch job all have to be able to write a record a cataloguer has open. §3
names the table in one list and specifies no column of it anywhere in 1,054
lines, so its whole shape is forced by the acceptance criterion, and it is
designed with the four operations that give those columns meaning.

### Two bugs in phase 9, both of which its own tests could not see

**The changelog trigger could not fire from an application connection.** A
trigger body is re-resolved at RUNTIME under the CALLING session's
`search_path`, and phase 9's function had THREE unqualified names. Every test
phase 9 wrote happened to supply a path — the smoke modules do
`SET search_path = lbr2, public`, the census spec only reads `pg_catalog` — so
from any ordinary connection the FIRST write to any replicated table failed:

    ERROR:  relation "change_events" does not exist
    CONTEXT: PL/pgSQL function lbr2.lbr2_write_change_event() line 44

`marc_records` therefore could not be written at all, which is why this is
phase 10a's first commit rather than a 9b. Fixing only the obvious name moves
the error rather than removing it: the sequence inside
`nextval('record_version_seq')` is a regclass literal resolved the same way, and
`::audit_actor_kind` is a third.

`ALTER FUNCTION … SET search_path = lbr2, pg_catalog` fixes all three and was
measured to work — and is NOT what this does, because it stores the schema name
as text, so after phase 20's `ALTER SCHEMA lbr2 RENAME TO public` it names a
schema that no longer exists and every write fails again (also measured). Every
name now resolves through `TG_TABLE_SCHEMA`, which is correct before and after
the rename. It costs nothing: 5,000 inserts took 290 ms pinned and 289 ms this
way, because Postgres caches the plan for a stable query string.

**`COALESCE(current_setting(…, true), 'system')` is correct exactly once per
backend.** After a transaction has called `set_config(…, true)` and committed,
the setting is not NULL again — it is the EMPTY STRING. So the next
UNATTRIBUTED write on that pooled connection would have failed with
`22P02 invalid input value for enum audit_actor_kind: ""`, landing on whatever
reused the backend, which may be a nightly job rather than the request that
caused it. `NULLIF(…, '')` now wraps every read.

Neither is visible to the census fixture, which captures `pg_get_triggerdef` —
that does not include the function body. Both are covered by runtime regression
tests that drive a real Prisma client, which is the only thing that would have
caught them.

**And a third, found by the first integration run:** the per-tenant runtime role
had no grants on `lbr2` at all, so every 2.0 write failed with
`42501 permission denied for schema lbr2`. `packages/db-control/src/tenant-db-roles.ts`
granted on a hardcoded `public`; it now iterates an explicit `TENANT_SCHEMAS`
list, skipping schemas that do not exist yet (roles are applied before
migrations on a new database, and again after). Invisible to every phase-9 test,
all of which connect as the superuser.

### The concurrency design, decided by measurement

Three mechanisms appear in one phase and they are easy to conflate. They are
NOT interchangeable, and each was measured on the real tables:

| variant                                              | 2-way                  | 25-way  |
| ---------------------------------------------------- | ---------------------- | ------- |
| naive (read, compare in JS, unconditional UPDATE)    | 2 winners / 3 versions | 25 / 26 |
| **advisory lock AFTER the read**, hash checked in JS | 2 / 3                  | 25 / 26 |
| advisory lock FIRST, no hash check                   | 2 / 3                  | —       |
| advisory lock FIRST, hash checked in JS              | 1 / 2                  | 1 / 2   |
| CAS (`UPDATE … WHERE content_hash = $expected`)      | 1 / 2                  | 1 / 2   |

The second row is the one worth naming: it is the natural left-to-right reading
of "advisory lock → hash precondition" and it gives **exactly the protection of
no lock at all**, because both readers complete before either lock is requested.
The lock must be the FIRST statement of the transaction, before any read.

BOTH are used, at READ COMMITTED, because each covers something the other does
not. The CAS cannot prevent a deadlock — two writers touching
`marc_record_contents` and `marc_records` in opposite orders produce `40P01` —
and the lock cannot detect staleness. Raising the isolation level instead
"works" and is wrong for this criterion: REPEATABLE READ and SERIALIZABLE both
yield one winner, but the loser gets `40001`, a retry-shaped error carrying
neither the current record nor the diff the clause demands.

`locks.ts` lands here rather than in phase 16 so this is not a 26th hand-rolled
call site. The CI grep phase 16 also specifies does NOT land: there are 25 bare
call sites in 1.0 services, and a gate shipped with 25 allowlist entries
pointing at code the cutover deletes is a gate that checks nothing.

### 005 cannot be monotonic from the wall clock

The clause is "two consecutive edits produce strictly increasing 005". MARC 005
has TENTHS-of-a-second resolution, and a complete write transaction was measured
at **1.60 ms** — ten consecutive edits produced ten IDENTICAL stamps. So a
wall-clock stamper does not merely risk a collision; under this write path it
collides essentially always.

Worse, the obvious test passes on it: two supertest PATCHes are usually more than
100 ms apart. The test is therefore written IN-PROCESS, ten edits back to back,
asserting ten distinct stamps read from the STORED document. The stamper is
`max(clockTick, previous + 0.1s)`, and the consequence is deliberate: a burst of
edits pushes 005 ahead of real time by a tenth of a second each. That is correct
for MARC — 005 is a transaction timestamp whose job is to order versions — but
it will look wrong to anyone diffing it against `updated_at`.

### Three things the tests changed about the implementation

**One statement, or two change events per edit.** The CAS and the `row_version`
bump were originally two UPDATEs on `marc_records`, and every UPDATE fires the
changelog trigger — so one edit wrote TWO change events and every consumer would
have processed the record twice. Folded into one raw statement with `RETURNING`.
The `row_version` bump is not optional either: phase 9's decision to give
`marc_record_contents` no trigger rests on "every content write bumps the
parent's row_version in the same transaction".

**005 is excluded from every diff, exactly as it is from the hash.** `diff()`
knows nothing about 005 and reports it as an ordinary field change, so without
this every history row would read "changed 005, 245" and — worse — a save that
changed nothing would come back `verdict: 'changed'` and write a version row,
which §2 explicitly forbids.

**Leader/05 follows the content, not the act of saving.** Setting it to `c`
before diffing makes a no-op save change the leader, which IS a change, so the
record is no longer identical to itself. It is now set only when the content
actually moved.

### Left open, deliberately

`ValidationMode` is still declared and unused: phase 8 named the type and left
the behaviour here, and 10a fixes `block` as the only mode. Note what that
currently means — the shipped definition reports `confidence: 'transcribed'`, so
every table-driven rule is capped at WARNING and the only errors that can block
a save are the three STRUCTURAL ones (`indicator-malformed`, `data-field-empty`,
`field-kind-mismatch`). A test written around "a repeated 245 blocks the save"
would fail, and correctly.

Phase 8's other inheritance is also still open and is recorded again so it does
not evaporate between two phases that each believe the other owns it: a
persisted issue set must carry the definition's identity (profile, digest,
confidence) so a definition change is treated as "recompute" rather than
"trust". 10a persists no issue set — `needs_review` is a boolean — so the
obligation passes to whichever phase first stores one.

`projectInTransaction()` is an explicit empty method inside the write
transaction. §2 requires the relational projection to be recomputed "inside the
same transaction as every write", and phase 11 owns it; leaving the hole visible
means phase 11 fills it rather than restructuring the write path.

---

## Phase 10b — the record lock

The last of phase 10's five acceptance clauses: "lock acquire/heartbeat/expiry/
take-over each write the expected audit action." `marc_record_locks` is now
`created` in BASELINE-SCOPE.json — eighteen tables.

§3 names this table in one list and specifies no column of it anywhere in 1,054
lines, so every column is either forced by that clause, forced by a foreign key,
or forced by a measurement. The three that were considered and rejected are
recorded in the model docblock, because the expensive guess in a schema is a
column nobody asked for.

### The one thing a reader cannot re-derive from the SQL

**A stopped sweep costs the audit trail and never a frozen record.** Liveness
lives in the acquire predicate — `WHERE expires_at <= now() OR …` — and was
measured to work with no sweep in the database at all. That is the property to
keep if this is ever refactored: a design where the job is what makes a lapsed
lock acquirable would freeze every record whose editor crashed, until a worker
somewhere caught up.

The shape follows from a refusal. The intuitive design is many rows plus a
partial unique index on the live ones:

    CREATE UNIQUE INDEX … ON marc_record_locks (record_id) WHERE expires_at > now();
    ERROR:  42P17: functions in index predicate must be marked IMMUTABLE

Postgres is right to refuse: an index predicate must be a property of the row,
and "is this lock still live" is a property of the row AND the clock. So the
uniqueness went into the primary key — one row per record, ever — and the
liveness into the predicate.

### A lock is held by a TAB, not by a person

The strongest measurement in the phase, with all 25 clients provably parked on a
barrier before release (25/25 not-granted advisory ShareLocks in `pg_locks`):

| guard                           | contenders                                      | winners | refused |
| ------------------------------- | ----------------------------------------------- | ------- | ------- |
| `holder_user_id` only           | 25 tabs, **all the same cataloguer**, live lock | **25**  | 0       |
| `holder_user_id` + `session_id` | same                                            | 0       | 25      |
| holder + session                | 25 users, free record                           | 1       | 24      |
| holder + session                | 25 users, EXPIRED lock                          | 1       | 24      |
| holder + session                | 25 users, LIVE lock held by a non-contender     | 0       | 25      |

Without `session_id`, every tab a cataloguer opens silently inherits her own
lock, and she loses her work the first time she opens a second one. The last row
is the other half: a live lock is never taken by accident. Taking one is a
separate, deliberate act that must QUOTE the incumbent — `seenSessionId` makes
take-over a compare-and-swap on the holder, so a stale banner cannot displace
somebody the user never saw. Measured: right incumbent succeeds, stale incumbent
is refused, nothing sent is refused.

### Clause 5's vacuity trap, and why BOTH expiry mechanisms are required

The natural test — expire a lock, acquire it as somebody else, assert an
`expired` audit row — **actually exercises take-over**, and passes under a design
with no expiry concept at all. Measured: an acquire whose predicate is a bare
`OR $force` against a LIVE lock gives 25 winners at 25-way, and every one writes
the row that test asserts.

So the test has NO SECOND ACTOR anywhere in it: a lock lapses, nobody ever
touches the record again, and the row must still exist. That scenario cannot be
constructed under a TTL-only design, and the fact that it cannot is the signal
that a sweep is required.

The converse is asserted too, and it is the correctness half: a lapsed lock is
acquirable with no sweep having run.

Neither mechanism covers the other's case, which is why there are two:

- **Lapsed and re-acquired.** The acquire notices and records
  `displaced_reason = 'expired'`. A sweep on a five-minute interval is usually
  too late, so a sweep-only design writes nothing here.
- **Lapsed and never touched again.** No acquire ever happens, so a
  lazy-capture-only design writes nothing here, and "who had this record open
  when it was last edited" is unanswerable.

They cannot double-write, and that is structural rather than guarded: because the
sweep DELETEs rather than marking, the next acquire on that record is a fresh
INSERT with no displaced holder and takes the "nothing was displaced" branch.
Exactly one expiry row per lapse, whichever mechanism gets there first, with no
idempotency check anywhere. **If the sweep is ever changed to a soft delete, that
property is lost** — the integration spec asserts it directly.

### The lock is advisory, and nothing enforces it

`BibWriteService.write()` does not read it and must not learn to. An import, an
overlay, a merge, a batch job and the phase-19 copy-forward all have to be able
to write a record a cataloguer has open; a lock that could refuse a save would be
one somebody has to override at 2am. The spec asserts a save by a person who does
NOT hold the lock succeeds and leaves the lock untouched.

Measured, the foreign key cannot gate it by accident either: an uncommitted lock
INSERT does not block the write path's UPDATE, because the acquire holds KEY
SHARE on `marc_records` while the write takes FOR NO KEY UPDATE, and those do not
conflict.

### Decisions worth their sentence

**The audit rows go to 1.0's `public.audit_log`**, through the existing
`TenantAuditService`, exactly as 10a's do. Writing `lbr2.audit_log` instead was
considered and rejected: phase 19's copy-forward routes 1.0's rows into that
table with "row counts exact" as an acceptance assertion, so a non-empty target
at cutover fails it by exactly the number of lock rows — and the v2 smoke asserts
that table is empty. It keeps zero writers until phase 19.

**No new permission key.** `cat.bib.write` covers acquire, heartbeat, take-over
and release; `cat.bib.read` covers reading the holder. `cat.lock.override` was
considered and deferred, because `permissions.ts` records that keys are forever
and no library has yet asked for a workflow where taking a record from a
colleague is a privilege rather than a conversation.

**No `@replicated` marker and no changelog trigger.** A lock beats every sixty
seconds while an editor is open; replicating it would make it the largest
producer in the feed to tell consumers about something none of them wants.
`check:changelog-coverage` enforces both directions, so the absence of both is a
checked decision — it still reports nine and nine.

**No index beyond the primary key.** Measured over 3,000 heartbeats with VACUUM
FULL between trials: 100.0% HOT updates with no secondary index, 87.2% with one
on `expires_at`. The table is bounded at one row per record ever opened, so the
sweep's scan is cheaper than the write amplification.

**Release exists although the clause does not name it.** Without it a cataloguer
who closes the editor holds the record for the rest of the TTL, and the only way
to get it back is to take it over — which then writes a `lock_taken_over` row
saying somebody was displaced when nobody was. It is a DELETE, and the TTL CHECK
(`expires_at > acquired_at`) makes "release by backdating" illegal so there is
exactly one way to give a record back. That constraint has a testing consequence
worth knowing: a fixture that wants an already-lapsed lock must backdate
`acquired_at` too, or the constraint refuses the fixture itself.

**The heartbeat audits once per session, not once per beat.** A beat is ~0.12 ms
every sixty seconds; auditing all of them would write ten permanent rows per
record per session to record that somebody left a tab open. `heartbeat_count` is
what makes "first beat" answerable without a second read.
