import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import type { MarcOp, MarcRecord } from '@libriant/marc';

/** Trim once, in one place, so `@Length` measures what actually gets stored. */
const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : (value as unknown)));

/**
 * A content hash as the wire carries it: 64 lowercase hex characters.
 *
 * sha256 over the canonical NFC JSON of the record, excluding 005. The client
 * never constructs one — it echoes back what a read or a previous write handed
 * it — so the only useful validation is the shape.
 */
export const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * The change kinds a client may ask for.
 *
 * Deliberately a subset of the `marc_change_kind` enum. `create` is decided by
 * the endpoint, not by the caller; `restore` is decided by the restore
 * endpoint; and `delete` is not a write. Letting a client label its own edit
 * `merge` would corrupt the retention policy, which keeps every merge forever.
 */
export const CLIENT_CHANGE_KINDS = ['edit', 'import', 'overlay', 'batch'] as const;

export class WriteRecordDto {
  /**
   * The state the caller believes it is editing.
   *
   * REQUIRED on an edit, and this is the whole of the product's optimistic
   * concurrency. A PATCH without it is a lost update waiting for two
   * cataloguers to open the same record — which, in a library, is a Tuesday.
   */
  @IsString()
  @Matches(CONTENT_HASH_RE, {
    message: 'expectedContentHash must be the 64-character hex hash a read returned.',
  })
  expectedContentHash!: string;

  /**
   * The ops, in order.
   *
   * Validated for SHAPE here and for MEANING by `applyOps`, which resolves every
   * path against the record and refuses the batch whole if any precondition
   * fails. Two layers because the shapes are cheap to check and the meanings are
   * not knowable without the record.
   */
  @IsArray()
  ops!: unknown[];

  @IsOptional()
  @IsIn(CLIENT_CHANGE_KINDS)
  changeKind?: (typeof CLIENT_CHANGE_KINDS)[number];

  @IsOptional()
  @IsString()
  @trim()
  @Length(1, 500)
  changeSummary?: string;
}

export class CreateRecordDto {
  /**
   * The record, as MARC-in-JSON.
   *
   * `{ leader, fields: [...] }` — the same shape `packages/marc` reads and
   * writes, so a record can be posted straight from an import or a Z39.50
   * response without a translation layer that could lose subfield order.
   */
  @IsString()
  @Length(24, 24, { message: 'leader must be exactly 24 characters.' })
  leader!: string;

  @IsArray()
  fields!: unknown[];

  @IsOptional()
  @IsIn(['bibliographic', 'authority', 'holdings', 'classification'])
  kind?: 'bibliographic' | 'authority' | 'holdings' | 'classification';

  @IsOptional()
  @IsIn(['marc21', 'unimarc'])
  schema?: 'marc21' | 'unimarc';

  /** 001. Unique per kind among live records, enforced by a partial index. */
  @IsOptional()
  @IsString()
  @trim()
  @Length(1, 100)
  controlNumber?: string;
}

export class RestoreVersionDto {
  @IsInt()
  @Min(1)
  version!: number;

  /**
   * Optional here, unlike on an edit.
   *
   * A restore is usually launched from a version list that was rendered before
   * the reader knew the current hash, and refusing it for that would make the
   * feature unusable. When it IS sent it is enforced exactly as on an edit —
   * so a client that can be precise is not punished for it.
   */
  @IsOptional()
  @ValidateIf((o: RestoreVersionDto) => o.expectedContentHash !== undefined)
  @Matches(CONTENT_HASH_RE)
  expectedContentHash?: string;
}

/**
 * Every op path a client may send must be FULLY INDEXED.
 *
 * `packages/marc` draws this line itself: `parseOpPath` throws
 * `path-not-addressable` on `245$a`, on `008/07-10` and on `245[*]$a`, while
 * the read-only `parseMarcPath` accepts all three. The reason is that a write
 * has to name exactly one thing — a record with three 650s and an op addressed
 * at `650$a` is an op whose meaning depends on which 650 the server picks.
 *
 * So the API accepts `245[0]$a[0]`, `008[0]/07-10` and `LDR/06`, and this
 * message is what a client gets instead of a 500 from deep inside the codec.
 */
