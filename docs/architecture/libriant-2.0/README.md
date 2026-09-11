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

---

## Phase 11a — the relational projection

The first half of phase 11: "Pure, total projector". The serialization endpoints
(`GET /catalog/bib/:id.(mrc|xml|json)`, `?fidelity=source`, the streamed
`catalog_marc` export) are 11b. `bib_records`, `bib_identifiers`,
`bib_classifications` and `work_clusters` are now `created` in
BASELINE-SCOPE.json — twenty-two tables.

Three of those four have no DDL anywhere in the plan of record. §3 gives
`bib_records` a full `CREATE TABLE`; it names the two satellites once each in an
inventory list with no columns at all, and `work_clusters` exists only because
`bib_records.work_cluster_id` is written with a `REFERENCES` clause. What that
meant in practice is recorded per table in `BASELINE-SCOPE.json` as
`specified` / `invented` / `skeleton`, and in the model docblocks.

### The defect the phase existed to make impossible, found by writing it

**Six columns of `bib_records` are not the projector's** — `item_count`,
`available_count`, `suppressed_from_opac`, `custom_fields`, `cover_asset_ref`
and `legacy_json` — and `material_type_id` and `work_cluster_id` make eight
that the phase-11a service must never write on update. An `INSERT … ON CONFLICT
DO UPDATE` that assigned the excluded row wholesale would destroy all eight on
every single-subfield edit: zero the OPAC availability of every record a
cataloguer touched, un-suppress records staff had hidden, and throw away the only
copy of the 1.0 row, which is unreconstructible once `v1_archive` is dropped.

The defence is structural rather than remembered. `ownedColumns()` builds ONE
object holding exactly the projector-owned columns, and the same object is spread
into the create and passed as the whole of the update; the eight are not in it and
there is no second object an update could accidentally use. `NOT_THE_PROJECTORS`
is exported so a test can assert the classification rather than restate it, and
`bib-projection.spec.ts` sets all eight by hand, edits the title, and asserts they
survive.

### The create path had no projection at all, and nothing failed

Phase 10 left `projectInTransaction` as an explicit empty method and called it
from `writeCore` only. `create()` does not go through `writeCore` — it writes its
own three rows — so a newly catalogued record would have had no projection until
somebody happened to edit it: invisible to the OPAC, to facets, to browse and to
every report. No test would have caught it, because a test that wants to look at
a projection naturally creates a record and then edits it. Both paths are wired
now and the create case is the first assertion in the integration spec.

### The projector is TOTAL, and that is the whole design

It never refuses a record and never throws. A librarian's typo must not be able
to abort a 50,000-record import halfway through, so every judgement the projector
declines to make lands in `projection_anomalies` — thirteen codes, each with the
tag and a sentence addressed to a cataloguer. That column is **invented**: §3 does
not have it, and a queue with no table is a queue that does not exist.

Two consequences worth stating. A record with no 245 gets the sentinel title
`[Untitled]` and an anomaly, not a failed import. And an ISBN that fails its own
check digit is **stored with `valid = false`** — the 1.0 `normalizeIsbn13`
accepts that value (measured `{ok: true}`) because it only tests the shape, so a
wrong ISBN entered the catalogue looking right; refusing it instead would make
the cataloguer delete the ISBN to get their work saved.

`packages/shared/src/identifiers` is new and hand-rolled for ISBN-10/13, ISSN,
ISMN (including the older printed `M…` form), EAN-13 and DOI. **None is a
uniqueness constraint** and there is deliberately no unique index: §3 records that
the 1.0 `books_isbn13_unique_active` "would refuse the exact catalogues this
product exists to import", because a set and its volumes, a reprint, and endemic
publisher ISBN reuse in small Greek presses all legitimately share one. A
duplicate is a merge offer at phase 39. The v2 smoke asserts the absence directly,
because a "helpful" migration adding it back is a one-line change with no other
symptom.

### Two things deliberately NOT constrained, asserted so they stay that way

The identifier unique above, and **`holdings_records (bib_id, branch_id)`**. An
earlier draft of the migration made the second one unique. It is wrong for the
same reason: a branch legitimately holds one title in more than one MFHD —
reference and stacks, large-print beside ordinary, a serial whose bound volumes
and current issues carry different 852 `$b` — and with no shelving location or
call number on that table yet (phase 15) the constraint could not even be written
correctly. A plain composite index answers the same lookup.

`holdings_records.bib_id` itself lands here because the phase-9 docblock said it
would. It is `NOT NULL` with no default and no backfill, which is only safe
because `lbr2` holds no rows in any database — the copy-forward is phase 19 — and
the ALTER fails loudly rather than inventing a bib if that is ever untrue.

### The sort key is computed in the projector, not the service

An earlier draft left `sortKey: ''` on the theory that the service owned the
`@libriant/shared/callnumber` dependency. That was simply false — `packages/marc`
already imports `foldGreek` from the same package — and the real argument runs the
other way: a sort key produced beside the value it sorts cannot be produced by a
different rule than the comparison. The `local` scheme is the one that matters
here, because it transliterates, so `ΠΑΙΔ 823 ΚΑΖ` files where a Greek librarian
expects it rather than after every Latin call number in the catalogue. Every key
is pure ASCII and fixed width — the `perf-13` trap, since tenant databases are
`el_GR.UTF-8` and a non-ASCII key reorders under that collation.

### The non-filing indicator counts RAW characters, and a comment said so

MARC 21 defines 245 indicator 2 as the number of characters at the start of the
field to be disregarded, counted in the field **as transcribed** — spaces and
diacritics included. The projector applied the skip to the display title, which
has already been through `tidy()` and therefore has its runs of whitespace
collapsed. So a `$a` of `"Ο  κόσμος"` — a double space, which real catalogues
are full of — carrying a correct ind2 of 3 lost three characters from the
nine-character collapsed form:

    sortTitle "οσμοσ" instead of "κοσμοσ", plus a spurious
    `nonfiling-indicator-disagrees` on top of it

so the book filed under sigma and the review queue filled with records that were
catalogued correctly. The comment that sat on that line named exactly the trap
the code walked into: "Folding first would collapse whitespace and move the
offsets." Both the slice and the article detector now work on the untidied `$a`,
with `tidy` applied afterwards, and the length guard leads with `n > 0` so that a
245 with a `$b` and no `$a` — malformed but common — does not raise
`nonfiling-indicator-too-long` on an ordinary indicator of 0.

### `bib_records` is NOT `@replicated`

The projection is DERIVED from `marc_records`, which is replicated. A second
change event for the same edit would make every consumer process it twice and
could not be ordered against the first. `check:changelog-coverage` still reports
nine and nine, and the v2 smoke asserts that writing a projection produces no
event — because adding the annotation by reflex is one word with no other symptom.

### The TOAST claim, measured with the right instrument

§2's argument for the 1:1 document split is that "nothing that scans reads the
document… TOAST keeps fat JSONB off the heap page **provided nothing selects
it**". `bib_records` has fat columns of its own — `summary` and `search_text` —
so the same discipline has to hold here, and `bib-projection-toast.spec.ts`
measures it.

**The obvious instrument is wrong.** Measured against a 300-row fixture:

    real SELECT projecting the fat column   → toast blocks 300
    EXPLAIN (ANALYZE, BUFFERS) of the SAME  → "Buffers: shared hit=185",
                                               and no TOAST line at all

TOAST fetches happen during output-tuple formation, outside the executor's buffer
accounting, so an EXPLAIN-based test reports zero for a query performing three
hundred reads and passes on the exact regression it exists to catch.
`pg_statio_user_tables` counts them because it counts the buffer manager.

The fixture is forced rather than catalogued, and that is itself a finding:
records created through the API do NOT reach TOAST, because the projector clamps
`summary` to 2,000 characters and `search_text` to 8,000 and both columns are
`SET COMPRESSION lz4`, so real prose compresses under the threshold and stays
inline. A realistic fixture would measure zero for both queries and assert
nothing. The rows are incompressible `md5()` noise and a guard refuses to let the
suite proceed if they did not get there.

### `catalog-verify`, and why a transactional projection still needs one

It cannot drift by racing — the projection commits with the record, which the
integration spec proves by refusing a write and asserting the projection did not
move. It drifts because the **projector changes**: a rule is corrected, a subfield
starts being read, a fold is fixed, and from that deploy every record written
before the change disagrees with every record written after it.

That is not hypothetical. This phase produced one such change while it was being
written — the sort-key fix above — and the verifier found it: eight of nine
records in a test tenant, `stale: classifications`, repaired by
`pnpm catalog:verify --repair` and clean on re-run.

**The nightly job never writes.** Same rule as the fee ledger's reconciliation
(risk 7): a sweep that silently repairs drift also silently hides the change that
caused it. `--repair` lives in the CLI, behind a person, and re-derives through
the same `BibProjectionService` the write path uses so a repaired row and a
freshly written one cannot differ.

`libriant_catalog_projection_drift_total` is a second series alongside
`libriant_worker_job_count{sweep="catalog-projection-verify",count="drift"}`,
which already carries the number. It has a reason: that gauge is `alert: false`
on the argument that no single threshold means the same thing across twelve
handlers, and drift here is not a handler statistic — it is the OPAC serving
something the record does not say. `LibriantCatalogProjectionDrift` fires at `> 0`
with no tolerance band, because the fleet-wide expected value is zero.

### One bug the verifier found in itself

Its first run reported three of nine records drifted on `projectionAnomalies`,
all three of them the records that had a non-empty array. **`jsonb` does not
preserve key order** — it stores keys sorted by length and then bytewise — so a
`{code, tag, message}` written by the projector comes back as
`{tag, code, message}` and `JSON.stringify` differs on every record with an
anomaly. The comparison now reads the three fields by name. Any future comparison
of a stored `jsonb` against a freshly computed object has the same trap.

### What an adversarial review found after the phase was green

Six lenses over the diff, every finding independently verified by a second pass
that was told to refute it. Twenty survived; the ones that changed code are here,
because each is a defect the phase's own tests were green over.

**A qualifier in `020 $a` made a good ISBN unfindable.** `strip()` removed only
whitespace and hyphens, so the ordinary MARC form `978-0-306-40615-7 (pbk.)`
normalised to `9780306406157(PBK.)` and was flagged `valid = false`. Both halves
hurt: `bib_identifiers_lookup_idx` is on `(scheme, value_norm)`, so the record
could not be found by its own ISBN, and the "these records have an impossible
ISBN" queue filled with records whose ISBN is perfectly good. A qualified ISBN-10
also lost its 13-digit upgrade, so the same book catalogued once with a qualifier
and once without produced two non-matching `value_norm` values — degrading the
duplicate signal phase 39 reads. MARC 21 gained `020 $q` for this in 2013;
everything catalogued before then, which is most of an ABEKT or Aleph export,
puts it in `$a`. The test named _"a qualifier in the source does not defeat the
check"_ asserted only hyphens and spaces.

**`024 7#` is not a DOI.** Indicator 1 = 7 means "source specified in `$2`", and
the registry behind it holds `uri`, `urn`, `istc`, `iswc`, `sici`, `hdl` and
more. Every non-DOI `024 7#` was stored under `scheme = 'doi'` and flagged
invalid against the DOI shape test — mislabelling the identifier _and_ filling
the queue with it. `$2` now decides, and a value this version does not
understand is **not stored**, with `identifier-unknown-scheme` saying so:
guessing a scheme is what makes a good ISWC look like a broken DOI.

**Truncation manufactured lone surrogates.** Every cap cut with `String.slice`
on code-unit offsets, so an astral character straddling the boundary left an
unpaired high surrogate. Measured against a real tenant database: node-postgres
sends `'A\uD800B'` and reads back `'A\uFFFDB'`, because Postgres `text` is UTF-8
and an unpaired surrogate has no encoding. The consequence is worse than a
mangled character — such a record would be reported drifted on **every** nightly
verify for ever, and `--repair` could not fix it, because the repair writes the
surrogate again and the database rewrites it again. `cut()` now stops at a code
point and `sanitize()` substitutes U+FFFD, which is what the database stores
anyway.

**An empty `sort_title` was reachable.** `foldGreek` strips combining marks, so a
245 `$a` that is one — present in the semantic corpus and in real broken imports
— folded to `''`, which is the one state the column's own docblock names as
unacceptable: it files the record ahead of the entire catalogue. The sentinel is
now the floor, with `sort-key-underivable` so the fallback is visible.

**`catalog:verify --repair` could revert a save.** It read the document in one
statement and wrote the projection in a separate transaction, so a cataloguer who
saved between the two had their edit's projection overwritten by one derived from
the previous document — and the CLI reported it repaired. The read is now inside
the transaction and behind `pg_advisory_xact_lock('bib:<id>')`, the same key
`writeCore` takes.

**The CLI aborted the fan-out on the first tenant with no sealed credential.**
`runtimeDbUrl(t)` was evaluated one line above the `try`, so its deliberate
fail-closed throw escaped the loop instead of counting as one unreachable
library — the exact failure every sweep in `apps/api/src/jobs` is written to
avoid.

**`check:schema-drift` was not idempotent.** `bib_records_search_trgm` is the
first object in `lbr2` that depends on an extension, and the 1.0 entry's
`--from-migrations` replay resets the shadow database by dropping and recreating
`pg_trgm` — CASCADE-dropping that index while leaving every table and the
`_prisma_migrations` ledger intact. `migrate deploy` is then a no-op, so the
second run of the gate against the same shadow database failed with _"allowlisted
drift no longer occurs — remove it"_, telling the operator to delete a correct
entry. CI never saw it because it creates the shadow database fresh. The deploy
mode now drops its namespace first; three consecutive runs against one shadow
database pass.

**The test everything cited as proof of same-transaction atomicity proved
nothing.** It refused a write with a stale `expectedContentHash` and asserted the
projection had not moved — but `writeCore` rejects a stale hash at step 2, before
the CAS, before the content write, and before `project()` is called at all. It
would have passed on an implementation that wrote the projection after the
commit. The real test drives the service inside a transaction that then throws,
having first read the projection back _inside_ that transaction to prove it was
written, and asserts the deliberately corrupted row is still corrupt. The 409
case is kept, renamed for what it actually proves.

**Four tests could not fail.** The fuzz corpus's coverage guard counted the
labels `generateSemanticCorpus` stamps by index rather than anything the records
contained, so it was a tautology that would have passed with every residue
returning the same clean record; it now counts distinct projections and asserts
the RIGHT anomaly per residue, which is what the fixture's own docblock says the
declared residue is for. _"A single-date record gets no end year"_ used a fixture
whose 008/11-14 is blank, so `year()` returned null before the guard was
consulted — it passed with the guard deleted, measured; it now uses `9999`, the
value real records carry. The call-number test asserted `typeof === 'string'` and
its premise was wrong (an unparsed number gets 96 zeros, not an empty key, and
that is correct — a fixed-width key is the whole point). And the drift verifier,
which stands behind the page and the repair CLI, had **no test of any kind**.

### Decisions worth their sentence

**`public.gin_trgm_ops`, qualified.** An operator class is resolved through
`search_path` exactly as a function is, so a bare `gin_trgm_ops` is the same time
bomb `20260825200000_qualify_immutable_unaccent` defused once in 1.0. `public`
rather than `extensions` because that is where the 2.0 baseline puts its
extensions; phase 20 relocates them and risk 3 already commits that phase to
recreating every affected index fully qualified.

**The migration creates `pg_trgm` itself.** It is created by the 1.0 init and
every tenant runs both tracks until phase 20 — but repeating it makes the 2.0
track applicable to a database that has only ever seen it, which is what the
phase-19 upgrade fixture and every probe database are.

**No `material_type_id` mapping.** The obvious one — `carrier_type_code` onto
`material_types.code` — is a guess: RDA carriers are `nc`, `cr`, `sd`; a library's
material types are `book`, `dvd`, `περιοδικό`. Nothing joins them until
`material_types` grows a carrier column, which is phase 15's.

**The satellites are deleted and re-inserted, not diffed.** They have no natural
key — deliberately, since none of these is a uniqueness constraint — so a
diff-and-patch would have to invent one. Both hold a handful of rows per record
and the projector owns every row in them.

**`TxV2` moved to `apps/api/src/tenancy/tenant-tx-v2.ts`.** Phase 11a gave it a
second user, and two copies of an `Omit<…>` list is one place for them to
disagree — with the symptom being a helper that silently cannot be called from
inside a transaction, which is the only place these helpers are ever correct.

---

## Phase 11b — MARC comes back out

The second half of phase 11: `GET /catalog/bib/:id.(mrc|xml|json)`,
`?fidelity=source`, a MARC-native ingest that stores the original bytes, and the
streamed `catalog_marc` export. With it the sentence on the marketing site —
"MARC goes into Libriant, it does not come out" — stops being true, which was
the point of the phase.

The acceptance criterion is met end to end and measured: **10,000 conforming ISO
2709 records ingested through the API, exported by the real `catalog_marc` export
job, unzipped, re-split, and every one re-parses to an identical record with a
matching canonical hash; `catalog-verify` reports zero drift over all 10,000.**
78 seconds, in `catalog-serialize.spec.ts`.

### "Identical records" has three meanings and only one is owed

This is the trap the whole phase turns on, and every one of three independently
written designs got it wrong before it was measured.

**Byte identity is not owed on the derived path and is not achievable** — 0 of
2,000, measured. `create()` runs `stamp005`, which replaces any 005 with the
transaction timestamp, and `leaderForWrite`, which sets /05; `writeIso2709` then
recomputes /00-04 and /12-16 and forces /09, /10, /11 and /20-23. Every one of
those is REQUIRED by §2's leader write rules. A test asserting byte identity here
would be asserting that the writer violates the standard.

Byte identity IS owed, exactly, for an unedited imported record at
`?fidelity=source`. Those are §2's two distinct promises and they are not
interchangeable.

So the assertions are `diff(withoutStamp(in), withoutStamp(out)) === 'identical'`
and `contentHash(stored) === contentHash(re-parsed)` — and the second of those
was FALSE until this phase fixed the defect below.

### Leader/09 was stored as the source claimed, not as the store holds

`leaderForWrite` set /05, /10, /11 and /20-23 and left /09 alone. `writeIso2709`
forces /09 from the export encoding — "set from the EXPORT, never copied from the
source", which is the rule that stops a UTF-8 record going out declared as
MARC-8 and arriving as mojibake. And `canonicalLeader` keeps positions 5..11, so
**/09 is inside the content hash.**

A Greek ABEKT or Aleph export declares MARC-8 with `/09 = ' '`. Measured on the
real codec:

    stored          contentHash c28e3d69cc9bc8b0…
    export→re-parse contentHash fd682577fc5ef1f2…   NOT EQUAL

— for exactly the files this product exists to import. `marc_records.charset_code`
was already hard-coded `'a'` and had been disagreeing with the stored leader
since phase 10. The fix is one line and the phase could not have passed without
it; the original byte survives where every other original leader byte survives,
in `source_blob`.

### The ingest is synchronous and bounded, and that is the shape phase 11 owes

`POST /t/:slug/catalog/bib/ingest`, raw `application/marc`, at most 4 MiB and
1,000 records, with a 12-second deadline checked between records. Bigger files
are chunked by the caller; `pnpm catalog:import` does it with `splitIso2709` —
the codec's own splitter, the same function the server uses — so a boundary never
falls inside a record.

**It calls `BibWriteService.create()` once per record**, unchanged. A bulk writer
would be 2.2× faster (measured: 1.17 ms/record batched ten to a transaction
against 2.54 ms per-record) and would silently reproduce the exact defect phase
11a shipped and fixed — a record with no projection, invisible to the OPAC, with
every test green. That is not a trade worth 1.4 ms.

One transaction per record is also the failure model this route needs: a file
with one bad record loads the other 999 and the response says which one failed
and why.

Why not a queue: the worker process has **no Nest DI container** — `NestFactory`
appears only in `main.ts`, and `import-worker.ts` hand-builds a v1 client — so a
queued ingest could not call `create()` without standing up a second construction
site for the projection tuple. And phases 30, 35 and 37 each bring a bulk MARC
path with their own progress and resume semantics; building one here means
building it twice.

1,000 records is calibrated against `SHUTDOWN_DEADLINE_MS` (20 s), so an ingest
in flight when a deploy lands finishes inside the drain and this route never
becomes a second named exception to a rule `GET /t/:slug/desktop/download` is
currently the only one of.

### `?fidelity=source` refuses rather than falls back, in four distinguishable ways

`never-stored` (typed, not imported), `edited` (`writeCore` NULLs the blob on
every edit BY DESIGN — after an edit the promise is round-trip idempotence, not
byte identity; `source_format` survives, which is what tells the two apart),
`format-mismatch` (the bytes are MARCXML and `.mrc` was asked for — the answer
names the extension that would work rather than transcoding, because transcoded
bytes are by definition not the original ones).

A silent fallback to a fresh serialization would have been the one wrong answer
nobody can detect.

### Seven dead columns now have a writer, and four more were derived

`source_format`, `source_encoding`, `source_normalization`, `source_blob`,
`source_blob_sha256`, `source_roundtrips` and `anomalies` had existed since phase
9 with no writer at all. The ingest fills every one:

- `source_roundtrips` is MEASURED — `bytesEqual(writeIso2709(parsed), slice)` —
  on the RAW parse, before NFC and before the 005 stamp. After either it would
  read `false` for every record in every file and the column would carry no
  information. Measured on the phase-7 corpus: 86 % of records round-trip
  byte-for-byte, 100 % of the conforming ones.
- `source_blob_sha256` is computed by the SERVICE from the blob, never accepted
  from a caller: a row whose own checksum is a lie is undetectable afterwards.
  The integration test has Postgres recompute it.
- `source_normalization` is `nfc` | `nfd` | `mixed`, classified from what
  arrived. `mixed` is a real answer — a record with an NFC title and an NFD
  subject heading exists.
- `source_encoding` records `marc-8+lossy` when the decoder substituted U+FFFD,
  which is the only durable answer to "why does this record have replacement
  characters in it".

And `record_type_code` (Leader/06), `bib_level_code` (Leader/07),
`encoding_level` (Leader/17) and `control_number_source` (003), which left
`marc_records_type_idx ON (kind, record_type_code, bib_level_code)` an index over
two permanently NULL columns.

`kind` is derived from Leader/06 rather than defaulting to bibliographic. A .mrc
file routinely carries authority and holdings records beside the bibs, and
storing one as bibliographic is worse than refusing it: the projector
short-circuits on kind, so a mislabelled authority record would get a
BIBLIOGRAPHIC projection and appear in the OPAC as a book called "Καζαντζάκης,
Νίκος". They are refused instead, one line each in the result array, because this
build ships no authority definition until phase 45.

### A duplicate 001 was a 500

`marc_records_control_number_unique_active` is a deliberate constraint that
nothing could hit while the only writer was the editor, which mints no 001. An
ingest hits it the moment a library loads a file it already loaded — the single
most common thing that happens to an import — and it escaped as a 500 with a
support code. It is a 409 with `catalog.duplicateControlNumber` now.

Worth recording HOW it is detected: Prisma 7 with a driver adapter puts the
constraint at `meta.driverAdapterError.cause.constraint.fields` and leaves
`meta.target` UNDEFINED — measured. A check against `meta.target` compiles,
passes review and never fires.

### The export is a `catalog_marc` FORMAT, not a route

§6 says "streamed `catalog_marc` export format", and a format is what it is: one
new value on the existing `ExportFormat` enum plus one branch in the export
worker, inheriting the `export_jobs` row, the concurrency-1 queue, `ExportRunGuard`'s
2 GiB reserve and four-hour deadline, `purgeJobArtifacts`, the 24-hour TTL and
both download routes. A live `GET /catalog/export.mrc` was the alternative and
would have inherited none of them, in a process whose shutdown drain is twenty
seconds.

It ships as a **zip**: `catalogue.mrc`, `manifest.json`, and `oversize.xml` when
there is something in it. `writeIso2709` refuses rather than corrupts — a field
over 9,999 bytes (a multi-volume 505 contents note reaches that), a record over
99,999, a separator byte inside a value — and each message names MARCXML as the
answer, which is true. A refused record goes to the XML and the manifest accounts
for every record the walk saw, because a catalogue export that silently contained
fewer records than the catalogue is the worst thing this code could do: the
library discovers it years later, in another system, with no way to tell which
records were lost. `total = inCatalogueMrc + inOversizeXml`, always.

Three things it deliberately does NOT reuse:

**`BufferedWriter`.** It is a STRING buffer — `private buf = ''`, `this.buf += s`
— which is right for CSV and destroys ISO 2709: appending bytes to a JS string
decodes them as UTF-8 with replacement characters, so the leader's own /00-04
byte count stops matching the bytes that follow it and the file parses as one
corrupt record. `ByteWriter` is the same 64 KiB write-behind over `Buffer`.

**`withTableReader` / `createRowStreamer`.** Both enumerate
`schemaname = 'public'`, quote a single unqualified identifier, and redact by 1.0
table name, so `lbr2` is invisible to them. The keyset walk from
`bib-projection-verify.ts` is used instead.

**`assertExportSizeSane`.** It estimates from `pg_class` filtered to
`nspname = 'public'`, so for a catalogue living entirely in `lbr2` it would report
zero and `assertRoomFor(0)` would wave an export onto a nearly full disk.

### No metric, and that is a decision

A refusal counter was considered and rejected. The authoritative account is
`manifest.json` inside the artifact the librarian is already holding; a second
surface would be a fleet-wide Prometheus series that pages an operator about one
library's 505 note, at a rate of a handful of exports a year. A `console.warn`
puts the fact in the operator log, where a pattern across libraries would show.

### Holdings auto-creation: deferred to phase 15, and it is unimplementable here

§6 names it under BOTH phase 11 and phase 15 ("Items, holdings, call numbers…
holdings auto-creation"), so the deferral is a citation rather than a divergence.
Three measured reasons make it the only honest answer:

1. There is **no item service in `lbr2`** — nothing anywhere creates an `Item`
   row — so there is no first-item event to hook. Auto-creation means "create a
   default holdings record when the first item arrives".
2. `holdings_records.branch_id` is NOT NULL with a foreign key, and **tenant
   provisioning seeds no branch**. There is nothing to attach a holdings record
   to.
3. 11a deliberately refused a `(bib_id, branch_id)` unique — a branch
   legitimately holds one title in more than one MFHD — so there is nothing to
   upsert on either.

11a landed the `bib_id` link that makes it possible. Phase 15 owns the rest.

### Open questions answered here, so a later phase does not answer them differently

**`date_entered` means "added to THIS database", not "added to this library's
stock".** `create()` writes `yymmdd(now)` and never rewrites it, and §6 phase 19
sets 008/00-05 from `created_at` for the copy-forward too. The consequence is
real and accepted: a 50-year-old catalogue migrated on one afternoon reports
those titles as accessioned that year. The alternative — trusting the source
record's own 008/00-05 — makes the ISO 2789 return depend on data the library did
not produce and cannot correct.

**A MARC-8 record this build cannot decode is STORED, not refused.** The decoder
ships Basic Latin and ANSEL only, so a Greek or Cyrillic MARC-8 record decodes to
U+FFFD with a `marc8-unsupported-charset` anomaly. Refusing would make a Greek
library's ABEKT file unloadable until the code tables ship, which is the opposite
of this product's purpose. Storing means `source_blob` is the surviving truth and
`?fidelity=source` is that record's only correct representation — which is
recoverable, and recorded in `source_encoding` as `marc-8+lossy`.

**`max_books` does not govern the 2.0 catalogue.** It counts `public.books` via
`@RequiresQuota`, which no `/catalog/bib` route carries. Deciding this now rather
than at phase 30 matters, because adding the check later would break every
library that had already imported.

**MARC-8 is not offered as an EXPORT encoding**, for the same reason: this build
would raise `marc8-unencodable` on the majority of a Greek catalogue. UTF-8 with
Leader/09 = 'a' is the only honest ISO 2709 this build can write.

### Decisions worth their sentence

**`source_blob` got `SET COMPRESSION lz4` in its own migration, before the first
ingest.** `ALTER … SET COMPRESSION` does not rewrite existing rows, so 11b — the
column's first writer ever — was the last moment it was free rather than a
`VACUUM FULL` over a 5M-record table.

**`Idempotency-Key` is REQUIRED on the ingest**, unlike every other mutation on
this controller. `marc_records_control_number_unique_active` only constrains
records that HAVE an 001, so a file of records without one has no uniqueness at
all and a retry after a socket timeout would duplicate every record in the chunk.
`pnpm catalog:import` derives the key from the chunk's own sha256, so two
different chunks cannot collide and a retry of the same chunk is exactly what
should replay — the interceptor does not look at the body, so nothing else would
notice.

**A chunk whose last record has no terminator is refused WHOLE.**
`splitIso2709` tolerates an exporter that omits the final terminator, which real
ones do; that tolerance means a file cut at an arbitrary byte offset yields a
truncated last record that parses into something plausible and stores silently.
The library would hold half a book.

**The `.mrc`/`.xml`/`.json` routes are declared BEFORE the plain `GET :id`.**
`:id` compiles to `([^/]+)` and matches `abc.mrc`, so the order is load-bearing;
`@Get(':id([^.]+)')` was the alternative and throws at boot on path-to-regexp 8.
The integration test asserts the `Content-Type` of `.mrc` for exactly this reason.

**The plain `GET :id` closes a hole phase 10 shipped.** `PATCH` requires
`expectedContentHash` and there was no way to obtain one except the response to a
write you had just made. `source.hasSourceBlob` on it is a boolean computed as
`source_blob IS NOT NULL` IN SQL — the blob is never selected, because this is
the hot read that would have defeated the 1:1 split it inherited.

**`EXPORT_FORMATS` and the `ExportFormat` enum now have a test that they agree.**
They are two hand-maintained copies of one fact and the drift is silent in the
worst direction: a value the database accepts and the DTO refuses is a 400 saying
the format must be one of a list the format is on.

**`@libriant/marc/test-corpus` is now a package export.** Three phases outside
`packages/marc` need the only MARC corpus this repo has — 11b's acceptance, 19's
upgrade fixture, 35's coverage report — and a five-level relative import into
another package's `src/__fixtures__` is worse in every way except tidiness.

**The zip reader in `test/integration/unzip.ts` is hand-rolled.** The repo writes
zips and had never needed to read one; adding a dependency for one function is
the trade `check:supply-chain` exists to make deliberate, and the central
directory is forty lines of documented structure. `inflateRawSync` is the
primitive, and it is Node's.

## Phase 12 — the pure resolver

`packages/circ-policy`: ten source files, nine test files, 112 tests, **630 golden
vectors**, zero third-party dependencies, and nothing in it that can read a clock.
No schema change, no service, no route — phase 13 owns all three. This is the
library that decides when a book is due and what a patron owes, written so that a
Rust core in phase 77 can be checked against it byte for byte.

### The acceptance criterion is a test, not a claim

§6 phase 12 says "Pure — no I/O, no `Date.now()`, asserted by test", and
`src/purity.test.ts` is that assertion. It scans every source file for
`Date.now()`, for the argless `new Date()` that is the same clock read wearing a
constructor, for `node:` imports, `process`, `fetch`, `Math.random`, timers,
`async`/`await`, and for any import specifier that is neither relative nor
`@libriant/*` — including the bare side-effect `import 'x'`, which has no `from`
and is exactly how a polyfill or a second tzdb would arrive unnoticed.

The scanner blanks comments and string literals first, walking the file once
rather than reaching for a regex: half these files discuss `Date.now()` at length
in their docblocks, precisely because it is forbidden, and a grep would fail on
the documentation of the rule it enforces.

**Four mutations were injected to prove the scan has teeth** — a `Date.now()`, an
argless `new Date()`, an `import 'typescript'`, and an in-place
`snapshot.rules.sort(compareRank)` — and each was caught by the assertion that
claims to catch it. A purity test that passes because its regex is broken is
worse than no purity test, and there is no way to know which one you have without
breaking it on purpose.

The runtime half is what a source scan cannot see: every snapshot, calendar and
policy is `structuredClone`d and **deep-frozen** before every vector runs. ES
modules are strict mode, so an in-place sort of a caller's array throws rather
than failing silently — which matters because in phase 13 that array is a cached
snapshot shared by every checkout in the process, and the symptom would be a loan
period that differs between two identical checkouts, only under load.

### The vectors are checked against a second implementation, not against themselves

`scripts/build-vectors.ts` computes every expectation with deliberately different
machinery from `src/`:

- **Specificity by bit shift** over the selector list, against `rank.ts`'s named
  weight table.
- **Wall-clock → instant by scanning offset space** — every UTC offset from
  −14:00 to +14:00 in 15-minute steps, 113 probes, keeping those that round-trip
  through `Intl` — against `calendar.ts`'s two-crossing algorithm.
- **Civil arithmetic by stepping one day at a time through `Intl`**, against the
  Hinnant `days_from_civil` integers.
- **Rule resolution by an explicit three-key comparator** with its own in-force
  test, against `compareRank` and `isInForce`.

Two spellings of one rule agreeing is evidence. One spelling agreeing with itself
is a tautology, and it is what most golden-vector suites actually assert. This is
the phase-7 corpus argument applied to time.

The first generator was a four-day linear scan at one-minute resolution and ran
for over ten minutes. The offset-space rewrite, with a memoised formatter, builds
630 vectors in 1.5 seconds — which matters only because a generator nobody runs
is a fixture nobody regenerates.

### The sweep, and the rule that must never win

The resolve vectors were six hand-written narrative cases. Six cases let a Rust
resolver that ignored `shelvingLocationId` entirely pass the file, so they are
now six **plus a sweep**: 64 selector combinations × 3 instants against a wide
rule set, 192 vectors that between them take every branch of the comparator.

Three details make the sweep mean something, and `vectors.test.ts` asserts all
three:

- The sweep's context values are the values the rules actually name (`cat-child`,
  `it-dvd`, `br-b`, `loc-ref`). A sweep over values no rule mentions resolves to
  the wildcard 64 times and proves nothing.
- **Every rule wins at least once.** The priority-50 override originally shadowed
  the maximum-specificity rule at every instant, so specificity 63 — the top of
  the lattice — was unreachable and a resolver that got it wrong would have
  passed. The override now has an `effectiveTo`, so priority beats specificity at
  two instants and specificity wins at the third.
- **`w-c-disabled` never wins**, and it carries priority 999 so that a resolver
  which forgot `enabled` would return it everywhere. A fixture that cannot fail
  is decoration.

### Intl is crossed exactly twice, and that is a measurement

Constructing an `Intl.DateTimeFormat` measured **30.4 µs**; `formatToParts` on a
cached one **3.74 µs**; the integer civil arithmetic that replaced it **0.009 µs**
— **415× cheaper**. So `calendar.ts` crosses into ICU exactly twice per
resolution (instant → civil at the start, civil → instant at the end) and does
everything between them on day numbers, and `purity.test.ts` asserts that no
other file so much as mentions `Intl`. Formatters are memoised in a module-level
`Map`; that is the one piece of mutable state in the package, so a test runs the
whole civil corpus twice and compares, because a memo keyed on the wrong thing is
how a cache stops being referentially transparent.

§7's cut of a date library is what forces this: "a date library is a second,
divergent tzdb — and the Rust core must agree byte-for-byte."

### Five decisions that would otherwise be made twice, differently

**Ambiguous and non-existent wall times both resolve LATER.** A spring-forward gap
has no instant and an autumn fold has two, and the naive local→instant algorithm
silently loses one of the two. The rule is one sentence, and it is written down so
phase 77 does not choose the other one: _every value this package computes is a
deadline, and the later instant gives the patron more time._

**`ROLL_HORIZON_DAYS = 45`.** A Greek library shut 10–20 August, plus the weekends
either side, plus Δεκαπενταύγουστος, can be closed for three consecutive weeks — a
7- or 14-day horizon refuses an ordinary summer loan. Unbounded is worse: a
misconfigured all-closed calendar spins the desk forever. 45 survives August and
still names a number in the refusal.

**Opening hours are an ARRAY of intervals per day, not an open/close pair.** The
Greek split day is 08:00–14:00 and 17:00–21:00. A pair models the afternoon
closure as open, and every "due at close of business" lands three hours late.

**Fines are integer × integer.** `@libriant/shared/money`'s `multiplyRounded` is
half-to-even, so €0.025 becomes €0.02 — correct for allocation, wrong for a rate.
The accrual multiplies a `bigint` minor-unit rate by an integer interval count and
never rounds at all.

**Money crosses the vector boundary as `{minorUnits, currency}`.**
`JSON.stringify({a: 1n})` **throws**, so a `bigint` cannot appear in the fixture
file at all — hence `MoneyJson` beside `Money`, and `toMoney`/`toMoneyJson` as the
only bridge.

### Three defects the tests found

**A two-hour in-library loan came back at 21:00 instead of 01:30.**
`endOfCurrentOpenHours` clamped from the computed due date rather than from the
loan's start, so a loan beginning at 01:30 on a spring-forward night was clamped
into the wrong interval entirely. The fixture was also complicit: an always-open
calendar makes `close: 1440` bite in a way a real one does not, so the policy was
split into `lp-2h` and `lp-2h-inlibrary` and the clamp rewritten to measure from
`from`.

**`previousOpenCivil` used `minute > iv.open` where it needed `>=`,** which made a
loan starting exactly at opening time roll back a day.

**`chargeAt: 'intervalStart'` charged nothing for being one minute late.**
Calendar-day counting is integer, so `Math.ceil(0)` is `0` and the first
partial interval vanished — the rule is `Math.floor(elapsed) + 1`, fixed in the
implementation _and_ in the generator, which had inherited the same reasoning.

### The `id ASC` tiebreak is a collation trap, and phase 13 must not step in it

§3 fixes rank as `priority DESC, specificity DESC, id ASC`, and the `id` tiebreak
is what makes the order total — without it two equally-specific rules resolve
differently on different pods. But the tenant databases collate `el-GR-x-icu`,
and ICU's `id ASC` is **not** JavaScript's `<`: ICU ignores case and punctuation
differences at the primary level, so `r-A` and `r_a` can order differently in
Postgres than they do here.

`rank.ts` documents this and phase 13's snapshot query **must** order by
`id COLLATE "C"`. The resolver cannot detect the divergence — it never sees the
SQL — so the note is the only thing standing between here and a policy that
resolves one way in the API and another way in a report.

### Notice templates invert the weights, and that is the domain

§4.1 gives templates branch 2, category 1 — the inverse of a circulation rule's
category 32, branch 8. It is not an inconsistency. A loan period is a property of
**who is borrowing**: a child gets three weeks, a staff member a term. A notice is
a property of **who is sending** — the branch's name, address, hours and voice are
in the text. A library that has rewritten its overdue letter for one branch means
that branch's letter, even for a category with its own.

`resolveTemplate` returning `null` is also the **one** place in this package where
absence is an answer: a library that configured no `holdExpiring` template has
decided not to send one, and the consequence is silence rather than a wrong
number. Everywhere else, a missing policy is a `PolicyResolutionError` with one of
ten codes — because §4.1's "never fails open to a default policy" is defeated the
moment anything default-shaped is exported, even for fixtures, and the first
`?? DEFAULT` at a call site makes every refusal in the package unreachable. A test
greps the source for one.

### CI would not have run any of this

`.github/workflows/verify.yml`'s node:test step is a **filter list**, and a filter
list is an allowlist: a new package is invisible until the line names it.
Compounding it, `node --test` exits 0 on an empty glob — so 630 vectors could have
passed CI by not existing. The workflow now names `@libriant/circ-policy`, and the
package's `pretest` refuses to run with fewer than nine test files, for the same
reason `@libriant/marc`'s suite asserts its own size.

### Decisions worth their sentence

**`hoursOn` returns the calendar's own array, deliberately.** It is called once
per candidate day while a due date rolls forward, and allocating a copy per probe
buys nothing. The price is that one careless call site rewrites a branch's opening
hours for the life of the process — `duedate.ts` genuinely does reverse this
value, correctly, by spreading first — so `purity.test.ts` greps for a mutating
method applied directly to the return.

**Orthodox Pascha is Meeus's Julian Paschalion plus 13 days, and it throws outside
1900–2099.** The 13-day Julian–Gregorian offset is not a constant; it becomes 14
in 2100. Returning a plausible wrong date for 2100 is worse than refusing, and a
`RangeError` naming the range is what a seeder can act on.

**`fixtures/` is in `.prettierignore`.** The vector file is a cross-language
contract read by `cargo test`; prettier reflows its arrays, so every regeneration
would fail `format:check` on a file nobody edited. Same argument, same wording, as
`docs/api/` and `packages/marc/src/definitions/`: the generator is the formatter
of record.

**`beatenRuleIds` is the rules that matched and LOST**, not every rule of lower
rank. The naive reading returns 499 ids from a 500-rule snapshot on every
checkout, allocated on the hot path and rendered into an explain screen nobody
could read. "Your branch rule beat the tenant default" is what the librarian
asking _why is this due on the 19th_ actually wanted.

## Phase 13 — the policy engine service

Eighteen tables, two Nest modules' worth of service in one (`apps/api/src/policy`),
a snapshot cache with three timescales and three fail postures, a simple-mode
façade, `/circulation/explain`, a preview endpoint, `TenantClockService` and an
ESLint block that stops circulation reading the clock. The two acceptance numbers
were measured: a policy change reaches a second process in **16 ms** against a
budget of 1,000, and resolution over a 500-rule snapshot is **p50 0.024 ms, p99
0.042 ms** against a budget of 0.2.