const OP_PATH_RE = /^(LDR\/\d{2}(-\d{2})?|\d{3}\[\d+\](\$[a-z0-9]\[\d+\]|\/\d{2}(-\d{2})?)?)$/;

const OPS_WITH_PATH = new Set(['setValue', 'setIndicators', 'insertSubfield', 'deleteSubfield']);
const OPS_WITH_INDEX = new Set(['insertField', 'deleteField', 'moveField', 'setTag']);

/**
 * Ops carrying a `from` precondition, and why a missing one must be a 400.
 *
 * `applyOps` compares `actual === expected.padEnd(actual.length, ' ')`. When
 * `expected` is undefined that is a `TypeError`, not a `MarcError` — so it
 * escapes the codec's own error mapping and surfaces as a 500 with a support
 * code, for what is simply a malformed request. Caught here instead.
 *
 * `from` is not optional in any case: it IS the per-op half of the optimistic
 * concurrency. `expectedContentHash` says "the record has not moved"; `from`
 * says "and this specific value is what I was editing", which is what lets a
 * batch be refused whole rather than half-applied.
 */
const OPS_WITH_FROM = new Set(['setValue', 'setIndicators', 'setTag']);
/** Ops carrying the field or subfield they insert or remove. */
const OPS_WITH_FIELD = new Set(['insertField', 'deleteField']);
const OPS_WITH_SUBFIELD = new Set(['insertSubfield', 'deleteSubfield']);

/**
 * Shape-check the op list before it reaches `applyOps`.
 *
 * Returns the ops typed, or a list of complaints. NOT a class-validator DTO:
 * `MarcOp` is a discriminated union with two different addressing modes (a path
 * for subfield-level ops, a numeric index for field-level ones), and expressing
 * that with decorators produces a validator nobody can read and error messages
 * nobody can act on.
 */
export function parseOps(raw: unknown[]): { ops: MarcOp[] } | { errors: string[] } {
  const errors: string[] = [];
  const ops: MarcOp[] = [];

  raw.forEach((entry, i) => {
    const at = `ops[${i}]`;
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`${at} is not an object.`);
      return;
    }
    const op = entry as Record<string, unknown>;
    const kind = op.op;
    if (typeof kind !== 'string') {
      errors.push(`${at}.op is missing.`);
      return;
    }
    if (OPS_WITH_PATH.has(kind)) {
      if (typeof op.path !== 'string' || !OP_PATH_RE.test(op.path)) {
        errors.push(
          `${at}.path must name exactly one thing — every repeatable level indexed, e.g. ` +
            `"245[0]$a[0]", "008[0]/07-10" or "LDR/06". Got ${JSON.stringify(op.path)}.`,
        );
        return;
      }
    } else if (OPS_WITH_INDEX.has(kind)) {
      const index = kind === 'moveField' ? op.from : op.at;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        errors.push(
          `${at} addresses a field by index, and the index is missing or not an integer.`,
        );
        return;
      }
    } else {
      errors.push(`${at}.op is not an operation this API knows: ${JSON.stringify(kind)}.`);
      return;
    }

    if (OPS_WITH_FROM.has(kind) && typeof op.from !== 'string') {
      errors.push(
        `${at}.from is required: send the value you are replacing, so the edit can be refused ` +
          'if the record moved underneath it.',
      );
      return;
    }
    if (OPS_WITH_FROM.has(kind) && typeof op.to !== 'string') {
      errors.push(`${at}.to is required.`);
      return;
    }
    if (OPS_WITH_FIELD.has(kind) && (typeof op.field !== 'object' || op.field === null)) {
      errors.push(
        `${at}.field is required — on a delete too, because it is what makes the op its own ` +
          'inverse.',
      );
      return;
    }
    if (OPS_WITH_SUBFIELD.has(kind) && (typeof op.subfield !== 'object' || op.subfield === null)) {
      errors.push(`${at}.subfield is required.`);
      return;
    }
    ops.push(op as unknown as MarcOp);
  });

  return errors.length ? { errors } : { ops };
}

/** A posted `{leader, fields}` as a `MarcRecord`, without trusting its shape. */
export function toMarcRecord(dto: CreateRecordDto): MarcRecord {
  return { leader: dto.leader, fields: dto.fields as unknown as MarcRecord['fields'] };
}