### The collation trap: phase 12 was right that it exists and wrong about the fix

The phase-12 entry above says "phase 13's snapshot query **must** order by
`id COLLATE "C"`". Phase 13 has no such query, and the reason is worth correcting
in place rather than quietly not doing it.

Measured, on the three collations this code actually meets:

|                                                               | order of `R-default, ckv1a2b3c, r-default, r_default, rdefault` |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| production (ICU `el-GR`, from the compose file's initdb args) | `ckv1a2b3c, r_default, r-default, R-default, rdefault`          |
| this machine's dev cluster (libc `en_US.UTF-8`)               | `ckv1a2b3c, CKV…, r_default, r-default, R-default, rdefault`    |
| `compareRank` (UTF-16 code units, i.e. `C`)                   | `R-default, ckv1a2b3c, r-default, r_default, rdefault`          |

Three collations, three different orders — and the sharpest part is that LOCAL
and PRODUCTION disagree with each other, so a test that pinned the database's
order and passed here would prove nothing about the library it shipped to.

But the SQL order reaches no answer. `resolve.ts` filters into a fresh array and
sorts it with `compareRank`, which is a TOTAL order on distinct ids, so the
winner does not depend on the input order at all — asserted directly:
reversing the array before sorting gives the same ranking. Prisma cannot express
`COLLATE` in any case (`SortOrder` is `{asc, desc}`), so ordering in SQL would
mean hand-writing `lbr2.`-qualified raw SQL for ten tables to buy an order
nothing reads.

So the fix is three things and none of them is the one phase 12 predicted. The
snapshot loader has **no `orderBy`**, and says why. `circulation_rules_resolve_idx`
— which §3 specifies as `(priority DESC, specificity DESC, id) WHERE enabled` —
is **not created**: measured at the 500-rule acceptance size, the planner never
chose it, and forcing it read **403 buffers against 5** for a sequential scan and
sort, because a whole-table read through a btree is random-order heap access. And
where SQL order does reach a human — the matrix listing, `/circulation/explain`'s
neighbours, a phase-26 report — the query says `id COLLATE "C"` and
`circulation_rules_listing_idx` serves it, because a UI that lists rules in a
different order than the engine ranks them is the same bug wearing a different
hat.

The one thing that did NOT survive contact with measurement: generated cuids
cannot diverge at all. The whole `[0-9a-z]` alphabet orders identically under all
three, exhaustively. The trap is real for a seeded, imported or human-chosen id —
`rule-default`, which this phase creates, is exactly one of those — and
theoretical for anything Prisma generates.

### `circulation_policy_version` is bumped by seventeen triggers, and each word is load-bearing

§4.2 argues the changelog must be trigger-written because "a forgotten `emit()`
silently breaks replicas and the index forever". Here it is worse. A forgotten
bump means every pod keeps its cached snapshot; the thirty-second backstop
re-reads the counter, sees no change, and keeps the stale cache — not for thirty
seconds, **for ever**. The librarian edits the loan period, the screen says
saved, and every checkout that week is priced by the old one.

The surface a trigger has to cover is also larger than the changelog's: this
phase's service, the simple-mode façade, a phase-30 importer, phase 19's
copy-forward (PL/pgSQL, which never touches the application), a seed script, and
a support engineer in `psql`.

Four measurements settled the shape:

**`FOR EACH STATEMENT`.** A 40-row `UPDATE` fires a row trigger 40 times and a
statement trigger once — 40 dead tuples and 40× the WAL for one librarian's edit,
counting ROWS TOUCHED rather than POLICY STATES. Asserted: a multi-row update
moves the counter by exactly 1.

**A statement trigger fires on zero affected rows**, so `UPDATE … WHERE id =
'typo'` bumps the version. That is over-invalidation, and it is free to accept
because the requirement is one-directional: a different policy state MUST get a
different version, while a different version need not mean a different state. A
spurious bump costs one snapshot rebuild.

**`OR TRUNCATE` is in every one.** `TRUNCATE circulation_rules` emits ZERO change
events — the changelog is row-level and cannot see a truncate — so without it the
version would not move either and every pod would serve the deleted matrix for
ever, fully populated and completely wrong. With it, every pod rebuilds and the
resolver refuses to lend. Refusing is correct.

**`version = version + 1` needs no lock of ours.** Two concurrent bumps from 1
give **3, not 2**: Postgres's ReadCommitted UPDATE re-check re-fetches the newly
committed row and re-evaluates the expression against it, the same mechanism that
makes `SET balance = balance + 100` safe. A read-then-write in application code
is what loses that update, and is the concrete reason the bump is not in a
service. Asserted, along with the fact that a rollback takes the bump with it.

`integer`, not `bigint`: Prisma maps `BigInt` to a JS `bigint` and
`JSON.stringify({version: 1n})` **throws**, and this number lands in
`loans.policy_snapshot jsonb` on every checkout. Not a timestamp either —
`pg_catalog.now()` is TRANSACTION START time, so a long transaction that commits
second stamps first and a cache doing "rebuild if stored > cached" never rebuilds
again.

### All sixteen new content tables are `@replicated`, and the `fees` argument inverts

`fees` is excluded from the changelog because "the overdue-fine sweep touches
every accruing fee every night, so a trigger here would be the single largest
producer in the feed — and no consumer reads it yet". Every clause of that
reverses. These tables are written by a librarian in an admin screen and the whole
set changes less in a year than `fees` changes in a minute. Consumers exist
today: `PolicySnapshot` is a CLOSED value whose fields map onto exactly these
tables with nothing left over, so a device missing any one of them does not lend
with a slightly wrong due date — §4.1 forbids failing open, so it raises
`POLICY_NOT_IN_SNAPSHOT` and refuses to lend. And the asymmetry points the other
way: turning a firehose off after a fleet has consumed it is expensive, but a
fleet shipped WITHOUT policy replication cannot resolve offline at all and needs a
fleet-wide re-seed rather than a one-line migration.

Every one is `branch = false`, **including `circulation_rules`**, and that is a
requirement rather than a shortcut. A rule has three branch columns and no single
owning branch; setting `change_events.branch_id` from `owning_branch_id` would
look tidy and would break floating collections and ILL, because a device at
branch B checking out an item OWNED by branch A must match the rule scoped
`owning_branch_id = 'A'`, and a branch-filtered consumer would never receive it.

`circulation_policy_version` and `circulation_settings` are NOT replicated: the
counter is bumped by every one of the seventeen triggers, so replicating it would
emit two events for every policy edit.

### The snapshot cache: three timescales, and a third posture no other cache here has

`freshnessMs` (250 ms) bounds a LOST pub/sub message while Redis is healthy —
without it the 1-second criterion is met on good days only. `ttlMs` (30 s) is
§4.1's stated backstop and bounds staleness while Redis is down. `staleCeilingMs`
(15 min) bounds staleness while the tenant database is down, past which the
service **refuses**.

That third posture is the one that needed arguing, because "never fails open"
reads like "refuse whenever unsure":

> A DEFAULT POLICY is a value no librarian ever wrote. The receipt in the
> patron's hand then states a rule that is not this library's rule, and nothing
> in the row distinguishes it from a real resolution.
>
> A STALE SNAPSHOT is a value the library DID write, which was in force at a real
> identifiable instant. `RuleTrace.snapshotVersion` names which one and
> `loans.policy_snapshot` freezes it into the row, so a loan priced by version 41
> forty seconds after version 42 was published is exactly a loan taken forty
> seconds earlier. The failure is LATENESS — bounded, observable, attributable.
> The other is FABRICATION.

So: holding a snapshot and unable to confirm it, serve and warn; holding nothing,
refuse with a 503. The case the stale serve earns its keep in is the PARTIAL
outage — pool exhaustion, a long lock, a three-second failover — where the write
succeeds on retry and only the policy read had bad luck.

**A missing version row is a refusal by name, not version 0.** Zero never
changes, so a library whose counter row was gone would run for ever on a snapshot
no bump could invalidate, on every pod, and nobody would find out. Note the
deliberate asymmetry with `PermissionsService`, which resolves a missing Redis
version key to `'0'` — safe there because it is only a cache-key discriminator
and can never produce a wrong permission.

### No second Redis connection, and the reason usually given for one is false here

The standard advice is that a subscribed ioredis connection accepts only
subscribe-family commands, so pub/sub needs its own socket. **Measured against
the running container with the exact options `RedisService` uses**: ioredis 6
defaults to `protocol: 3`, RESP3 has no restricted subscriber mode, and after
`subscribe('lbr:policy:bump')` the same client returned `GET` → `v1` and
`PUBLISH` → `1` and delivered its own message. So the subscription lives on the
shared client and the process opens no new socket.

The channel carries `lbr:` **literally**, because `keyPrefix` is applied only to
arguments a command declares as keys and `PUBLISH`/`SUBSCRIBE` declare none.
(`SPUBLISH` does declare one, so reaching for sharded pub/sub later would
silently desynchronise publisher and subscriber.)

**The announce happens AFTER the commit**, and the alternative is subtle enough
to be worth stating. Publishing inside the transaction lets a subscriber react
before the commit, read the PRE-CHANGE rows on its own connection, and cache them
stamped with the NEW version — after which every freshness check agrees and the
pod serves the old policy under the new number until the TTL, making
`RuleTrace.snapshotVersion` a lie in exactly the case it exists for. Announcing
after commit trades that for losing the notification if the process dies in
between, which is what the backstop is for.

### The wildcard guard is in the service, and the database genuinely cannot do it

`circulation_rules_default_singleton` forbids a SECOND enabled wildcard and says
nothing about removing the last one. A deferred `CONSTRAINT TRIGGER` counting the
survivors at commit would close delete, disable and expire — but measured on PG
16.15, `CREATE CONSTRAINT TRIGGER … AFTER TRUNCATE` is rejected outright (`FOR
EACH ROW` is unsupported for TRUNCATE and `FOR EACH STATEMENT` is a syntax error
there), so `TRUNCATE circulation_rules` would still empty the table. A guard that
closes three doors of four, at commit time, with an error Prisma surfaces as a
generic transaction failure, is not better than a typed refusal in the one
service that owns the table.

There are FOUR ways to retire the wildcard, not two, and all four are refused:
delete, `enabled = false`, an `effective_to` in the past, and — the sharpest —
an `effective_from` in the FUTURE, which satisfies both partial unique indexes,
reads as perfectly configured in the editor, and makes every checkout until that
date raise `NO_MATCHING_RULE`.

The fourth door, `TRUNCATE`, is left to phase 16's `REVOKE TRUNCATE`, and the
bump triggers mean that if anybody does truncate the table every pod rebuilds
within a second and the desk refuses to lend rather than serving a matrix that no
longer exists.

### One message keyed on the input rather than on the constraint that fired

A second wildcard violates `circulation_rules_scope_unique` FIRST — two wildcards
have identical all-empty scopes, so `circulation_rules_default_singleton` never
gets to report it. Keying the message on the constraint name told a librarian who
had tried to add a second default rule that "another rule already covers exactly
this combination of conditions": true, and not what they needed to hear. The test
caught it, and the fix was to decide from the six selectors in the request.

### Decisions worth their sentence

**The enum labels are the TypeScript literals, camelCase and all** —
`endOfPreviousOpenDay`, not `end_of_previous_open_day`. `loans.policy_snapshot`
freezes these values verbatim, `fixtures/resolution-vectors.json` carries them to
`cargo test`, and phase 77's Rust core reads both; a database label that differed
would need a translation table maintained in two languages, and a translation
table with one wrong row is a loan policy that silently becomes a different one.
The snake_case gate reads the first quoted token of a column line — the column
NAME — and never sees an enum label, so this costs nothing there.

**Money is spelled `_cents` even though "cents" is wrong for JPY and KWD.**
`check:schema-conventions` keys on `/_cents$/`, so a column named
`amount_minor_units` would be invisible to BOTH halves of the money rule, and the
first policy money column in the schema would be the one that escaped the gate
money has a gate for.

**One `currency` column per table, not one per amount**, and that is correct
rather than tolerated: `@libriant/shared/money` refuses a currency mismatch on
every operation, and every consumer of a hold policy adds `placement_fee` and
`not_picked_up_fee` to one patron account — so a policy whose two fees are in
different currencies is not a policy anyone can charge. One column makes it
unrepresentable instead of unpayable.

**Twelve `(value IS NULL) = (unit IS NULL)` CHECKs, one per duration pair.**
`addDuration` ends `const step = period.unit === 'weeks' ? 7 : 1`, so a NULL unit
is silently priced as DAYS and a two-hour reserve becomes a fortnight's loan —
§4.1's "never fails open" defeated before the resolver runs. A Postgres
`interval` would have made the pair atomic and cannot carry the civil/elapsed
distinction (`'3 weeks'` normalises to `21 days`); a composite type would have
worked and is `Unsupported` in Prisma.

**`calendars` is keyed by BRANCH id in the snapshot.** `Calendar` carries a
timezone and the table has no timezone column, because the zone belongs to the
branch and one calendar legitimately serves several. A `Calendar` value is only
meaningful once a branch has supplied the zone.

**`circulation_settings`, not `tenant_settings`, and not a plan feature.**
`EffectivePlanService.unlimitedPlan` rewrites every plan boolean to TRUE whenever
`BILLING_ENABLED` is false — the configuration this product ships — so a
plan-gated `circulation_rules_enabled` would be ON for every library, the exact
inverse of §8 risk 6's "simple mode is the DEFAULT". `PlanGuard` also answers 402
Payment Required, and a five-person school library that has not asked for a rules
matrix has not failed to pay. `tenant_settings` stays deferred: phase 13 needs one
boolean, not a cross-cutting singleton whose other columns belong to undesigned
phases.

**Turning the matrix OFF is refused while rules with conditions exist.** Simple
mode shows one form describing the wildcard and no way to see the others — which
would go on deciding loan periods and fines invisibly. Deleting them silently is
worse: they are the library's configuration.

**No metric, and that is a decision.** A refusal here stops a desk lending, which
is the shape of thing that usually earns a counter. `check:alerts` enforces both
directions, `SOURCES.api.files` would have to widen past `apps/api/src/platform`,
and the worker builds snapshots too but serves its own `/metrics` — so a
half-wired counter would under-report exactly the critical case while looking like
coverage. All three postures log instead, at the severity each deserves. Phase 23
owns the operations console and is where this belongs with an alert beside it.

**No calendar seeder.** `packages/circ-policy` exports
`greekCalendarExceptionsForYears`, and phase 13 does not call it. Phase 13's
acceptance criteria mention calendars nowhere; §6 phase 23 owns "calendars/hours/
exceptions UI". The seeded loan policy uses `closedDayHandling: 'keep'`, so a
library with no calendar computes due dates without one and nothing refuses. A
seeder that invented a Greek municipal library's opening hours for a school
library that has none would be phase 23's job done badly and early.

**A `defineMetric`-free phase still touched `docs/api/openapi.v1.json`**, because
§4.5 makes OAuth scopes "a projection of permission keys, never a parallel
vocabulary" — so adding `circ.policy.read` and `circ.policy.manage` to the catalog
adds them to the published contract, and `check:openapi` fails until it does.

**The census fixture gained a regenerator, and a whitespace collapse it needed
all along.** `pg_get_constraintdef` pretty-prints anything with a `CASE` across
several lines — `circulation_rules.specificity` has six and
`loan_policies_profile_complete` has three — and the fixture is compared line by
line, so one constraint arrived as eleven fragments, six of which were the string
`ELSE 0`. The census now collapses whitespace per object, and `LBR_WRITE_CENSUS=1`
rewrites the fixture and then fails the run, so a regeneration can never be
mistaken for a pass. 144 lines became 287.

### The trap that cost the most time, and is not in any file

**There are two Postgres 16.15 clusters on this machine**, and `localhost:5432`
is the Homebrew one while `docker exec libriant-postgres psql` reaches the
container. Prisma, the app and the tests all use the Homebrew server; every
`docker exec` verification query in this session was reading a different database
and reported an empty schema for a migration that had applied perfectly. It is
already in the memory file as a gotcha and it was still worth an hour, because
the symptom — "the migration says it applied and the tables are not there" —
looks exactly like a failed migration.

It also matters for the collation finding above: the container was initdb'd
`--locale-provider=icu --icu-locale=el-GR` (which is what production gets) and the
Homebrew cluster is libc `en_US.UTF-8`, which is why the measurement above has
three rows and not two.

## Phase 14 — Patrons 2.0

Ten new tables plus the columns the baseline left off `patrons`, `apps/api/src/patrons`,
two permission keys, a `v2-patrons` smoke module, and a coverage map that stands
in for a gate nineteen phases away. The two hardest acceptance criteria were
settled by measurement before a line was written, and both measurements are in
the code.

### The block race, and the finding that was not in the phase line

§3 says `patron_blocks` gets the analogue of `fines_one_outstanding_per_loan`
"so block recalculation is an `INSERT … ON CONFLICT DO UPDATE` and a sweep racing
a desk transaction settles in Postgres instead of aborting the librarian's
checkout". Measured, 25 concurrent sweeps against one patron while a desk
transaction holds it, 20 iterations per row:

| desk lock           | recompute            | desk     | sweeps  | loans | dupes |
| ------------------- | -------------------- | -------- | ------- | ----- | ----- |
| advisory            | `ON CONFLICT`        | 20/20    | 500/500 | 20    | 0     |
| advisory            | `DELETE`+`INSERT`    | 20/20    | 272/500 | 20    | 0     |
| `FOR UPDATE`        | `DELETE`+`INSERT`    | **0/20** | 20/500  | **0** | 0     |
| `FOR UPDATE`        | `ON CONFLICT` (cold) | **0/20** | 476/500 | **0** | 0     |
| `FOR NO KEY UPDATE` | `ON CONFLICT`        | 20/20    | 500/500 | 20    | 0     |

Two separate things live in that table and §3's sentence conflates them. The
INDEX is what makes duplication impossible — `dupes = 0` in every row, including
the `DELETE`+`INSERT` one. The `ON CONFLICT` is what makes the librarian's
transaction survive.

**The finding the phase line does not contain is that the desk's
`SELECT … FOR UPDATE` is itself the poison.** `patron_blocks.patron_id`
references `patrons`, so every genuine block INSERT runs the FK check, which
takes a `FOR KEY SHARE` tuple lock on the patron row — and that lock plus a desk
`FOR UPDATE` on the same row deadlock. Twenty librarians' checkouts destroyed,
`loans_written = 0`. An advisory lock does not participate in the FK row-lock
graph at all, which is a direct vindication of `platform/locks.ts` and a rule
worth stating for every later phase: **the patron desk pin is
`pg_advisory_xact_lock`; if a row lock is ever genuinely wanted on `patrons` it
must be `FOR NO KEY UPDATE`.**

Two more that shape the code. At REPEATABLE READ, `ON CONFLICT DO UPDATE` onto a
concurrently-updated row raises `40001` and the desk aborts 15/15, so every
writer pins `ReadCommitted` explicitly. And the `ON CONFLICT` inference is
unforgiving in a way that reports every mistake identically: the clause must
IMPLY the index predicate, so dropping the `WHERE` is `42P10`, weakening it to
`WHERE auto_generated` is `42P10`, and
`ON CONFLICT ON CONSTRAINT patron_blocks_one_auto_per_code` is `42704`, because a
partial unique INDEX is not a CONSTRAINT and can never be named that way.

The suite reproduces the whole thing: **desk committed, 0/25 sweep failures.**

### One hop needs a trigger AND sorted locks — neither alone

The database refuses a chain through `lbr2_patrons_merge_one_hop`, a deferred
constraint trigger with TWO clauses. Clause (a) — "my survivor must be terminal"
— never fires on the transaction that CREATES the chain: when A is merged into C
it is A's row that changes, A's survivor C is terminal, and the row that is now
wrong is B, which nobody touched. Clause (b) catches B.

That is not enough. 60 concurrent pairs where T1 merges B into A while T2 merges
A into C:

```
trigger only, no locks    59 of 60 chains formed
trigger + sorted locks     0 of 60
SERIALIZABLE               0 of 60, and a 40001 on one side of every pair
```

Each transaction's deferred check passes on a snapshot that cannot see the
other's uncommitted row. The locks are sufficient because any two merges that
could form a chain necessarily share the middle patron — B→A and A→C both name A
— so patron-keyed locks always serialise them. And they must be SORTED: two
operators merging the same pair in opposite directions gave `{40P01: 8, 23514: 4,
committed: 12}` in caller order against `{23514: 12, committed: 12}` through
`orderLocks`. Sorting converts a random deadlock into a deterministic refusal the
librarian can be shown.

**What a chain costs is not latency.** Measured on 200,000 patrons with a
deliberately built 10-deep chain: the one-hop lookup is a fixed 12 buffers and
0.026 ms whatever the depth, and on the chained record it returns `p00000102`
where the survivor is `p00000111`. A chain does not make the card scan slow — it
makes it silently WRONG, and the desk then charges the loan to a record with no
cards, no blocks and a balance nobody sees. That is the argument for enforcing
the invariant on the write side rather than making every reader recursive, and it
is why the desk query is a two-join `LEFT JOIN` and not a `WITH RECURSIVE`.

The trigger REFUSES rather than repairs. Silently re-pointing the stranded row
would hide the merge-service bug that left it behind — §8's reasoning about the
ledger drift job alerting instead of self-healing, applied here.

### perf-13, and the index that phase 13's precedent would have got wrong

The acceptance line asks for "`patrons_number_pattern_idx` with
`text_pattern_ops`". Measured on 50,000 rows where the prefix selects 10%:

| collation          | plain btree                       | `text_pattern_ops`    |
| ------------------ | --------------------------------- | --------------------- |
| C                  | Bitmap Index Scan, 21 idx buffers | same                  |
| libc `en_US.UTF-8` | **Seq Scan, 319**                 | Bitmap Index Scan, 21 |
| libc `el_GR.UTF-8` | **Seq Scan, 319**                 | Bitmap Index Scan, 21 |
| ICU `el-GR`        | **Seq Scan, 319**                 | Bitmap Index Scan, 21 |

With `enable_seqscan = off` the three non-C databases STILL seq-scan: there is no
index path at all, not a costing preference.

**Phase 13's `COLLATE "C"` precedent is the wrong thing to copy here, and it took
a measurement to see it.** As the only index on the column, `COLLATE "C"` serves
`LIKE 'M-2026-%'` and **seq-scans `patron_number = $1`** — 49,999 rows removed by
filter — because the equality's collation comes from the column and does not
match the index's. `text_pattern_ops` serves both: it carries the ordinary
`=(text,text)` at btree strategy 3, checked in `pg_amop`. So there is no third
index for equality.

There are still TWO indexes and they cannot be one. Uniqueness must be PARTIAL
(`WHERE archived_at IS NULL`) so an archived card's number is re-issuable, but
the counter seed must SEE archived numbers — an archived patron keeps the number
printed on their card — and a partial index's predicate is not implied by an
unqualified query: Seq Scan at 337 buffers against 21. So the pattern index is
separate and deliberately not partial.

A correction the phase line carries and this entry does not: **the tenant
collation is no longer `el_GR.UTF-8`.** `docker-compose.prod.yml` now initdb's
`--locale-provider=icu --icu-locale=el-GR --locale=C.UTF-8`, so `datcollate`
reads `C.UTF-8` and a guard grepping for `el_GR` gets a false negative. The
behaviour is identical — any non-C collation defeats a plain btree — so the test
asserts "not C" rather than a literal, which is what keeps it true after the next
locale change.

One hard boundary found while measuring: `text_pattern_ops` REFUSES a
non-deterministic collation outright ("nondeterministic collations are not
supported for operator class"), and so does `LIKE`. A case-insensitive patron
number or barcode is not merely slower here, it is unimplementable with the index
the desk scan depends on — which is why `patron_cards.barcode_norm` is
upper-cased and has a CHECK saying so.

### Minting: correct, and two ways to make it slow

25 clients × 40 mints gave 1,000 distinct contiguous sequences — zero duplicates,
zero gaps, zero deadlocks, zero rollbacks. A single-row counter cannot deadlock:
that needs two lockables acquired in two orders, and there is one.

Both failure modes are about WHERE it runs, not whether it works. Minting inside
a 5 ms transaction body is 23.7× slower (187 ms against 7.9 ms, 134 tps against
3,163) because the counter's row lock is then held for the whole transaction and
every enrolment queues behind the slowest one. Minting inside a REPEATABLE READ
transaction fails 94.8% of the time with `40001`. So `mintPatronNumber` takes the
bare client rather than a `TxV2`, and the signature is the thing that refuses.

The number is also WIDER than 1.0's. 1.0 pads to four digits as a MINIMUM, so a
library past 9,999 gets `M-2026-10000` and the column stops sorting numerically
for ever. Widening later renumbers nobody and leaves a mixed-width column, so it
had to be now: six digits, fixed width.

### Balances are rows, and the negative assertion is the test

§6 asks that "balances sum per currency". Phase 18 owns the ledger and nothing
writes `lbr2.fees` yet, so what phase 14 owes is the SHAPE — and the shape is
`SELECT currency, SUM(outstanding_cents) … GROUP BY currency`, a set of rows and
never a scalar. A patron with €774, £640 and $710 has three balances; the
currency-blind version returns **2124**, which is a number of nothing, and the
suite asserts it as a negative so the API can never be able to produce it.

`fees.patron_id` carries NO foreign key until phase 9d, so nothing at the
database level catches a merge that forgets the fees: the money simply points at
a record nobody looks at and vanishes from the survivor's balance. Until that FK
exists, the suite's `orphaned_money = 0` assertion IS the constraint.

### `check:dsar-coverage` does not exist, and that is a problem phase 14 owns

§5's compliance row promises it "makes it structurally impossible for a new
patron-referencing table to escape the subject-access bundle", and assigns it to
phases 33 and 96. Phase 14 takes the number of patron-referencing tables in
`lbr2` from ONE — `loans.patron_id` — to eleven.

A gate written at phase 33 protects tables twelve onward. It cannot
retroactively catch a table phase 14 forgot; it can only freeze the forgetting,
because it will be written against whatever coverage map exists then and will
bless whatever this phase happened to do.

So `patron-data-map.ts` is the thing a later gate consumes: every table with a
patron column, a verdict of `in_bundle` / `excluded` / `pending`, and a required
reason on the last two — the property `check:schema-conventions` already
establishes, that "an entry that stops matching anything FAILS". Three tests hold
it honest today: every `lbr2` table with a patron column is in the map, every
non-`in_bundle` entry has a reason, and every entry claiming to exist really
does. At phase 33 the gate is about forty lines.

The `excluded` verdicts are decisions and read as such. `audit_log` is out
because it is the record of what STAFF did, which the library needs precisely in
order to show that an erasure was carried out — erasing the evidence of an
erasure is the one deletion Article 17 cannot mean. `change_events` is out
because §5's cascade to device replicas is phase 78 and there is no fleet to
cascade to, which is recorded so the obligation is inherited rather than the
omission.

### Three things the database and the tests found in the code

**A deterministic block id was a bug.** `pb_<patron>_<code>` reads well and would
collide on the PRIMARY KEY the first time a block was cleared and came back —
which the `ON CONFLICT` does NOT catch, because it infers the partial unique and
not the pkey. The sweep would have started failing with `23505` the first time a
librarian lifted a block. The id is generated server-side.

**Card collisions in the merge were dead code.** Eleven lines carefully retired a
loser's card when the survivor already held that barcode — and
`patron_cards_barcode_unique_live` is LIBRARY-WIDE, not per patron, so two live
cards never share a barcode and the state was unreachable. The test that tried to
construct it was refused by the index, which is how it was found. Identifiers and
primary addresses are the opposite case: their uniques are scoped per patron, so
two records for one person legitimately hold the same ΑΦΜ — which is precisely
what a duplicate record IS — and those collisions are real and resolved before
the move.

**`patrons_number_unique_active` already existed.** The baseline created it in
phase 9, before anything minted a number, and the migration was written with both
indexes; Postgres refused the second with `42P07`.

### Decisions worth their sentence

**`archived` is not a `PatronStatus`.** 1.0's enum has it, and it is doing two
jobs — a status AND the soft-delete column — which lets a row be
`status = 'active'` with `archived_at` set, a state no screen can render
honestly. `archived_at` is the archive; the enum holds the choices a librarian
actually makes. `expired` is absent for a different reason: a status that has to
be swept nightly to stay true is wrong every night until the sweep runs, so it is
derived from `expires_at`.

**Cards, identifiers and addresses moved OUT of the row.** 1.0 holds one address
inline and cannot record a second card at all, which is the first thing a library
with a lost-card policy needs. And an ΑΦΜ, an ΑΜΚΑ and a student number are three
different disclosures with three different retention arguments; as columns they
would be three nullable fields nobody could audit, and as rows they are a list a
bundle can render and an erase can delete.

**`patrons.staff_notes` survives beside `patron_notes`.** A one-line "prefers
large print" is not a dated, attributed note, and forcing it to be one is how a
field stops being used and the information moves into the name.

**`patron_relationships` is directional.** The row reads `from` IS THE `kind` OF
`to`. A symmetric pair needs two rows kept in step and gives no answer to "who is
the adult here?", which is the only question the guardian case asks. Phase 33
owns the Greek digital-consent age of 15 and the double opt-in; `confirmed_at` is
here so it has somewhere to write, and phase 14 never sets it.

**`reading_history_policy` is created and never read.** §3 puts the
null-and-stamp "in the same transaction as the return", phase 16 owns that
transaction, and a phase-14 anonymisation would have no caller. What phase 14
owes is that the default exists on day one — `anonymised`, inserted by the
migration — because §3's "a DEFAULT rather than a setting someone forgot to turn
on" is only true if the row is there for every tenant, including the ones phase
19's PL/pgSQL creates.

**The smoke test caught the fill-out.** `seedMinimalChain` inserted a patron with
`(id, updated_at)` because `patrons` was a skeleton; three NOT NULL columns later
it broke seven modules at once. A table that stops being a skeleton breaks every
fixture that relied on it being one, and the fixture is where you find out.

---

## Phase 15 — items, holdings, call numbers

Four tables (`item_status_reasons`, `item_status_history`, `item_transfers`,
`item_notes`), two skeleton fill-outs the baseline assigned to this phase by
name, two partial uniques, one service that is the only writer of two columns,
and the two gates that make that last claim mean anything.

§6's acceptance clause is five sentences and each one is a test in
`apps/api/test/integration/items.spec.ts`. What follows is what had to be decided
to make them true.

### The single-status-writer boundary needs TWO gates, and the reason is provable

"`items.status` is writable through exactly one service (ESLint boundary rule + a
grep gate)" reads like belt and braces. It is not. Each gate is blind to a
surface the other covers, and the blindness is structural rather than
incidental.

ESLint sees ASTs. `no-restricted-syntax` can match
`<x>.item.update({ data: { status } })` on the member path — so `tx.item.update`
is caught, `tx.loan.update({ data: { status } })` is not, and a `where: { status }`
clause is untouched because reading a status to find a copy is not writing it.
All three discriminations are asserted by a break test. What it cannot see is
`tx.$executeRaw\`UPDATE lbr2.items SET status = …\``: a template literal has no
structure a selector can reach, and this repository writes raw SQL deliberately
and often — `patron_blocks`mints ids in it,`is_shelf_available` can only be
READ in it, and this phase's own holdings upsert is raw because a Prisma unique
violation aborts the whole interactive transaction.

`scripts/check-item-status-writer.ts` reads text, so it covers exactly that, plus
the trees ESLint's `apps/api/src/**` block does not lint at all — the worker and
`scripts/`.

A DATABASE CANNOT DO EITHER. There is no trigger, grant or rule that expresses
"only this function may issue this UPDATE": every writer connects as the same
role, and a `BEFORE UPDATE` trigger sees the row and not the caller. A trigger
COULD write the history row itself — that is precisely the shape §4.2 chose for
`change_events`, on the argument that a forgotten `emit()` is invisible — and it
is deliberately not the shape here. A trigger sees a status column changing and
cannot see `reason_id`, `note`, `cause_type` or `source`, which are the four
columns a librarian actually reads. And the value of a boundary is that a stray
write FAILS review, not that it is silently repaired into something plausible.

**The break test found a real bug in the grep gate**, which is the argument for
having one. The first pattern was
`update\s+(?:[a-z_]+\.)?items\b…` — and the schema is named `lbr2`, with a digit.
So it matched `UPDATE items` and missed `UPDATE lbr2.items`, the only form this
codebase ever writes. The gate reported "0 violations" over a file containing
one. It also then caught itself: its own docblock quotes the statement it looks
for. That is an allowlist entry with a reason rather than a weakened pattern,
because the example is what makes the rule legible.

**The exemptions are scoped in two directions rather than one**, copying phase
13's clock ban exactly. `item-status.service.ts` IS the writer and is exempt from
everything. `items.service.ts` may establish `current_branch_id` and
`status_since` ON CREATE and may never move them — which is forced rather than
generous: `items.current_branch_id` is NOT NULL with no default, so a copy cannot
be created without naming where it is. `status` stays banned there even on
create, because the column defaults to `available` and a create that named
anything else would be a transition wearing an insert.

**And a flat-config trap that would have been silent.** A later `files:` block
REPLACES a rule's options for the files it matches, so putting
`apps/api/src/**/*.ts` after the phase-13 `apps/api/src/policy/**` block would
have switched the clock ban off in `policy/` — or, in the other order, switched
the item boundary off in `policy/` and `circulation/`, the two directories most
likely to move a copy. The item blocks come first and the circulation blocks
carry `...ITEM_STATE_WRITES` forward explicitly.

### "Open" is the absence of both endings, and the enum is not a style preference

`item_transfers` has no `state` enum. The obvious design — `state transfer_state
NOT NULL DEFAULT 'open'` with a partial unique `WHERE state = 'open'` — was built
beside this one on the same 200,053 rows (50 open: the real shape, because almost
every transfer a library has ever made has arrived) and asked the only question
the desk asks, in the form Prisma emits:

```
  NULL predicate,  parameterised   Index Scan,             2 bufs,  0.011 ms
  enum predicate,  parameterised   Parallel Seq Scan,   1470 bufs,  5.922 ms
  enum predicate,  seqscan = off   Seq Scan,            1470 bufs,  7.573 ms
  enum predicate,  LITERAL         Index Scan,             2 bufs,  0.016 ms
```

The last two lines are the whole argument. With `enable_seqscan = off` the
parameterised enum STILL seq-scans — there is no index path, it is not a costing
preference — while the same query written with a literal uses the index. **So the
shape that is fast when a developer tries it by hand in psql is the shape that
reads 200,000 rows in production.** `enum_in` is only STABLE, Prisma emits
`state = CAST($1::text AS transfer_state)`, and the planner can never prove the
predicate. This is the fifth time that wall has been hit here:
`loans_active_dueAt_idx` (1.0), `items.is_shelf_available`,
`patron_blocks_live_idx`, `patron_cards_barcode_unique_live`, and now this.

The second consequence is worse and splits the same way. `ON CONFLICT (item_id)
WHERE state = 'open'` INFERS the arbiter; `WHERE state = CAST($3::text AS
transfer_state)` raises `42P10 — there is no unique or exclusion constraint
matching the ON CONFLICT specification`. Both measured. The upsert works by hand
and fails from the application, which is the worst possible place to find out.
The NULL-predicate arbiter parameterises and infers.

The third is forward-looking: a three-value enum has to be widened the moment
phase 23 adds "queued at the send desk but not yet in the van", and `sent_at IS
NULL` already expresses it.

**`item_transfers_one_ending` is what makes the partial unique mean what it
says.** Without a CHECK forbidding `received_at` and `cancelled_at` together, a
row carrying both is excluded from the index by either, and a second open
transfer slips through the constraint that is the phase's acceptance criterion.

### The copy stays at the SOURCE branch for the whole transfer

`items.current_branch_id` flips at RECEIPT, in the same transaction that stamps
`received_at`, and this is forced rather than tidy. `items_shelf_order_idx` is
`(current_branch_id, call_number_sort, id)` — it IS the shelf list at a branch —
so flipping at send would put a copy on the destination's shelf list while it is
on a van, and a librarian would walk to a shelf to fetch a book that is not in
the building. Availability would not catch it, because `is_shelf_available`
requires `status = 'available'` and `in_transit` fails that.

The second thing it buys only shows up on the cancel path: a cancelled transfer
has NO branch to put back, because the copy never left. Under flip-at-send, every
cancellation is a two-column repair with a window in which the copy is somewhere
it has never been.

### `is_default` is the narrowest claim auto-creation needs

§3 makes `items.holdings_record_id` NOT NULL and calls that "costless by
auto-creating a default holdings record on first item". Costless it is; free it
is not: measured, 25 concurrent creates of the first copy of one title at one
branch with the obvious SELECT-then-INSERT produced 25 holdings records, every
run — which is exactly the shape of a cataloguer importing a batch.

The tempting fix is a UNIQUE on `(bib_id, branch_id)`. Phase 11 refused it and
was right to: a branch legitimately holds one title in several MFHDs — reference
and stacks, large-print beside ordinary, a serial whose bound volumes and current
issues carry different 852 $b. Auto-creation never needed that claim. It needs
"at most one AUTO-CREATED DEFAULT per (bib, branch)", which is strictly narrower,
is true, and is an index predicate.

`DEFAULT false` on the column is therefore load-bearing: with `DEFAULT true` the
phase-11 smoke assertion that a branch may hold one title in two MFHDs would
collide on the new index, and the freedom phase 11 argued for would have been
taken away by the column added to leave it alone.

Three mechanisms guard the create, and all three are deliberate. The advisory
lock on `bib:<id>` serialises it (and `bib` outranks `item` in
`LOCK_DOMAIN_RANK`, so phase 16 taking both cannot deadlock against this path).
`ON CONFLICT … DO NOTHING` holds even if a future caller forgets the lock. The
re-SELECT is correct at ReadCommitted because speculative insertion makes the
conflicting inserter WAIT for the other transaction to resolve. **A raw statement
rather than `prisma.holdingsRecord.create`, and that is forced**: a unique
violation inside a Prisma interactive transaction aborts the whole transaction —
there is no per-statement savepoint — so catch-then-select cannot work there at
all. It only looks like it does outside a transaction.

### No `SELECT … FOR UPDATE`, because phase 14 already paid for that lesson

A transition is read-then-write: the history row names the status the copy was
in. The exclusion is an advisory lock taken as the first statement, not a row
lock — `item_status_history` foreign-keys to `items`, so inserting the history row
takes `FOR KEY SHARE` on the same item row, and a concurrent transaction holding
`FOR UPDATE` on it blocks that insert. Measured on `patrons` in phase 14, the
equivalent shape gave 0/20 desk commits and zero loans written. An advisory lock
does not join the row-lock graph at all.

`ItemTransfersService.receive` takes its lock AFTER one read, and says so: the
lock key is the item id, and when the caller identified the transfer by its own
id there is nothing to lock until we know which copy it is. The read is of
`item_transfers`, not of the row the lock protects, and the write re-checks that
the transfer is still open with a conditional `updateMany`.

### `floating_rules` is re-phased to 23, and the SELECTOR lands instead

It was `9c/15` in `BASELINE-SCOPE.json` and is now `23`, which is the first time
this program has moved a table's phase after reaching it. The argument: §6 phase
23 states the whole decision — "an item owned by A, checked out at B, returned at
C either floats or generates a transit per `floating_rules`" — and carries the
four-branch fixture that is the only thing able to test a single row of it, and
the decision itself is taken at CHECKIN, which is phase 16. Phase 15 has no
checkin, no fixture, and no caller. Writing its columns here would be writing
them with none of those, which is the failure `patrons` names in its own
docblock, one phase earlier and one table over.

What phase 15 DOES own is the selector, because the baseline assigned it here by
name: `shelving_locations.floating_group`, nullable, a group name rather than a
boolean because floating is almost never library-wide — a consortium floats its
large-print collection between three branches and nothing else.

### A reason is not a code, and the difference is what makes availability work

`item_status_reasons` sits beside three columns that look like it.
`items.not_for_loan_code`, `damaged_code` and `lost_code` are CONDITION flags:
they are read by the `is_shelf_available` generated column, they change what a
copy IS, and a copy can carry more than one at once. A reason is the librarian's
answer to "why did you do that?" — one per transition, never read by a predicate,
meaningful only beside the status it explains. Conflating them would blur exactly
the line that makes the generated column a single definition of "on the shelf
right now". The three code vocabularies have no lookup table anywhere in `lbr2`
and stay with phase 21, which already owns `override_reasons` — recorded as a
citation rather than a silence.

### `item_status_history_is_a_change`, and why it is a CHECK

A history row where nothing changed is not a transition; it is a save button that
fired twice, and once such rows exist "what happened to this copy?" cannot be
answered by reading the table. The constraint is
`from_status IS DISTINCT FROM to_status OR from_branch_id IS DISTINCT FROM
to_branch_id` — `IS DISTINCT FROM` rather than `<>` because both sides are
nullable and `<>` yields NULL, which a CHECK passes.

It also states the domain in one line: **a branch move with no status move IS a
change.** That is what a float is, and a history keyed only on status would
answer "where has this been?" wrongly. It is why `status_since` advances only
when the STATUS moved — otherwise "how long has this been missing?" answers
"since it was moved".

The table is APPEND-ONLY: no `updated_at`, no `archived_at`, asserted by reading
`information_schema` in both the smoke module and the integration spec. A history
that can be edited is not one; `loans` sets the same precedent as an event log
with neither column.

### Provisioning seeded nothing an item could point at

`items` has five NOT NULL foreign keys and a freshly provisioned 2.0 tenant had
rows for none of them, so the first `POST /items` a library could make was a
foreign-key error — the cataloguing equivalent of the `NO_MATCHING_RULE` refusal
phase 13's seed exists to prevent. `seedItemDefaults` writes a branch, a shelving
location, an item type and a material type; the holdings record is the one gap
the service closes on its own.

The branch's timezone is `Europe/Athens` and a seed has to choose one, because
`branches.timezone` is THE `circ-5` column and is NOT NULL. A wrong zone is one
field on a form; a missing one is a branch that cannot compute a due date.

**And `scripts/tenant-create.ts` seeded no 2.0 rows at all.** Phase 13's
provisioning service says "every provisioning path seeds the same thing" and then
seeded the circulation rows on the signup path only. A library created with the
script got the 2.0 tables and none of their rows: it could not lend, and from
this phase could not catalogue either. Closed here rather than left as a second,
quieter provisioning path.

### Decisions worth their sentence

**Two new permission keys, in `circ` and not `cat`.** `circ.item.status` and
`circ.item.transfer`. A copy's status is circulation state — it is what decides
whether the copy can be lent — and the people who hold these are different
people: shelf-reading staff mark books missing all afternoon and must not be able
to re-catalogue a copy; a cataloguer needs the opposite; a transit clerk needs
neither. Collapsing any two means every library that wants one has to grant both.

**The status route accepts three of the six statuses.** `on_loan`, `in_transit`
and `awaiting_pickup` are outcomes of circulation acts, and a route that let the
desk set them by hand would produce a copy that is `on_loan` with no loan — a
state every availability count, every overdue sweep and every patron's account
would then disagree about. They arrive through `ItemStatusService` from the
service that owns the act, which is what `cause_type`/`cause_id` are for.

**`UpdateItemDto` has no `status` field, and `validateDto` runs
`forbidNonWhitelisted`.** So `PUT /items/:id` with `{"status":"missing"}` is a
400 naming the property rather than a 200 that silently dropped it. A caller must
not be able to believe a status write happened.

**Item barcodes fold; patron card barcodes do not.** `items.barcode_norm` says
"folded per `@libriant/shared/greek`" and `patron_cards.barcode_norm` does not,
and the difference is real: a patron card barcode is machine-issued and printed,
and folding it would let two people's cards collide, while an item barcode is
frequently a hand-typed accession number on legacy Greek stock.

**The shelf-list cursor has three branches, not two.** `call_number_sort` is
nullable and a btree ASC index puts NULLs LAST. A copy with no call number is one
nobody has shelved yet; it belongs at the end of the list rather than missing from
it, and a two-branch keyset silently drops the whole tail because `gt` never
matches NULL.

**`items.public_note` and `staff_note` survive beside `item_notes`.** The same
split `patrons.staff_notes` already makes: a one-line "spine label damaged" that
prints on the record page is a field, and forcing it to be a dated attributed note
is how a field stops being used. `item_notes.public_note` defaults to FALSE,
because a note written on the assumption that nobody outside the building reads it
must not become public because a later screen offered the choice and defaulted the
other way.

**Archiving is refused while a copy is in transit.** A copy archived mid-transit
is a copy in a van that no work list mentions.

**The two acceptance plans are asserted as EXPLAIN, not as timings.** A timing on
a laptop measures the laptop. The claim in §6 is about access path — a change from
Index Scan to Seq Scan is invisible on a fixture and fatal at 200,000 copies — so
the spec reads the plan and names the index, and asserts the absence of a `Sort`
node on the shelf list, which is the part a `LIMIT` cannot save you from.

**`holdings_records` was never exempted from `check:schema-conventions`.** Its
docblock claimed it was, and phase 15 checked: the gate's rule is "a column named
`id` must be TEXT", and this table has no column named `id`, so the check skips it
rather than waiving it. An exemption is a decision somebody signed; a skip is a
rule that never applied. Corrected in place.

---

## Phase 16 — circulation engine, part 1

Checkout, checkin and renew; two new tables; the lock gate phase 10 deferred;
three columns of the change feed that had never had a writer; and the
anonymisation §3 calls "an IFLA/NISO professional obligation and a Greek DPA
answer", which phase 14 created a policy row for and left to this phase to
perform.

§6's acceptance clause is five sentences and each is a test in
`apps/api/test/integration/circulation.spec.ts`. What follows is what had to be
decided, and the four things that were decided wrongly first.

### The lock gate: the deferral was right, for a reason phase 10 could not see

`platform/locks.ts` shipped the helper in phase 10 and refused the gate, on the
argument that "a gate shipped with 25 allowlist entries pointing at code the
phase-20 cutover deletes is a gate that checks nothing while looking like
coverage". Phase 16 found NINETEEN bare call sites, and the deferral turns out to
have been right for a better reason than the one given: they are not one pile,
they are three.

**Nine** are in `loans`, `reservations`, `members` and one scheduled job, all of
which phase 20 deletes. They are allowlisted by DIRECTORY with that citation —
and because an allowlist entry that stops matching FAILS, phase 20 is forced to
delete the entries in the same commit that deletes the code.

**Nine** are CONTROL-PLANE locks: billing, import staging, quota, staff seats.
They are in a different Postgres database and can never contend with a tenant
lock, so ranking them against `patron` would be inventing an ordering to
reassure a reader. Their domains are deliberately absent from
`LOCK_DOMAIN_RANK`, which turns "these are in different databases" from a fact
somebody has to know into a type error.

**One** was in the 2.0 tree — `PolicyWriteService.seedDefaults`, on
`policy:<tenantId>`, already spelling the key this file's way and hashing it
this file's way "so the two can never collide by accident". It was a
`LockDomain` in everything but the type, and it is one now.

So the gate guards the tenant plane with ZERO exemptions on it, which is the
only state in which a gate is worth having. `policy` ranks 0, before `patron`,
and the argument is simultaneity rather than tidiness: a tenant-wide
configuration key is derivable before any read, so every path that wants one
wants it as its FIRST statement and only afterwards discovers which patron or
item it will touch. The reverse derivation does not exist and cannot — there is
no "look up the item, then lock its policy". §3 gives phase 21 a
`POST /circulation/loans/repolicy` that must hold the configuration steady while
re-pricing N open loans, which will be the first transaction here to hold two
domains at once.

### PROBE, LOCK, RE-VERIFY — and the deadlock this phase nearly shipped

A checkin is keyed on an ITEM barcode and cannot know the PATRON until it has
found the loan. So the natural implementation takes `item:` then `patron:`,
which is the inversion of the rank, and it deadlocks against checkout.

Measured on these tables, two lanes taking the same two keys in opposite orders:
**3 deadlocks in 120 transactions**, and in a longer earlier run 17 `40P01` in
fifteen seconds with the first at 1,165 ms. Through `orderLocks` the four-lane
mixed workload did **1,000 operations with 251 refusals and zero deadlocks**.

The rule is now written in `locks.ts` because checkin will not be the last
caller that meets it:

1. read what you need to learn the key, OUTSIDE the transaction, and treat the
   answer as a GUESS;
2. open the transaction and take every lock, sorted, in one call;
3. re-read under the locks and check the guess still holds — if it does not, the
   world moved and the caller must retry rather than proceed.

Step 3 is what makes step 1 safe. Skipping it is the same defect as locking after
the read, which `locks.ts` already measured to be exactly the protection of no
lock at all.

**The break test is the point.** A four-lane soak proves nothing on its own: a
checkout with NO advisory lock also passes "one open loan per copy" (the partial
unique does that), and four lanes that never contend report zero for as long as
you care to run them. So the spec carries a test that reproduces the inverted
order and asserts it DOES deadlock. Without it, "zero deadlocks" is an
observation rather than a claim.

`acquireLocks` also became ONE statement — `FROM pg_catalog.unnest($1::text[])`
over an already-sorted array, because a Function Scan produces rows in array
order. NOT two calls in a SELECT target list: target-list evaluation order is
unspecified, and trading the ordering guarantee to save a round trip would be
trading away the entire point of the module.

### `effective_at` is not `occurred_at`, and the difference is money

The phase line says "`loan_events` with `occurred_at` **and** `effective_at`" and
the plan of record says nothing else — the word `effective_at` appears exactly
once in the whole document. The surrounding schema settles it: `change_events`,
`audit_log` and `item_status_history` all already use `occurred_at` to mean "when
Postgres learned", so `effective_at` is the new column and means "when it
happened, at a desk, in the world".

They differ in the two cases the schema already anticipates — `EventSource.offline`
exists for a client replaying its queue, and a Saturday book drop is opened on
Monday. `accrueOverdue`'s `asOf` is documented as "a return, or a sweep's own
clock" and must be fed `effective_at`; fed `occurred_at`, a wand that syncs on
Monday charges three days of fine on a Friday return and the receipt is already
printed.

Both are NOT NULL, with `effective_at <= occurred_at` as a CHECK. The nullable
alternative — "NULL means the same instant" — puts a `COALESCE` in the fine
calculation, the due-date calculation, the rollup and every report, and one
forgotten `COALESCE` is a silent overcharge. The service CLAMPS rather than
letting the CHECK fire: a device with a fast clock must not hand a librarian a
`23514` they cannot act on, and clamping IS what §6 phase 78 means by
"clock-skew clamping".

### The policy is frozen and the calendar is NOT

This is the one asymmetry in the design and it looks like an inconsistency.

The POLICY is what the library DECIDED. Re-pricing an open loan because somebody
edited a rule this morning is charging a reader under terms that did not exist
when they borrowed the book — not a bug, a false statement on a receipt. So
`policy-pinning.ts` freezes the three policies that price the loan, the rule id,
the snapshot version, the branch and its timezone.

The CALENDAR is what HAPPENED. A closure entered after the fact is a CORRECTION
OF THE RECORD, and `OverdueFinePolicy.countClosedDays: false` exists precisely so
a reader is not fined for a day the door was locked. Freezing it would mean a
snowstorm closure entered on Tuesday could never forgive the Monday it closed,
and a librarian would waive the fines by hand, one reader at a time.

The DUE DATE has no such tension, which is why the asymmetry is safe: it is
computed once, stored in `loans.due_at`, and never re-derived. The frozen
`rolls` explain it without needing the hours.

**The naive version of this test passes on a broken implementation.** Asserting
that `dueAt` is unchanged after a rule edit proves nothing — it is a column.
What proves it is a RENEWAL after the edit: the loan period was halved from 14 to
7 through the real trigger path, `circulation_policy_version` bumped, and the
renewal still extended by fourteen days because it priced from the frozen
snapshot.

`hold` and `notice` are excluded from the snapshot: §3 pins a hold policy on
`holds` "identically", so phase 17 freezes its own, and §4.4 gives the
notification engine channel resolution at SEND time, so a frozen template binding
would send last year's letter in this year's branding.

### Four things that were decided wrongly first, and what corrected them

**Hashing the server's own clock.** `sync-replay.ts` states the rule — "OUT: the
server's clock. It differs on every attempt by definition" — and the first
implementation then hashed `effectiveAt` AFTER defaulting it to `clock.now()`,
so every replay was a mismatch and every device would have been told 409 for ever.
The replay test found it. The hash now covers the CLAIMED instant, `null` when
the caller gave none.

**`loan_events` was going to be unreplicated.** The argument was that `loans` is
already replicated, so a device has the state it needs in order to lend. True and
beside the point: `item_status_history` has been `@replicated` since phase 15, so
leaving this one out would mean a device replica could say what happened to a
COPY and not what happened to a LOAN — and §6 phase 78 owes the librarian a
reconciliation report written by comparing the two, event for event. The test
found it: a checkin wrote three change events where the docblock predicted two.

**`CARD_EXPIRED` was going to move into `packages/circ-policy`.** Phase 14's
`patron-blocks.service.ts` says "three codes appear in both lists
(`too_many_overdues`, `fine_limit_exceeded`, `card_expired`) … the resolver still
computes its own answer at checkout". Two of the three did. The tempting fix was
to add the third to `BLOCK_CODE` — and `blocks.test.ts` refuses it by name, with
the argument that "patron and item STATE is deliberately absent: deciding it needs
a query, and this package makes none". That boundary is right: an expiry is not a
comparison against a policy value, and there is no policy field saying whether an
expired card may borrow. `CheckoutService` refuses it directly, beside the
archived reader and the suspended one, and phase 14's paragraph was corrected
instead.

**A backtick inside a SQL comment, again.** The phase-14 lesson, re-learned in
`checkout.service.ts`: a backtick in a `--` comment terminates the JS template
literal it lives in, mid-statement. Also re-learned: `COALESCE` and `NULLIF` are
SQL CONSTRUCTS, not functions, so `pg_catalog.coalesce(...)` is `42883 function
does not exist` — the `pg_catalog.`-qualify-everything convention does not reach
them.

### THE POOL IS ONE CONNECTION, so a nested client call inside a transaction

### self-deadlocks

The most expensive finding of the phase, and it is not in any file the phase
added. `CheckoutService` called `PatronBlocksService.liveBlocks(tenant, …)` from
inside its own `$transaction`, which is the obvious thing to write and which the
phase-14 module docblock explicitly invited: "exported because phase 16's
checkout has to see the blocks in the same transaction as the loan it is about to
refuse."

`TenantPrismaService` clamps the per-tenant pool — measured on a real boot,
"50 tenant(s) × 1 connection(s) × 2 datamodel(s) = peak 100 of a 118 budget;
clamped: poolMax 5→1" — so the open transaction holds the tenant's ONLY
connection and the nested read waits for a connection that cannot be returned
until the transaction it is inside commits.

**The symptom points at the wrong line.** It is not a deadlock error: it is
Prisma's 5,000 ms interactive-transaction timeout, reported against whatever
statement came next, which was `loan.create`. Thirteen tests failed at exactly
5,0xx ms each.

The rule is general and now lives on `liveBlocksWithin`: nothing inside a
`$transaction` may reach the tenant client again, and every collaborator a
transactional service calls has to take the `tx`.

### Three columns of the change feed that had never had a writer

`change_events.client_change_id`, `change_events.commit_xmin`, and the sequence
number a write's own event got. All three were created in the phase-9 baseline
and none had ever been filled, because until this phase nothing in the 2.0 tree
produced a change with a client change id or needed to correlate a write with its
own feed entry.

They are filled NOW because `change_events` is APPEND-ONLY. A column added to an
append-only table is NULL for every row already written and no later phase can
backfill it — the same argument phase 9 recorded for `008/00-05` and phase 15 for
`patron_age_band`. Phase 16 is the first phase producing rows worth correlating,
so it is the last cheap moment.

- `client_change_id` from a fourth actor GUC beside the three the phase-9b
  rewrite already reads. A device replaying its queue has to recognise its own
  change coming back down the feed.
- `commit_xmin` from `pg_current_xact_id()`. §4.2 reads the feed "with a commit
  watermark (`row_version < pg_snapshot_xmin(pg_current_snapshot())`) so no
  late-committing transaction is skipped", and that read is impossible against
  a NULL column. `pg_current_xact_id()` and not `txid_current()`: the former
  returns `xid8`, which is what the column is; the latter wraps at 4 billion.
- the published sequence, via `set_config('libriant.last_event_seq', …, true)`,
  so `sync_client_changes.server_event_seq` costs no query and is not a guess.
  A transaction that fired several triggers publishes the LAST, which is the
  position after everything it did.

`commit_xmin` also turned out to be the right instrument for the phase's own
budget: every event a single transaction writes shares one transaction id, so
"the checkin was one transaction" is "its events have one distinct commit_xmin".

### `circulation_statistics` is a rollup, not a counter

§3 writes it "`circulation_statistics` (partitioned)" and nothing else. A counter
bumped inside the checkout transaction would be a hot row in exactly the
transaction this phase is accepted on — 25-way concurrent checkout of the SAME
item — so all 25 would additionally serialise on one statistics row, for a number
nobody reads until month end. It is rebuilt hourly from `loan_events` instead,
current month and previous, because a rollup that can be recomputed can be
repaired and a counter incremented in-transaction can only be believed. §8 risk 7
makes the same argument about the fee ledger.

The counters are COLUMNS rather than rows keyed by a `kind` enum, forced from
three directions at once: a partitioned table's unique index must contain every
partitioning column (`0A000`), the rollup is an `INSERT … ON CONFLICT DO UPDATE`,
and an enum-predicate arbiter raises `42P10` through Prisma's parameterised cast
while working by hand in psql. All four dimensions are NOT NULL because a unique
index treats two NULLs as distinct, and a nullable dimension would silently
accumulate duplicate buckets — which a dashboard renders as a plausible number.

The baseline migration named this phase for the partition job: "PHASE 16 OWNS THE
JOB THAT ROLLS THE WINDOW FORWARD, and its alert is what stops the loud failure
ever happening." `partition-maintenance` is driven by a registry rather than a
hardcoded table, because `audit_log` was the first, this is the second, and §6
phase 26's `analytics.fact_circulation` will be the third. The metric is
HEADROOM, not a run counter: the failure being prevented is a `23514` months from
now, so the alert has to fire while there is still time to act.

### Measured

```
  4-way mixed soak        1,000 operations, 251 refusals, 0 deadlocks
  inverted lock order       120 transactions, 3 deadlocks   (the break test)
  25-way same-copy race       1 commit, 24 × 23505, 0 × 40P01
  checkin                  p50 6.04 ms / p99 8.16 ms        (budget 40)
  checkin change events      4, under ONE commit_xmin
```

The wire statement count is NOT asserted, and the reason is written into the spec
rather than left as a silence: it needs `pg_stat_statements`, which is not
loadable on the cluster the suite runs against (`CREATE EXTENSION` succeeds on the
Homebrew server and the view then reports "must be loaded via
shared_preload_libraries"; `logging_collector` is off, so the statement log is not
readable either). It IS preloaded in the compose files, so a check against the
container would say it works — the two-cluster trap this repo has now paid for
four times. What is asserted instead is sharper for what the budget protects: ONE
transaction, and the exact row footprint, so an N+1 inside a loop shows up as a
count that scales with the fixture where twelve would not have noticed on a
fixture of one.

### Decisions worth their sentence

**Phase 16 writes no `fees`.** Three independent reasons, any one sufficient.
`fees.account_id` and `fee_type_id` are NOT NULL and phase 18 owns
`patron_accounts` and `fee_types`, so a fee row here would have to invent an
account id — which is inventing the double-entry invariant a phase early. The
seeded fine rate is zero and `fees_amount_positive CHECK (amount_cents > 0)`
refuses a zero row, so it is unreachable anyway. And a placeholder `account_id`
written onto real loans is a data-repair job for phase 18 rather than a one-line
migration. What phase 16 does instead is COMPUTE the amount from the frozen
snapshot and record it on the `loan_event`, which is what makes "editing a rule
does not change an open loan's fine" checkable and what phase 18 will bill from.

**A return is never refused.** Not for a block, not for an expired card, not
because the fine could not be worked out. A copy coming back onto the shelf is a
fact about the world, and making it conditional on an arithmetic question about
money is the mistake 1.0 made by conflating `returned_at` with `closed_at`. When
`accrueOverdue` refuses — a calendar that does not reach far enough is the
realistic case — the refusal is recorded as `fine_error_code` and the copy is
shelved.

**Reading history is anonymised in the return transaction.** Phase 14 created
`reading_history_policy` and never read it, recording that phase 16 owns the
transaction. This is it: `patron_id` nulled, `anonymised_at` stamped, in the same
UPDATE as the return. Which is also why `patron_age_band` had to be computed at
CHECKOUT — it is derived from a date of birth, and after the return there is no
patron row to derive it from, so "defer it" and "lose it for ever" are one
sentence. And why `loan_events` carries NO patron id: an event log keeping its own
copy would make the anonymisation cosmetic, with the link surviving one join away
in a table nobody remembered to check.

**A renewal that would move the due date backwards is refused.** `renewFrom:
'currentDueDate'` on an overdue loan computes fourteen days from a date already
past, which can land before today; `loans_due_after_loaned` does not catch it,
because the new due date is still after the original checkout. So a librarian
would "renew" a book and make it more overdue with no error. Refused at the
service rather than clamped in the package: `circulation-defaults.ts` records
that 1.0's base is `max(dueAt, now)` and that "`renewFrom` has no value that
means both", so a silent clamp would invent a third semantics nobody configured,
for all eight consumers.

**Batch renewal is N transactions.** One transaction holding N patron and item
locks grows its lock set with the reader's shelf. Each renewal is its own
transaction and its own row in the result, so a block on the third does not roll
back the first two — which is also the answer a librarian wants: "these four
renewed, this one is on hold for somebody else" is useful and "nothing renewed"
is not.

**`CheckinDisposition` is derived and not stored.** The facts that produce it are
each already stored by their owning phase, so a stored enum beside them is a
second answer that can drift; and it is an INSTRUCTION rather than a state, which
goes stale the moment somebody acts on it. All four values are declared even
though phase 16 can only reach two, because a client should not need redeploying
to understand a returned book.

**An always-open calendar is now seeded, correcting phase 13.** Phase 13
deliberately seeded none, on the argument that it had no acceptance criterion
touching calendars and no caller. Phase 16 has both, and without one the FIRST
checkout of every provisioned library raises `CALENDAR_NOT_DEFINED_FOR` — at a
desk, with a reader standing there. Open 00:00–24:00 with `closedDayHandling:
'keep'`, which behaves identically to having no calendar at all: it changes no
due date anywhere and makes the refusal unreachable. Plausible 09:00–17:00 hours
nobody chose would have made a 16:00 checkout due at 17:00 on a day the library
never said it shut. The seed order in provisioning INVERTED as a result —
circulation before items — because `branches.calendar_id` is a foreign key.

**No new permission keys.** `circ.loan.read`, `circ.loan.checkout`,
`circ.loan.return` and `circ.loan.renew` were minted in phase 3, so the busiest
surface in the product needed no new capability and `docs/api/openapi.v1.json` is
unchanged. That is what landing the permission model in M0 was for.

**`service_points` re-phased to 18/23.** `loans.checkout_service_point_id` stays
NULL: a service point earns its columns from the cash drawer (phase 18) and the
branch/desk switcher (phase 23), and phase 16 has neither. The same refusal phase
15 made for `floating_rules` and phase 14 for the patron identity side.

## Phase 17 — Holds 2.0

The queue, the promotion, the transit and the shelf; two new tables; three policy
values that had existed since phase 12 and done nothing; and the constraint that
turns §3's "a named regression test must fail under the 1.0 blanket decrement"
from a test into a refusal the database will not commit through.

§6's acceptance clause is three sentences and each is a test in
`apps/api/test/integration/holds.spec.ts`. What follows is what had to be
decided, the three things that were decided wrongly first, and one measurement
that is not about holds at all.

### The blanket decrement does not produce a wrong number. It ABORTS.

§3: "a TARGETED queue rebalance (`WHERE queue_position > <vacated>`). The 1.0
blanket `> 0` decrement is correct only because the head always leaves; with
suspended holds being skipped it corrupts positions, and a named regression test
must fail under the old form."

The 1.0 form is in three files — `reservations.service.ts`'s promoter,
`reservation-expiry.job.ts` and `loans.service.ts`'s return path — and it is
CORRECT there, because 1.0 has no suspension, so the hold that leaves is always
position 1. The moment a suspended reader can be skipped, the hold that leaves is
not the head. Five holds with #1 suspended and #2 filled:

```
  targeted   WHERE queue_position > 2   ->  1(susp), 2, 3, 4   correct
  blanket    WHERE queue_position > 0   ->  0(susp), 2, 3, 4   position 0
```

`holds_position_is_one_based CHECK (queue_position IS NULL OR queue_position >= 1)`
makes the second line abort with `23514`. MEASURED, against a real queue:

```
  ERROR:  new row for relation "holds" violates check constraint
          "holds_position_is_one_based"
```

That is what the regression test asserts, and a SQLSTATE is the sharper
assertion: a multiset of positions can still be satisfied by a subtly different
wrong implementation, and `23514` can only be produced by one that tried to put a
waiting reader at position 0.

There is ONE implementation of the rebalance — `closeQueueGap(tx, bibId, vacated,
now)` — called by the promoter, the checkout, the cancel, the group resolution and
both sweeps. 1.0 has three copies because a worker could not take the Nest graph
and a return path could not import a service; `circ-4` then fixed the same
rebalance in each of them separately. A plain function that takes a transaction
has one place to be wrong.

### Placement never assigns a copy, and the pull list is a QUERY

The tempting shortcut is to look for a copy on the shelf and hand it to the reader
on the spot. Assigning a copy is a claim on a physical object, and a placement
transaction holds no lock on any item — so a copy assigned there can be lent at
the desk a second later, and the reader is told a book is waiting for them that
somebody walked out with.

So a copy is claimed in exactly two places, both of which already hold the item's
lock because they are holding the copy: `promoteForItem` inside a checkin, and
`HoldShelfService.fetch` when a librarian has walked to the shelf. "These readers
are waiting and a copy is on the shelf" is derivable, and derivable beats stored
for anything nobody has physically done yet.

`fetch` is keyed on the COPY and not on the request the pull list named. Between
printing the list and reaching the shelf the queue can move — a reader ahead
resumed a suspension, a request was cancelled — and serving the request that was
on the printout would serve the queue out of order for a reason nobody could see.

### `FOR UPDATE SKIP LOCKED` is the obvious tool and is wrong here

It is what you reach for with "three workers, one queue, no double-take", and it
gives the wrong answer: skipping a LOCKED row is not skipping an INELIGIBLE one.
Under contention worker B would hand copy 2 to position 3 while worker A was
still deciding about position 2, and the queue would be served out of order,
silently, only under load. Serialising the whole queue on `lockKey('bib', bibId)`
costs the three concurrent returns of one title a few milliseconds each and gives
every one of them the same queue to read.

`bib:` therefore joins the checkin's and the checkout's single sorted
`acquireLocks` call — patron < bib < item, which is the rank phase 16 fixed, so
nothing about the deadlock graph changes. The checkout takes the group's OTHER
bibs as well, discovered by its probe and re-verified inside: filling one member
of a group cancels its siblings, and each cancellation rebalances another
record's queue.

What makes `max(queue_position) + 1` safe is that lock and nothing else, and the
spec proves it in both directions on raw connections with the interleaving forced:
without the lock two writers read the same max and the second insert is refused by
`holds_one_hold_per_position` (`23505`); with it, the second waits and gets the
next position. There is no `ON CONFLICT` alternative — an arbiter must name the
index's columns, and an upsert that wanted "the next position" would have to know
the position before it could name it.

### A routed hold reaches `awaiting_pickup` only on transit receipt

Made a fact about an append-only table rather than a fact about timing. A checkin
whose winning reader collects elsewhere writes ONE status transition, `on_loan →
in_transit`, and opens the transfer in the same transaction;
`holds.awaiting_pickup_since` stays NULL for the whole journey, which
`holds_collectable_implies_assigned` and `holds_shelf_expiry_implies_collectable`
keep honest. `ItemTransfersService.receive` then writes the second, `in_transit →
awaiting_pickup`. Between them `item_status_history` has NOTHING:

```
  on_loan      -> in_transit
  in_transit   -> awaiting_pickup
```

so the copy was never momentarily `available` at the pickup branch. Two
mechanisms made that possible. `ItemTransfersService.openWithin` splits the
transfer ROW from the status change, because a checkin is allowed exactly one
`applyWithin` call — the phase-16 budget test asserts one history row per checkin,
"a fourth means the copy transitioned twice". And `HoldArrivalService` lives in a
module that imports NOTHING, which both `ItemsModule` and `HoldsModule` import: a
transit desk scans a barcode and does not know whether the copy in its hand is a
hold arrival, a float or a repair return, so one route has to answer for all
three, and `forwardRef` would have hidden the cycle rather than removed it.

### Three policy values that existed and did nothing

Each had been declared by phase 12, loaded by phase 13, and read by nobody.

**`hold.maxHoldsTotal`** was never evaluated. It is now the third ceiling beside
`rule.maxHoldsForRule` and `categoryLimit.maxHolds`, tightest wins. Computed
INSIDE the `operation === 'hold'` branch, which is not tidiness: `RenewService`
assembles its `resolved` from a LOAN's pinned snapshot, which has no `hold`
policy in it at all, and reading `hold.maxHoldsTotal` unconditionally made every
renewal in the building throw a TypeError. The integration suite caught it.

**`hold.itemLevelHolds: 'deny'`** had a block code, `ITEM_LEVEL_HOLDS_NOT_ALLOWED`,
and nothing emitted it. It does now, against a new `requestedHoldLevel` on
`CirculationState`. `'force'` is deliberately NOT a block: it is a constraint on
the placement UI, and "you must name a copy" is a different sentence from "you may
not name one", with no code for it.

**`pickupPolicy: 'holdingBranch'`** was answered with `itemHomeBranchId` — the
same field as `owningBranch`. Phase 15 made those two branches deliberately
different for the whole of a transit: `current_branch_id` stays at the SOURCE
until receipt, so a copy in a van LIVES at one branch and IS at another.
Collapsing them is wrong for exactly the copies a hold spends its time routing.
`itemCurrentBranchId` is now its own field, and the two policies give opposite
answers on the same state.

An absent branch also stopped being a refusal. `patrons.home_branch_id` is
nullable, so under `patronHomeBranch` a reader who never chose one was refused
every branch by a comparison against `undefined` — a refusal produced by a missing
value rather than by a policy.

### `computeRenewalDueDate` never applied the renewal period

Not a holds bug, found by wiring `hasOutstandingHold` into it. It chose a period
— `alternateRenewalPeriodWithHolds ?? renewalPeriod ?? period` — used it only for
a null check, and then handed `computeDueDate` the untouched policy, which
re-derived a CHECKOUT period from `period` and `alternateCheckoutPeriodWithHolds`.
So `renewalPeriod` had never taken effect, and turning on the hold variant would
have silently applied the checkout one. Every vector in
`resolution-vectors.json` has `renewalPeriod: null`, which is exactly why nobody
had seen it. The chosen period is now passed explicitly, with
`alternateCheckoutPeriodWithHolds: null` so the shortening cannot apply twice.

### MEASURED, and not about holds: Prisma writes `timestamptz` in local time

Found by a sweep whose fixture set a deadline with `pg_catalog.now()`. On a host
whose Postgres session `TimeZone` is `Europe/Athens`:

```
  js now                        2026-09-10T10:48:29.401Z
  node-pg reads pg now()        2026-09-10T10:48:29.503Z
  node-pg reads a Prisma write  2026-09-10T07:48:29.401Z   three hours EARLY
  Prisma  reads its own write   2026-09-10T10:48:29.401Z
  Prisma  reads pg now()        2026-09-10T13:48:29.507Z   three hours LATE
  stored ::text                 2026-09-10 10:48:29.401+03
```

Prisma's pg adapter encodes and decodes `timestamptz` as if a JS Date's UTC wall
clock were LOCAL time, in BOTH directions. It therefore agrees with itself, and
every comparison in this repository is Prisma-frame on both sides and correct —
which is why nothing has caught it, and why CI, whose Postgres is UTC, never
will. What is wrong is (a) the instant physically stored, by the session offset,
and (b) any predicate that puts a Prisma-written column beside a server-side
`now()`.

FIXED in the interlude entry at the end of this document, which supersedes the
paragraph below. It is §8 risk 2's family — "timestamp conversion silently shifts
every date by three hours" — arriving through the driver rather than through a
migration. It was older than this phase and was not this phase's to fix: the fix is an adapter or
`PGTZ` decision affecting all three Prisma clients and every phase from 9 onward,
and it needs its own session and its own repair script. What phase 17 owes and
pays is not making it worse: `hold-transit-timeout.job.ts` binds its instant from
Node and names no `now()` in SQL, and the sweeps compare Prisma-frame values on
both sides.

### Measured

```
  holds integration suite      18 tests, 18 green
  three copies / five holds     3 filled, queue left contiguous at 1,2
  queue race without the lock   both writers read max=1, second insert 23505
  queue race with the lock      positions 1 and 2, no retry, no refusal
  routed transit history        2 rows, nothing between them
  smoke module v2-holds        12 assertions, 10 of them a SQLSTATE
```

### Seven holes an adversarial review found before this landed

Six independent reviewers over the diff, then a refutation pass on each finding:
24 raised, 19 survived, 7 distinct defects after deduplication. All seven are
fixed here and each has a named regression test in `holds.spec.ts`. Four of them
are the same shape and it is worth naming the shape rather than the instances:

**A REQUEST THAT ENDS WHILE HOLDING A COPY MUST GIVE THE COPY BACK.** Three paths
ended one and did not: a reader cancelling, a group sibling cancelled because
another edition was collected, and a reader who had a copy set aside and walked
out with a DIFFERENT one off the open shelf. In every case the copy stayed
`awaiting_pickup` with a dead name on it, and nothing would ever have taken it
back — the shelf sweep reads `shelf_expires_at` on OPEN requests only, and none of
those three is open. Absent from `is_shelf_available`, from the pull list, from
the queue behind it, and present only on a shelf-list screen nobody reads on
purpose. No constraint can catch it: `items.status` and `holds` are two tables and
the invariant between them is not one a CHECK can see. All three now go through
`hold-release.ts`, which treats a book leaving a hold shelf as exactly what it is
— a book being returned — and walks the queue for it. The fourth instance is the
mirror image: cancelling a hold's TRANSFER left the request assigned to a copy
that was never coming, so the reader waited for ever and the next promotion of
that copy would have raised `23505` on `holds_one_assignment_per_item`.

The other three:

**`expireRequests` closed the gap with a position read before the lock.** The
sweep read its work list on the outer client and passed the scanned
`queue_position` into `closeQueueGap` — and its own earlier iterations renumber
the queue the later ones were read with. No concurrency needed: because
`request_expires_at` is `placed_at + policy`, the scan walks a record in placement
order, which is exactly the direction that leaves every later position one too
high. Two expiring requests on one record either raised `23505` and abandoned the
whole tenant's sweep, or committed a queue with no position 1 in it. The position
is now re-read under the bib lock, which is step three of probe-lock-re-verify
applied to the one value the arithmetic depends on.

**`pg_catalog.extract(epoch FROM …)` is a syntax error.** `EXTRACT` is a SQL
CONSTRUCT with its own grammar, like `COALESCE` and `NULLIF` — the trap this
repository has now paid for three times — so the transit-timeout job would have
failed for every tenant on every run. The days are now subtracted in JavaScript,
which is legitimate here for the one reason it usually is not: both sides are
instants in the same frame and the result is an elapsed duration.

**`countCirculationState`'s copy count sequentially scanned `items`.**
`items_shelf_available_idx` is PARTIAL on `is_shelf_available`, so it answers "how
many are on the shelf" and cannot answer "how many are there at all" — and
`allCopiesAvailable` is the ratio, asked on every checkout and every hold
placement. `items_bib_idx` is partial on `archived_at IS NULL`, which does two
jobs: the subquery's own literal makes the predicate provable, and its absence
from phase 15's hold-promotion probe keeps this index from competing with the
two-column one there. A plain `@@index([bibId])` ties on an empty table and makes
`items.spec.ts`'s plan assertion flap — an assertion about a real plan, broken by
an index that is worse for that query.

Two more were fixed on the way and are worth a line each. Hold-routed transfers
never set `expected_by`, so every one of them was invisible to the alert built to
notice a crate nobody unpacked — the winner's frozen `maxTransitDays` now travels
out of `promoteForItem`, and the deadline is computed with `addDuration` because
the ESLint block on `apps/api/src/holds/**` refused `n * 86_400_000` and was right
to: a van given three days on 25 March in Athens arrives an hour late. And
`place()` wrote `suspended_until` without any of the three checks `suspend()`
makes, so a policy that forbade suspension was enforced on one route and not on
the other — one checkbox on the same form — while a date in the past reached the
database and came back as a `23514` with no sentence in it.

### Decisions worth their sentence

**No status enum, for the fourth time.** A hold is open when `fulfilled_at`,
`cancelled_at` and `expired_at` are all NULL. Phase 15's measurement on 200,053
rows stands: a parameterised enum predicate seq-scans at 1470 buffers against 2
for a NULL predicate, still seq-scans with `enable_seqscan = off`, and
`ON CONFLICT … WHERE state = CAST($1::text AS …)` raises `42P10` where the literal
form works by hand. `holds_one_ending` is what makes the partial uniques mean what
they say: a row carrying two endings is excluded from an index by either.

**A group is a cancellation rule, not a queue.** Each member sits in its own bib's
queue at its own position and is promoted independently; the group only says what
happens when one is FULFILLED — not assigned. A copy put on a shelf is not the
reader having the book, and cancelling the siblings at assignment would lose a
reader their place in three other queues to a copy they never collected. Hence no
`hold_groups.queue_position`, no group lock domain, and `resolveGroupOnFulfilment`
refusing when the sibling set is not the set the caller locked.

**A suspended hold keeps its position and is skipped.** It is a reader who is not
ready, not a reader who has left. It is also excluded from `hasOutstandingHold`,
so it neither shortens somebody else's loan nor blocks their renewal — holding one
reader's renewal for another reader's convenience is a charge nobody agreed to.
And it cannot be suspended once a copy has been set aside: "keep my place but give
the book to somebody else" is two different requests.

**`shelf_expires_at` is computed once and stored.** Exactly as `loans.due_at` is,
and more so: a shelf expiry is on the slip in the book and in the message the
reader was sent. Re-deriving it against a live calendar would let a closure entered
on Tuesday silently extend a shelf life the reader was told expired on Monday, and
a closure removed would shorten one. `shelfExpiryUsesCalendar` counts OPEN days —
the FOLIO bug phase 12's docblock names — and the function never throws: a copy
arriving at a pickup desk goes on the shelf whether or not the arithmetic worked,
for the reason a return is never refused, and a NULL expiry means no automatic
expiry rather than an invented date.

**The shelf sweep promotes; it does not repair.** A book leaving the hold shelf is
exactly a book being returned, so it goes straight to the next reader through the
same `promoteForItem` rather than waiting for a librarian to notice a copy on a
trolley. What neither sweep does is renumber a queue: §8 risk 7's rule — "alerts
rather than self-heals (self-healing hides the bug that caused the drift)" — so
`queueIntegrity` REPORTS.

**The transit timeout reports and cancels nothing.** A transfer past its
`expected_by` is a physical fact nobody in the software can fix, and a job that
cancelled the request would tell a reader their book is not coming while the
driver still has it in the boot. Its predicate keeps `hold_id IS NOT NULL`: a late
float has no reader waiting at the far end and belongs to phase 23's transit desk.

**No new permission keys, again.** `circ.hold.read`, `.place`, `.edit`, `.cancel`,
`.fulfill` and `.expire` were all minted in phase 3, so fourteen new routes needed
no new capability. That is what landing the permission model in M0 was for.

**`cancellation_reasons` re-phased to 21, `hold_ratio_alerts` to 87,
`patron_reading_history` to 33.** The first is the same shape of
librarian-configurable vocabulary table phase 21 already owns in
`override_reasons`; `holds.cancelled_reason` is free text because what phase 17
owes is that a job-written cancellation is READABLE. The second is a
collection-development signal — nothing in the queue, promotion, shelf or transit
reads it — and belongs with CREW/MUSTIE weeding and demand forecasting. The third
is the OPAC opt-in, and building it before the opt-in that populates it would be
an empty table whose only effect is to make phase 16's anonymisation default look
negotiable.

**`holds` and `hold_groups` joined the patron data map as `in_bundle`.** `holds`
is anonymised rather than deleted, on `loans`' argument: a request is half of the
copy's history and that half is the library's record. `hold_groups` is deleted,
because a group holds nothing but a reader's own words.

## Interlude — the UTC session precondition

Not a phase. A defect phase 17 found and could only record, fixed here because it
is older than phase 17, reaches every phase from 9 onward, and gets worse every
day it is left.

### The whole of it, measured in both directions

`@prisma/adapter-pg@7.9.1` requires a UTC session and does not say so. Both
halves of its `timestamptz` handling assume it and both are silent when it is
false. On a session whose `TimeZone` is `Europe/Athens`:

```
  WRITE   a JS Date of 2026-03-01T10:00:00.000Z reaches the server as
    Prisma      2026-03-01 10:00:00              <- naive, NO zone
    node-pg     2026-03-01T12:00:00.000+02:00    <- an explicit offset
  so Postgres resolves Prisma's value in the SESSION zone and stores
    2026-03-01 10:00:00+02  =  08:00Z, two hours EARLY.

  READ    the adapter's own normaliser, verbatim:
    function normalize_timestamptz(time) {
      return time.replace(" ", "T").replace(/[+-]\d{2}(:\d{2})?$/, "+00:00");
    }
  Postgres renders a timestamptz in the session zone WITH its real offset; this
  strips that offset and asserts "+00:00" — it declares the local wall clock to
  be UTC.
```

The two errors are equal and opposite, so a Prisma-only round trip agrees with
itself and every comparison in the application is correct. That is why nothing
caught it: **it is invisible from inside Prisma**. node-pg is not at fault and
was the control — it round-trips exactly, because it puts a real offset on the
wire in both directions.

### Three consequences, and the third is not a display bug

**The instant physically stored is wrong**, by the session's offset AT THAT
INSTANT — two hours in winter and three in summer, so not even a constant. Every
reader that is not Prisma sees it: `psql`, a report, a restored dump, a trigger,
a CHECK, a partition bound.

**A predicate that mixes frames is wrong** — a Prisma-written column beside a
server-side `now()`.

**And once a year the DATA is wrong.** On the spring-forward night the naive
local time Prisma sends does not exist, so Postgres moves it. MEASURED:

```
  wrote  2027-03-28T03:30:00.000Z
  read   2027-03-28T04:30:00.000Z     silently, no error
```

For that hour the round trip is not self-consistent either: the application
cannot store those instants at all. So "wrong on disk but consistent in the app"
was too generous a description of the defect.

### Why it has never bitten, which is the uncomfortable part

Every deployed cluster is already UTC — `postgres:16-alpine` ships no `TZ`, in
both compose files and in CI, and `docker-compose.prod.yml` sets none. So the
offset is zero and both halves cancel to nothing. The one cluster that is NOT
UTC is a developer's local Postgres, which is exactly where the test suites and
`pnpm tenant:smoke` run.

The product was correct **by accident**, and nothing stated or enforced the
accident. That is the same shape as `boot-and-config-14` — a cluster property
that was true for a reason nobody had written down — and the same remedy: say
it, and refuse a cluster that disagrees.

### The mechanism is the DATABASE; the adapter option is the backstop

`ALTER DATABASE … SET TimeZone TO 'UTC'`, applied at every `CREATE DATABASE`
site, BEFORE the migrations. It reaches the three connections no pool option can:

```
  prisma migrate deploy   a subprocess whose Rust schema engine is
                          tokio-postgres and IGNORES libpq environment
                          variables — PGOPTIONS does nothing, and it is the
                          first thing the next person will try
  psql, pg_dump           the runbook, the DR drill, an operator at 03:00
  the smoke harness       and anything else holding a bare `pg` client
```

`options: '-c timezone=UTC'` on all three Prisma pools is the layer that covers
what the pin cannot: a database somebody forgot, a cluster this product did not
create, a restored dump, a customer's own Postgres. MEASURED, it outranks the
pin — a startup option is `PGC_S_CLIENT` and a per-database setting is
`PGC_S_DATABASE`, so against a database pinned to `Asia/Kolkata` a connection
carrying the option still reports `UTC`. Verified to survive pgbouncer 1.25.2 in
transaction pooling, which is what production runs.

**The option must never move onto the URL**, and that is a rule rather than a
preference. `withV2Schema` puts the schema on with `searchParams.set`, and
`URLSearchParams` re-serialises a space as `+`: MEASURED,
`?options=-c%20timezone%3DUTC` survives one `set()` as
`options=-c+timezone%3DUTC`, which node-pg accepts silently and libpq answers
with `FATAL: unrecognized configuration parameter "+timezone"`. The app would
look fine while psql, pg_dump and the migrate CLI broke. `check:session-timezone`
rule R4 refuses it.

`ALTER SYSTEM` and a hand-edited `postgresql.conf` are both rejected for one
reason: neither is in a backup, so a DR rebuild drops them silently — which is
the exact failure this change exists to close. The compose `command: -c
timezone=UTC` is the version-controlled equivalent.

### THE HALF THAT MAKES THE FIX SAFE

Pinning the client alone is the single actively dangerous version of this change.
A bare partition-bound literal is resolved in the CREATING session's zone, so
once the application is UTC while `prisma migrate deploy` inherits the server
default, the two disagree at the seam. MEASURED, from the same month-start
strings:

```
  audit_log_2026_09  [2026-08-31 21:00+00, 2026-09-30 21:00+00)   Athens session
  audit_log_2026_10  [2026-10-01 00:00+00, 2026-11-01 00:00+00)   UTC session
```

A three-hour hole, which Postgres accepts silently at DDL time, and which
`audit_log` — with no DEFAULT partition, deliberately — turns into a hard `23514`
on every audited write for those three hours.

So `partition-maintenance.job.ts` now emits an explicit `TIMESTAMPTZ '… +00'`
bound for a `timestamptz` key, and REFUSES a table whose existing bounds are not
UTC day boundaries rather than adding one beside them. A `date` key is left
alone: `circulation_statistics` is keyed on a `date`, its bounds carry no zone,
and a zoned literal there would introduce the defect where none exists.

The test for "is this bound right" is **midnight UTC, not ends-in-`+00`**. On a
UTC session Postgres renders every bound with `+00`, including an Athens-created
one, which comes back as `'2026-08-31 21:00:00+00'`. Suffix-matching passes
exactly the rows it exists to catch; it was written that way first and the
falsification caught it.

### What is proved, and how

`apps/api/test/integration/session-timezone.spec.ts` makes its OWN database and
pins it to `Asia/Kolkata` — so it discriminates identically on a developer's
Athens cluster and on CI's UTC one, with no `verify.yml` change to drift.
`Asia/Kolkata` because `+05:30` has no DST (an Athens expectation would be +2 in
winter and +3 in summer) and because the half hour exercises the optional-minutes
branch of the adapter's own regex. Three designs were rejected: a `TZ` on the CI
service protects only CI; a spec that calls `SET TIME ZONE` itself INVERTS,
because a session `SET` is `PGC_S_SESSION` and outranks the option; and asserting
the literal is the gate, not the test.

FALSIFIED, once, deliberately: with `PG_SESSION_OPTIONS` removed the spec fails
by exactly 19,800,000 ms on the discriminator and 3,600,000 ms on the
spring-forward case, while the three database-pin assertions still pass — which
is the two layers being distinguished rather than one assertion covering both.

`scripts/check-session-timezone.ts` is the static half, and it has to be static:
the runtime check cannot fail on the machines that run it. Each of its four rules
was proved to fire by planting a violation.

### The repair, and the row values it refuses to invent

`scripts/tenant-timezone-audit.ts` reports every database's true default, every
partition on a local midnight, and how many rows it holds; `--pin` applies the
pin idempotently and REFUSES a database that is both populated and skewed,
printing the re-provision command instead — because pinning is what surfaces the
shift and opens the seam.

It does not rewrite row values, and the reasons are worth keeping:

1. NO WITNESS. Correcting a row means knowing it was written in the shifted
   frame. Almost everything in `lbr2` is Prisma-written, so almost nothing has
   an unshifted sibling to compare against; the one column a non-Prisma writer
   fills is `change_events.occurred_at`, which covers a fraction of the rows
   and only while `xmin` is unfrozen — `track_commit_timestamp` is off.
2. THE SHIFT IS PER-ROW — the offset at that row's own nominal instant, so a
   blanket interval is wrong for half the table.
3. IT IS NOT INVERTIBLE. In the spring-forward hour two inputs produced one
   stored value; in the autumn overlap one value has two pre-images.
4. THE FRAMES ARE MIXED IN ONE COLUMN wherever a trigger and Prisma both write.

The local estate at the time of the fix: 887 databases, 886 without a pin, 380
with partitions on local midnight — and every one of the 380 holding **zero**
rows. So the honest repair is to pin and re-provision, and it costs nothing
today.

### Measured

```
  integration suite on the Athens cluster   533 -> 1,714 tests, all green
  partitions after the pin, via migrate     FROM ('2026-06-01 00:00:00+00')
  before the pin                            FROM ('2026-06-01 00:00:00+03')
  falsification: option removed             discriminator off by 19,800,000 ms
                                            DST case off by 3,600,000 ms
  local estate                              887 databases / 886 unpinned /
                                            380 skewed / 0 rows in any of them
```

### Decisions worth their sentence

**`@db.Date` is NOT affected, and the fix must not claim it.** MEASURED across
four instants × two session zones × two process `TZ`s: the adapter sends a date
built from `getUTCFullYear/Month/Date` and its read normaliser is the identity,
so `holds.suspended_from` and every other civil date already landed on the right
day. Phase 17's `civilDate()` was correct.

**The statistics rollup's month is now explicit, and is still the wrong month.**
`date_trunc('month', now())` resolved in the session zone, so the job's
"September" was whatever the connection happened to be. It now says `AT TIME ZONE
'UTC'`, which is what every deployed cluster already computed — no deployed
answer changes. But `46-circulation-events.prisma` documents `period_start` as
"the first day of the month, in the BRANCH's timezone", and a Greek library's
September is the Athens month. That is a statutory ISO 2789 figure and a product
decision for phase 26, not a timezone bug; what this change does is stop two
cancelling errors from hiding it.

**`@default(now())` is materialised CLIENT-side.** MEASURED: a `create()` that
omits the column still names it in the INSERT and binds a JS Date, so all 49
`DEFAULT CURRENT_TIMESTAMP` columns in `lbr2` are dead code on the Prisma path —
and `created_at` was shifted like everything else. Nothing in 2.0 may rely on "the
database stamps this".

**One definition, in `packages/shared`.** Both `db-tenant` and `db-control`
depend on it and it depends on nothing. Three copies of a string is three chances
for one to be edited, and the failure mode of the odd one out is this whole
entry, on one connection pool.

**Production is UTC, and it is worth confirming rather than believing.**
`docker-compose.prod.yml` passes no `TZ` to the `postgres:16-alpine` service, so
the session is UTC and the exposure is latent rather than live. The host is
Berlin (RUNBOOK) — which affects the app container's clock, not the Postgres
session — so one `SHOW TimeZone` against the production database is the cheap way
to be certain rather than persuaded.

---

## Phase 18 — the fees ledger

Eleven tables, six enums, one generated column added to a table phase 9 left
waiting, and the two foreign keys `fees.account_id` and `fees.fee_type_id` have
been carrying as bare text since the baseline. The migration header
(`20260916090000_fees_ledger`) carries the six decisions; this entry records
where the phase DIVERGED from §3 and §6, and the one measurement that changed
the design.

### THE ACCRUAL IS A RECOMPUTED TOTAL, NEVER AN ADDED WINDOW

`accrueOverdue` takes an optional `since`, and its own docblock offers it as
"`fees.accrued_through` for an increment". That documented usage is
arithmetically wrong. Measured on this tree, six nights overdue at EUR 1.00 per
interval, recomputed-total against nightly-windowed:

| policy                           | total | windowed |                                 |
| -------------------------------- | ----- | -------- | ------------------------------- |
| daily, `chargeAt: intervalEnd`   | 600   | 600      | agree                           |
| daily, `chargeAt: intervalStart` | 700   | 1200     | **+EUR 5.00**                   |
| every 3 days, `intervalEnd`      | 200   | **0**    | **the patron is never charged** |
| every 3 days, `intervalStart`    | 300   | 600      | **doubled**                     |
| daily + `minimumFine` EUR 2.00   | 600   | 1200     | **doubled**                     |

Three independent causes, all in `packages/circ-policy/src/fines.ts`:
`completed` is `floor(elapsed) + 1` for `chargeAt: 'intervalStart'`, so a nightly
window adds a spurious interval EVERY night; `intervalsBetween` returns a
FRACTION, so floor is not additive — `floor(4/3)` is 1 while
`floor(2/3) + floor(2/3)` is 0; and `minimumFine` is a per-call floor, so a
nightly sweep applies the library's minimum once a night.

**No reconciliation identity catches this.** The ledger balances perfectly on a
number that is double, which is why it is recorded here rather than in a commit
message. `fee-accrual.ts` recomputes the total from `dueAt` every tick and posts
`total − what the receivable already carries`; the delta is derived from the
LEDGER rather than from a remembered number, so the DATA-1 race cannot double it.

### `fees.owed_cents`, because two readers already disagreed

`patrons.service.ts` summed fees `WHERE outstanding_cents > 0`.
`circulation-state.ts` — the gate that blocks a checkout — summed them
`WHERE closed_at IS NULL`. They agreed only because nothing wrote `fees`. A
CANCELLED charge closes the row without moving a settlement counter, so from the
first void the same patron would have had two different balances at one desk.
A second generated column deletes the class; both readers now ask it, and so
does identity I3.

### Divergences from §3

**`cash_drawer_movements` is DESIGNED AWAY, not deferred** (`dropped` in
BASELINE-SCOPE). Every cash movement is already an `account_entries` row on
`cash_on_hand` whose transaction names the session, so the expected total is
`opening_float_cents + SUM(debit_cents − credit_cents)`. A movements table would
be a SECOND recording of the same fact, and a cash count is worth taking only
because it is an INDEPENDENT check on the journal.

**`fee_payment_intents` → phase 33, `payment_terminals` → phase 34.** Phase 18
takes money at a desk with a librarian present, so there is no intent to hold and
no device to speak to. A wrong guess in a PCI-adjacent table is worse than an
absent one. `refunds_payable` lands with the first of those.

**The chart of accounts is an ENUM, not a `ledger_accounts` table.** A tenant
that can delete an account is a fee that posts nowhere. What a library actually
configures is which of three revenue labels a `fee_type` posts to.

**Tax is not wired.** Every charge posts `tax_cents = 0`. All three candidate
designs for this phase credited VAT at charge time and never reversed it on a
waiver, a write-off or a refund, so the library would have remitted tax on money
it never collected. The column and the `tax_payable` label stay so the leg set
does not change shape later.

### I1 is a database law, and the shape that follows from it

`account_entries_balance` is a STATEMENT-level `AFTER INSERT` trigger with a
transition table, not a nightly report and not a `DEFERRABLE INITIALLY DEFERRED`
constraint trigger. The deferred form is also a law but fires at COMMIT, so a
mistake in the fee module would abort the librarian's CHECKIN with a stack trace
pointing at the commit — handing back exactly what phase 16 spent a design on.

The side effect is the point: a journal must be posted in ONE insert, so
`postJournalWithin` is the only way to write an entry.

**Its body resolves through `TG_TABLE_SCHEMA`.** It was first written with
unqualified names — the identical mistake phase 9 made in
`lbr2_write_change_event()` — and the psql probes passed because they set a
`search_path`. The integration suite caught it on the first application write.
A pinned `search_path` also works and is refused for `20260908090000`'s reason:
it stores the schema NAME, which phase 20's `ALTER SCHEMA lbr2 RENAME TO public`
invalidates.

### Waiving an accruing fine stops the clock — a product decision, recorded

`fees_one_open_accrual_per_loan` is predicated on `closed_at IS NULL`, so a
waived accrual leaves the arbiter while the loan is still open and the next sweep
raises a SECOND fine against the same loan: the reader is forgiven and charged
again the same night. Two honest fixes exist and they are different products.
Keeping the row open with a zero balance lets the fine keep growing and breaks
"closed_at means settled". Stopping the accrual says that forgiving an overdue is
a decision about THIS LOAN, which is what a librarian means when they waive a
fine for a reader who was ill. `waive` therefore sets `is_accruing = false`.

### What the tests prove, and what they cannot

The 10,000-operation property test is DETERMINISTIC (a fixed LCG seed), so a
failure is reproducible. The identities are asserted at intervals and at the end
rather than after every operation: they are whole-table aggregates and asserting
each step is quadratic, while a drift introduced at step 4,000 is still there at
step 10,000. It was falsified once — planting a one-cent gap between an
allocation and its counter makes I2 report three fees while I1 and I3 stay clean,
which is the right diagnosis and not merely a failure.

**Concurrency is NOT asserted inside it.** The per-tenant pool is clamped to one
connection, so `Promise.all` over services queues rather than interleaves; a
concurrency claim there would be vacuous. The genuinely simultaneous cases —
DATA-1's return racing the accrual sweep, and two desks closing one drawer —
need their own harness on separate `pg` clients, which is phase 21's to write
alongside the checkin that first calls `accrueWithin`.

---

## Phase 19a — the surface the upgrade lands on

§6 gives phase 19 one line. It is 7,500–9,000 lines of work, two to three times a
normal phase here, so it ships in two: **19a** builds everything the copy-forward
needs to exist before it runs and cannot create for itself; **19b** writes the
copy-forward, the ~40-assertion verifier, the fixture and the CI job. The split
is not administrative — two of the three things in 19a are impossible to do in
the same transaction as the migration that uses them.

### The routing manifest is the real deliverable

`prisma/upgrade/routing.json` gives every one of the 233 columns in the 1.0
datamodel exactly one verdict — copied, derived, dropped with a reason, or
carried verbatim as a compat twin — and `check:upgrade-coverage` fails the build
on a column with no entry, an entry for a column that no longer exists, and a
drop whose reason is a shrug.

It exists because of a measurement, not a principle. Three independent designs
for this phase were written from the same survey, and **all three silently lost
the same four things**:

| lost by all three                          | consequence                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `tenant_settings.lostItemFeesEnabled`      | a library that charges €25 for a lost book                                         |
| `tenant_settings.lostItemDefaultFeeCents`  | starts charging the seed default, unrecoverably                                    |
| the four `notify*` settings                | overdue notices ON comes up OFF                                                    |
| `book_authors.role` on the order-0 creator | a book whose first listed creator is a TRANSLATOR is migrated as having written it |

None of those is a bug in a transformation. Each is a column nobody considered,
and no amount of care finds the fifth one — the transformation is written from
the 2.0 side ("what does `patrons` need?"), so a 1.0 column with no obvious home
is never rejected, it is never mentioned. Writing the manifest also immediately
found three defects in its own author's work.

### `ALTER SCHEMA public RENAME` is more dangerous than §8 risk 3 says. MEASURED.

Probe database, PG 16.15, three dependency shapes:

| dependency                                      | after `ALTER EXTENSION … SET SCHEMA` |
| ----------------------------------------------- | ------------------------------------ |
| operator class in an index (`gin_trgm_ops`)     | **survives** — stored by OID         |
| a function named inside another function's body | **breaks** — stored by name          |
| an expression index over that wrapper           | **breaks, AND TAKES READS DOWN**     |
| `citext` comparison semantics                   | **SILENTLY CHANGES**                 |

With an unqualified expression index present, `SELECT count(*)` fails with
`function public.unaccent(unknown, text) does not exist`. Dropping the index
restores reads; `CREATE OR REPLACE` on the wrapper plus recreating the index
restores everything. Risk 3 anticipated this.

It did not anticipate the fourth row. The `=` OPERATOR is resolved through
`search_path`, so with citext's operators off the path both sides are implicitly
cast to `text`:

    default search_path              mail = 'a@b.GR'  ->  FALSE
    search_path incl. extensions     mail = 'a@b.GR'  ->  TRUE
    explicit ::citext cast, default                   ->  FALSE

Measured on a real tenant: the search_path is `"$user", public`, citext lives in
`public`, `lbr2.patrons.email` IS citext, and `'ΑΒΓ@x.gr' = 'αβγ@x.gr'` is true
today. `40-circulation.prisma` chose citext so that "a library that types
`Α.Παπαδοπουλου@…` and one that types `a.papadopoulou@…` mean the same patron".
Relocating it makes every Greek patron email lookup case-sensitive with NO ERROR,
and after the rename `public` on the search_path names nothing, so doing nothing
is not an option either. 19b needs an `ALTER DATABASE … SET search_path` in
phase 17's UTC-pin shape and a verifier assertion that tests citext equality BOTH
ways, because no row count would ever show this.

### "Bit-exact queue positions" cannot survive, and that is a divergence

§6 asks for bit-exact positions; the acceptance line says "contiguous and
identical". 1.0 has no uniqueness on `(bookId, queuePosition)` and the blanket
`> 0` decrement that phase 17 documented produces position 0 and duplicates —
both of which `holds_position_is_one_based` and `holds_one_hold_per_position` now
refuse. A bit-exact copy cannot commit.

Two assertions replace the one: ORDER is preserved exactly, always; NUMBERS are
identical for every bib whose 1.0 positions were already dense, 1-based and
unique, and elsewhere are renumbered with the renumbered count reconciled against
a recorded counter. The lossy half is visible rather than assumed away.

### Why the compat twins are not snake_case

Eleven 1.0 tables have no 2.0 successor and are still LIVE at the cutover: the
authorization five, which every `PermissionGuard` call reads on every request;
`field_definitions`; the collections three; and the two `_libriant_*` tables. At
the cutover `public` becomes `v1_archive` and the 1.0 Prisma client keeps serving
until phase 20 deletes it — resolving bare names through `search_path` and
generating quoted camelCase and `CAST($1::text AS "PermissionEffect")`.

So a conventions-abiding twin is a twin the surviving client cannot read, and the
symptom is a library locked out of its own roles table on cutover day. The twins
keep 1.0's physical shape verbatim, the three 1.0 enum types are recreated in
`lbr2` under their 1.0 names, and `check:schema-conventions` carves the eleven
out as a CLASS with one reason — plus a ceiling and a staleness check, so the
carve-out cannot quietly become somewhere to put a 2.0 table.

### Two enum values that cannot wait

MEASURED on PG 16.15: `ALTER TYPE … ADD VALUE` inside a transaction is accepted
and persists; USING the value in that same transaction raises `unsafe use of new
value`, and the abort rolls the ADD VALUE back with it. The copy-forward is a
single transaction by design, so it cannot add its own. `ledger_account.opening_balance`
and `event_source.migration` land here, days earlier, and nothing in 19a uses
them.

`opening_balance` rather than `cash_on_hand`: a fine paid in 2019 did go into a
till, but that till was counted and banked years ago, and posting it now would
inflate the trial balance of a library that has just started keeping one by every
fine it has ever taken.

`migration` rather than `desk`: every other value names a place a human or a
device acted, and labelling forty thousand migrated rows `desk` would put
fictional counter activity into every report that groups by source. The value is
added to the READ-side union in `loan-read.service.ts` and deliberately NOT to
the nine write-side unions — a librarian cannot perform a migration, and widening
the inputs would let a caller post an event claiming to be the upgrade months
after it ran.

### Five columns, and `owed_cents` learns about archiving

`loans.notes` and `fees.notes` are real columns. Folding a loan's note into
`loan_events.note` on the `returned` event — the tempting alternative — drops the
note of every ACTIVE and every LOST loan, precisely the ones that say "borrower
says posted back" and "lost report filed", and a note about a debt has nowhere
else at all because `fees` has no event table.

`fees.archived_at` is separate from `status = 'cancelled'`: 1.0 soft-deletes a
fine, a PAID fine can be archived, and collapsing the two loses the archival and
leaves a settled debt looking live. Phase 18's `owed_cents` is regenerated to
read it, because a library's balance must not include debts it has filed away.

---

## Phase 19b — the copy-forward, and what running it found

19a built the surface; this is the transformation, the 42-assertion verifier, the
deterministic fixture and the CI rehearsal. It runs end to end against a real
1.0 library and **rolls back**: there is no `--commit` in phase 19, and no
environment variable that makes one.

### Three corrections to what 19a wrote

**Position 0 is impossible in 1.0.** 19a said the blanket `> 0` decrement
"produces position 0 and duplicates". Measured against a real 1.0 schema, 1.0
carries `reservations_queue_position_when_queued`
`CHECK (status <> 'queued' OR ("queuePosition" IS NOT NULL AND "queuePosition" >= 1))`,
so a zero is refused at the source and that decrement would ABORT there rather
than commit one. The claim came from the design review and was repeated without
checking 1.0's own constraints. What 1.0 genuinely lacks is any uniqueness on
`(bookId, queuePosition)` — `reservations_bookId_status_queuePosition_idx` is a
plain index — and any density guarantee, so DUPLICATES and GAPS are reachable.
Bit-exact still cannot survive; the reason is duplicates and gaps, not zeros.

**§6's rollback recipe is not yet the right one.** It reads
`DROP SCHEMA public CASCADE; ALTER SCHEMA v1_archive RENAME TO public;` and,
measured against a committed clone, fails with `schema "public" does not exist`.
It has to: this phase renames `public` away and puts nothing in its place,
because promoting `lbr2` is phase 20's job. Before that promotion the rollback is
one statement — `ALTER SCHEMA v1_archive RENAME TO public` — verified to restore
1,000 books, 500 members, 800 loans, 150 fines, `roles` readable through the
default search_path, a Greek title intact and citext still folding. §6's two-step
becomes correct the moment phase 20 renames `lbr2`, and is the wrong instruction
to leave in a runbook before then.

**The SQL-construct trap list is longer than this repo had written down.**
Measured on PG 16.15, `pg_catalog.<x>` is a syntax error or an unknown function
for `COALESCE`, `NULLIF`, `GREATEST`, `LEAST`, `CASE`, `EXTRACT(x FROM y)` and
`SUBSTRING(x FROM y)` — and works for everything else tested, including
`to_jsonb`, `jsonb_build_object`, `date_part`, the two-argument `substring`,
`format`, `to_char`, `string_agg` and `date_trunc`. The FROM-forms are the
dangerous half: they read like function calls and fail at PARSE time, so a file
containing one does not run at all. This phase hit `substring(x FROM y)` and
`greatest` in one sitting.

### What the verifier caught that nothing else would have

It runs INSIDE the transaction, before the commit, which is the only reason
these were findings rather than production defects.

**An archived-but-PAID fine credited the receivable twice.** 19a made
`owed_cents` see `archived_at`, so an archived fee owes nothing — but its charge
journal still debited the receivable and nothing credited it back, so I3 failed
by the archived total. The first fix cancelled the gross, which then
double-credited every archived fine that had already been paid and left the
account NEGATIVE by exactly what the reader had handed over. The cancellation
reverses only `amount − paid − waived`.

**A `ready` request with no copy cannot be loaded at all.**
`holds_collectable_implies_assigned` refuses a hold awaiting pickup without an
assigned copy. Expiring those would destroy a live, notified request and leave no
row saying a reader lost their place, so they return to the HEAD of their queue
and the demotion is recorded in `upgrade_exceptions`. The queue position is now
derived from the same predicate `holds_position_iff_waiting` uses, rather than
from the 1.0 status, so the two cannot disagree on a row with an inconsistent
combination.

**Corruption and a business rule must not share a fate.** A zero-amount fine is
legitimately dropped — 2.0's CHECK will not hold it — while a dangling reference
means 1.0's own foreign keys were bypassed and the database is not sound. Both
are recorded in `upgrade_dropped_rows`; only the second aborts, because its
reason begins `DANGLING:` and assertion A14 refuses it by name. Recording AND
refusing is not a contradiction: the record is what tells an operator which row,
and the assertion is what stops the commit.

### The precondition that would have merged two libraries

`lbr2` must be provisioned, seeded and EMPTY. The first full run went against a
clone whose `lbr2` still held 4,552 fees from the phase-18 property test, and the
symptom was a foreign-key violation a hundred statements later naming an id
nobody recognised. The general case is worse — an upgrade into a populated
`lbr2` merges two libraries, silently, with no undo after a commit — so the
orchestrator now refuses before `BEGIN` and names what it found.

### Why `marc_source_format` gained a value

The four existing values name serialisations a record was parsed from, plus
`manual` for a human typing into the editor. A record built from a 1.0 `books`
row is none of those. `manual` was refused: this column is provenance and
nothing else, and labelling fifty thousand generated records as hand-catalogued
is a false statement about work nobody did — in the one column a cataloguer
consults to find out where a record came from. It also explains why
`source_blob` is NULL and `source_roundtrips` is false on all of them.

### The fixture is deterministic, and its SHAPES are the point

A fixed LCG, no clock, no `Math.random`: a migration that fails once in CI and
never again is worse than one that fails every time, because the second can be
fixed. The `ci` profile is 1,000 books and runs on every commit; §6's 50,000-book
fixture is `acceptance` and belongs on a schedule. The split only works because
every awkward shape is in BOTH — a Greek title with a leading article, a
translator at order 0, an orphaned author, a bad ISBN check digit, a language
outside ISO 639-2/B, a member with no email, duplicate queue positions, a `ready`
hold with no copy, a zero-amount fine, an archived-but-paid fine, audit rows
spread across months. A fast fixture that is merely SMALLER tests a different
library.

## Phase 20a — the read surface, and three measurements phase 20b must act on

### The Greek acceptance case was never asserted, and now is

§9 names one acceptance case for the whole phase-1 programme —
`foldGreek('ΠΟΛΙΣ') === foldGreek('πολισ')`, and §6 restates it as "Greek
regression: `πολισ` now finds `Η ΠΟΛΙΣ ΕΑΛΩ`". Three tests circle it and none of
them issues a query: `greek.test.ts` proves the function's arithmetic over 854
vectors, `greek-folding-parity.spec.ts` proves the SQL twin agrees, and
`bib-projection.spec.ts` proves `search_text` comes out with no final sigma.

All three are true and none is the claim, because the claim is about a SEARCH and
`lbr2` had no endpoint to search. That is exactly how the defect survived 1.0:
the fold was a property of a column nobody interrogated.

It needed NO migration, which is worth recording because the obvious move is
wrong twice. `libriant_fold_greek` is installed by no migration — only by a spec
that creates and rolls it back — so `WHERE libriant_fold_greek(search_text) LIKE
…` would throw; and had it worked it would have defeated `bib_records_search_trgm`,
which is on the column and not on a function of it. Both sides fold with the same
function in Node. That is the design, and it is why the phase is additive.

### G03 is vacuous. MEASURED.

`03-verify.sql` assertion G03 — "no expression index is left pointing at a
relocated function" — is one of the 42 the cutover's safety rests on, and it
cannot fail. Measured on a real migrated tenant:

    indexes in lbr2 mentioning unaccent, before any rename   0
    G03 predicate, before the rename                         true
    G03 predicate, after  the rename                         true
    any index ANYWHERE rendering the text 'public.'          0

Three independent reasons, each sufficient. It runs after `ALTER SCHEMA public
RENAME TO v1_archive`, and at that moment no schema named `public` exists —
`pg_get_indexdef` renders from OIDs, so no index in any schema can emit that
substring. Even before the rename the string is not there: the poison lives in
`pg_proc.prosrc`, which `indexdef` never renders, and the index itself is written
unqualified. And `schemaname = 'lbr2'` excludes the only schema a surviving 1.0
expression index could be in, which is `v1_archive`.

This is worse than a missing assertion. It sits in the green list of 42 and reads
as coverage for a class nothing checks. The same question over `pg_proc` DOES
discriminate, and answering it across every tenant database on the host returns
zero — so the class is empty in population as well as unchecked. Phase 20b should
replace G03 with the `pg_proc` form and a pre-flight that REFUSES, rather than
build the drop-and-recreate machinery §8 risk 3 promises for a case no database
this repo produces is in.

### `DROP SCHEMA v1_archive CASCADE` deletes live 2.0 data, as a NOTICE

The one to act on. Every tenant extension lives in `public`, and an extension
goes WITH its schema, so after the promotion they are all inside `v1_archive` —
the schema phase 20b is meant to delete. Measured, on a clone of a real tenant,
with `ON_ERROR_STOP=1` set and sailing straight through:

    ALTER SCHEMA public RENAME TO v1_archive;
    ALTER SCHEMA lbr2   RENAME TO public;
    DROP SCHEMA v1_archive CASCADE;
    NOTICE:  drop cascades to 44 other objects
      drop cascades to column email of table patrons
      drop cascades to index bib_records_search_trgm
      drop cascades to index patrons_search_trgm
      drop cascades to constraint calendar_hours_no_overlap on table calendar_hours
      drop cascades to constraint calendar_exception_hours_no_overlap …
      drop cascades to constraint fixed_due_date_ranges_no_overlap …

Every patron email address in the LIVE 2.0 schema, both search indexes, and all
three no-overlap invariants — including the one §3 introduces with the words
"Double-booking is IMPOSSIBLE, not unlikely". Announced as a NOTICE, so nothing
in a normal script stops.

The cure is six statements, and they belong INSIDE the cutover transaction,
between the promotion and the commit:

    ALTER EXTENSION unaccent   SET SCHEMA public;   -- and pg_trgm, citext,
    ALTER EXTENSION …          SET SCHEMA public;   -- pgcrypto, btree_gist, btree_gin

Two consequences follow for 20b. The post-promotion assertions can and should run
in the same transaction under `SET LOCAL search_path TO "$user", public` — that
IS the application's path, so a citext lookup that has silently become
case-sensitive fails the upgrade rather than being discovered by a librarian. And
§6's rollback recipe needs rewriting a second time: `DROP SCHEMA public CASCADE;
ALTER SCHEMA v1_archive RENAME TO public` destroys the 1.0 archive it exists to
restore once the extensions have correctly moved. 19b already recorded that the
recipe fails with `schema "public" does not exist`; this is the other half.

### A live defect the cutover would have cured by accident

`lbr2.branches_guard_cycle()` and `lbr2.branches_recompute_descendant_depth()`
name `branches` unqualified. A PL/pgSQL body is re-parsed at RUN TIME under the
CALLING session's search_path, so both resolved in the phase-9 migration session
and have never resolved since: a library cannot save a second branch.

Nothing caught it because the only path that reaches the lookup is a branch WITH
a parent and provisioning seeds exactly one root — and because the smoke harness
sets `search_path = lbr2, public`, which makes the trigger resolve perfectly in
the place that is supposed to be checking it. The regression test now connects
the way the application does, through `appPathQuery`.

Fixed with `TG_TABLE_SCHEMA` rather than a pinned path, because a pin naming
`lbr2` breaks at the rename. The point for the log is the timing: phase 20's
promotion would have CURED this by accident, and a fix that arrives that way
looks unnecessary and gets removed. It was found by investigating the rename and
turned out to predate it.

## Phase 20b-i — the cutover made executable, and nothing deleted

Phase 20 was one session in §6 and is now three. 20a built the read surface the
cutover had nothing to repoint at. This is the mechanism: the upgrade can now
actually commit, it promotes `lbr2` as §6 says, and the rollback is a script
rather than a recipe. **Nothing is deleted and no tenant is cut over.** The five
1.0 modules, the 35 screens and the thirteen consumers outside them are 20b-ii.

### The promotion was kept, against the measurement, and here is that measurement

`lbr2` is bound by one constant — `V2_SCHEMA` in `packages/db-tenant/src/v2.ts`
— so promoting it to `public` is optional. Measured on clones of a real migrated
tenant, not promoting is strictly safer and very much smaller:

|                                                    | promote `lbr2` → `public`                                                             | archive only, keep `lbr2` |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------- |
| `DROP SCHEMA v1_archive CASCADE` (extensions left) | 44 objects, incl. `patrons.email`, both trigram indexes, all 3 no-overlap constraints | 32 objects, all 1.0's own |
| citext lookup after cutover                        | 1 → **0**, silently, via a Seq Scan                                                   | 1 → 1                     |
| `lbr2.` references to rewrite                      | **186 across 39 files**                                                               | 0                         |

The operator chose the promotion, which is §6's plan of record, and it is built
that way. The record is here because the trade is real: the promotion is
correct, it is not free, and every hazard below exists only because of it.

### Extensions move with their schema, and that is the whole danger

All six live in `public`, so `ALTER SCHEMA public RENAME TO v1_archive` carries
them into the archive — where they are still the extensions the PROMOTED schema
depends on. `patrons.email` is citext; both trigram indexes use `gin_trgm_ops`;
all three no-overlap EXCLUDE constraints use `gist_*_ops`.

Left there, `DROP SCHEMA v1_archive CASCADE` deletes live 2.0 data and says so
as a **NOTICE**, which `ON_ERROR_STOP=1` does not stop. Verified by running it.

So the cutover moves them, in the same transaction as the promotion:

    ALTER SCHEMA lbr2 RENAME TO public;
    ALTER EXTENSION unaccent|pg_trgm|citext|pgcrypto|btree_gist|btree_gin
      SET SCHEMA public;

Measured after: 147 tables in `public`, 23 in `v1_archive`, 0 extensions outside
`public`, `patrons` readable unqualified, and `DROP SCHEMA v1_archive CASCADE`
down to 32 objects that are all 1.0's own.

The relocation is deliberately NOT a loop over `pg_extension`. That would
silently move whatever a DBA had installed by hand; the six are enumerated, and
a seventh is a refusal rather than a guess.

### The post-promotion assertions run under the application's own search_path

`03-verify.sql` asks whether the DATA came across, under the copy-forward's path.
`04-promoted.sql` asks whether the database still WORKS, under `"$user", public`
— which is what a tenant connection actually holds, and the only path under which
the failure is visible at all. Phase 19a measured why:

    default search_path             mail = 'a@b.GR'  ->  FALSE
    search_path incl. extensions    mail = 'a@b.GR'  ->  TRUE

The `=` operator resolves through search_path, so with citext's operators off it
both sides cast to `text` and every duplicate-patron check in the product turns
off at once, with no error. A qualified assertion would pass on a database where
the application is already broken.

Eight assertions, H01–H08, all inside the transaction so a failure rolls the
whole cutover back.

### G03 replaced, because it could not fail

Measured three ways on a real tenant: 0 indexes in `lbr2` mention unaccent at
all; the predicate is `true` before the rename and `true` after; and post-rename
**no index anywhere in the database renders the text `public.`**, because
`pg_get_indexdef` renders from OIDs and no schema by that name exists.

The real question is over `pg_proc`. A SQL or PL/pgSQL body is stored as TEXT and
re-resolved at RUN TIME — the only category a schema rename can break, which is
why every trigram index and EXCLUDE constraint survives untouched. The new G03
asks that, and it DISCRIMINATES: on a database poisoned with phase 2's own
fixture shape the new form returns `false` where the old returns `true`.

The same question also runs as a pre-flight, before `BEGIN`. It REFUSES rather
than repairing: the correct rewrite of a library's own function body depends on
what the author meant, and a wrong guess produces a function that runs and is
wrong. Across every tenant database on the host it returns nothing, so it costs
one statement and fires for no one — but it fires before the transaction rather
than a hundred statements into the copy-forward with `regproc.c:1440`.

### §6's rollback is wrong in both directions

19b measured it failing with `schema "public" does not exist`, because that phase
renamed `public` away and put nothing back. After the promotion a `public` exists
again, so the statement now runs — and that is worse. It succeeds and destroys
the archive it exists to restore:

    NOTICE:  drop cascades to 148 other objects
      drop cascades to extension unaccent / pg_trgm / citext / pgcrypto / …
      drop cascades to column email of table v1_archive.members
      drop cascades to index v1_archive.books_search_trgm  (and three more)

The library comes back with no member email column, no search indexes, and
plpgsql as its only extension.

`scripts/tenant-rollback-v2.ts` sends the extensions home first, and it is a
script rather than a runbook entry because a three-step recipe that must be run
in order is a script. Measured: 6 extensions survive, `members.email` survives,
all four 1.0 trigram indexes survive, citext still compares case-insensitively,
and 1,000 books / 500 members / 800 loans read back unqualified. It refuses to
run twice — the second run would drop the library it had just restored.

### CI cuts a database over for real

Every earlier step rehearsed and rolled back, which proves the copy-forward and
nothing about the two statements that actually cut a library over. Two new jobs
commit on disposable databases: one asserts the committed shape and then DROPS
the archive to prove that is now safe, the other rolls back and reads the 1.0
library out again. Both check that the flags refuse without `--yes`, and that a
second rollback refuses.

### What 20b-ii faces, measured before it starts

A six-way read-only sweep of the deletion surface ran while 20b-i was built.
Four probes returned before the session limit; their numbers are recorded here
because they contradict §6's sizing badly enough that planning from §6 alone
would produce an outage.

**Of the 46 1.0 routes: ZERO have a clean drop-in equivalent.** 25 have one whose
request or response shape differs, usually both, and **21 have none at all**. The
hole is the write side: 20a built reads, and phases 10–18 built a DIFFERENT write
model rather than a renamed one.

What has no 2.0 successor at all, and must be built or consciously lost:

- **GDPR Article 17 erase.** `MembersService.erase()` is the product's only
  implementation and it sits inside a directory §6 says to delete. 2.0 never
  writes `patrons.erased_at` — the column is read in three places and written in
  none.
- **GDPR Article 15/20 subject access.** `GET /t/:slug/members/:id/data-export`
  is mounted from `privacy/`, OUTSIDE the five directories, so `rm -rf` leaves it
  live and serving from 1.0 models. `BUNDLE_TABLES` in `patron-data-map.ts` has
  zero consumers: the map is a specification, not an implementation. 20b-ii must
  WRITE the bundle.
- **The patron write surface is a third of the member one.** No read-by-id, no
  update, no status change, no archive, no photo. Seven of the eleven member
  routes have no successor.
- **Authors, entirely.** Five routes. No `Author` model in schema-v2, and an
  authority MARC record gets no projection row, so it can never be listed.
- **No delete or archive for a bib record**, no cover upload, no per-hold expire,
  no hold fulfil, and **no overdue-fine sweep** — a patron with an unreturned
  overdue book shows a zero balance at the desk.
- **The bulk import engine has no 2.0 write path.** Eleven routes; all six entity
  kinds write 1.0 tables, and `ImportEntityKind` lives in the CONTROL database,
  which the tenant upgrade does not touch.

Three corrections to §6's own text:

1. §6 says "the four `pages.{en,el}.json` claims". **There are twenty** — ten
   MARC claims and eleven catalogue claims per locale.
2. **The MARC claims were already false before this phase.** `catalog_marc` has
   been a bulk export format since phase 11 and is offered in the tenant UI.
3. **Rewriting the public-catalogue claims would make the site lie.** §6 groups
   two claims into one instruction and only the first is false: the OPAC is
   phase 31. That half must stay as it is.

And a new instance of the G03 vacuity class, created by the promotion itself:
**five integration specs hard-code `table_schema = 'lbr2'`**, including the three
blocks in `patrons.spec.ts` that are the explicit stand-in for the
`check:dsar-coverage` gate §5 defers to phase 33. After `ALTER SCHEMA lbr2
RENAME TO public` each queries a schema that no longer exists and passes green on
an empty result set. The spec's own comment says it "keeps the map honest until
the gate arrives"; after the promotion it keeps nothing honest. 20b-ii must move
them onto the promoted schema name in the same change that promotes it.

`check:dsar-coverage` itself does not exist — not a script, not in `check:all`,
not in the workflow. §5 promises it at phases 33 and 96.
