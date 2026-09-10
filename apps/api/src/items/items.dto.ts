import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/**
 * The six schemes `@libriant/shared/callnumber` can build a key for.
 *
 * Written out rather than imported as a runtime value, because `class-validator`
 * needs a literal array at decoration time and the shared constant is a
 * `readonly CallNumberScheme[]` — the compile-time link is the `CallNumberScheme`
 * type on the service input, which fails to build if this list drifts.
 */
const SCHEMES = ['ddc', 'lcc', 'udc', 'nlm', 'alphanum', 'local'] as const;

/** The status vocabulary a librarian may set directly. */
const DESK_SETTABLE_STATUSES = ['available', 'missing', 'in_process'] as const;

export class CreateItemDto {
  @IsString() @Length(1, 64) bibId!: string;
  /** Omit to use, or create, the branch's default holdings record. */
  @IsOptional() @IsString() @Length(1, 64) holdingsRecordId?: string;
  @IsString() @Length(1, 64) itemTypeId!: string;
  @IsOptional() @IsString() @Length(1, 64) materialTypeId?: string;
  @IsString() @Length(1, 64) owningBranchId!: string;
  @IsString() @Length(1, 64) permanentLocationId!: string;
  @IsOptional() @trim() @IsString() @Length(1, 64) barcode?: string;
  @IsOptional() @trim() @IsString() @Length(1, 32) callNumberPrefix?: string;
  @IsOptional() @trim() @IsString() @Length(1, 128) callNumberBase?: string;
  @IsOptional() @trim() @IsString() @Length(1, 64) callNumberSuffix?: string;
  @IsOptional() @IsIn(SCHEMES) callNumberScheme?: (typeof SCHEMES)[number];
  @IsOptional() @trim() @IsString() @Length(1, 32) copyNumber?: string;
  @IsOptional() @trim() @IsString() @Length(1, 128) enumeration?: string;
  @IsOptional() @trim() @IsString() @Length(1, 128) chronology?: string;
  /** Minor units, per §3. Never a float, and never without the branch currency. */
  @IsOptional() @IsInt() @Min(0) priceCents?: number;
  @IsOptional() @IsInt() @Min(0) replacementCostCents?: number;
  @IsOptional() @trim() @IsString() @Length(1, 64) accessionNumber?: string;
  @IsOptional() @trim() @IsString() @Length(0, 2000) publicNote?: string;
  @IsOptional() @trim() @IsString() @Length(0, 2000) staffNote?: string;
}

/**
 * Everything about a copy except where it is and what state it is in.
 *
 * `status` and `currentBranchId` are ABSENT BY CONSTRUCTION, and their absence is
 * the phase's headline claim rendered at the edge of the system. `validateDto`
 * runs `forbidNonWhitelisted`, so a body carrying `{"status": "available"}` is a
 * 400 naming the property — not a silent drop, which would leave a caller
 * believing a status write had happened. Adding either field here is the change
 * `check:item-status-writer` refuses.
 */
export class UpdateItemDto {
  @IsOptional() @trim() @IsString() @Length(0, 64) barcode?: string;
  @IsOptional() @IsString() @Length(1, 64) itemTypeId?: string;
  @IsOptional() @IsString() @Length(0, 64) temporaryItemTypeId?: string;
  @IsOptional() @IsString() @Length(0, 64) materialTypeId?: string;
  @IsOptional() @IsString() @Length(1, 64) permanentLocationId?: string;
  @IsOptional() @IsString() @Length(0, 64) temporaryLocationId?: string;
  @IsOptional() @trim() @IsString() @Length(0, 32) callNumberPrefix?: string;
  @IsOptional() @trim() @IsString() @Length(0, 128) callNumberBase?: string;
  @IsOptional() @trim() @IsString() @Length(0, 64) callNumberSuffix?: string;
  @IsOptional() @IsIn(SCHEMES) callNumberScheme?: (typeof SCHEMES)[number];
  @IsOptional() @trim() @IsString() @Length(0, 32) copyNumber?: string;
  @IsOptional() @trim() @IsString() @Length(0, 128) enumeration?: string;
  @IsOptional() @trim() @IsString() @Length(0, 128) chronology?: string;
  /**
   * The three CONDITION codes. Deliberately editable here and not through the
   * status service: they are not a status, a copy can carry more than one at
   * once, and `is_shelf_available` folds all of them plus `status` into the one
   * boolean the planner can reason about.
   */
  @IsOptional() @trim() @IsString() @Length(0, 64) notForLoanCode?: string;
  @IsOptional() @trim() @IsString() @Length(0, 64) damagedCode?: string;
  @IsOptional() @trim() @IsString() @Length(0, 64) lostCode?: string;
  @IsOptional() @IsBoolean() restrictedAccess?: boolean;
  @IsOptional() @IsBoolean() holdable?: boolean;
  @IsOptional() @IsBoolean() bookable?: boolean;
  @IsOptional() @IsInt() @Min(0) priceCents?: number;
  @IsOptional() @IsInt() @Min(0) replacementCostCents?: number;
  @IsOptional() @trim() @IsString() @Length(0, 64) accessionNumber?: string;
  @IsOptional() @trim() @IsString() @Length(0, 2000) publicNote?: string;
  @IsOptional() @trim() @IsString() @Length(0, 2000) staffNote?: string;
}

/**
 * Marking a copy missing, found or in process.
 *
 * The vocabulary is DELIBERATELY THREE of the six. `on_loan`, `in_transit` and
 * `awaiting_pickup` are outcomes of circulation acts — a checkout, a transfer, a
 * hold — and a route that let the desk set them by hand would produce a copy
 * that is `on_loan` with no loan, which every availability count, every overdue
 * sweep and every patron's account would then disagree about. Those three arrive
 * through `ItemStatusService` from the service that owns the act.
 */
export class SetItemStatusDto {
  @IsIn(DESK_SETTABLE_STATUSES) status!: (typeof DESK_SETTABLE_STATUSES)[number];
  @IsOptional() @IsString() @Length(1, 64) reasonId?: string;
  @IsOptional() @trim() @IsString() @Length(1, 500) note?: string;
}

export class SendTransferDto {
  @IsString() @Length(1, 64) toBranchId!: string;
  @IsOptional() @IsString() @Length(1, 64) reasonId?: string;
  @IsOptional() @IsString() @Length(1, 64) holdId?: string;
  @IsOptional() @IsISO8601() expectedBy?: string;
  /** `false` queues it at the send desk without putting it in the van. */
  @IsOptional() @IsBoolean() markSent?: boolean;
  @IsOptional() @trim() @IsString() @Length(1, 500) note?: string;
}

export class ReceiveTransferDto {
  /** One of the two. A transit desk scans a copy; a work list has the transfer. */
  @IsOptional() @IsString() @Length(1, 64) transferId?: string;
  @IsOptional() @IsString() @Length(1, 64) itemId?: string;
  @IsOptional() @trim() @IsString() @Length(1, 500) note?: string;
}

export class CancelTransferDto {
  @IsOptional() @IsString() @Length(1, 64) transferId?: string;
  @IsOptional() @IsString() @Length(1, 64) itemId?: string;
  @trim() @IsString() @Length(1, 500) reason!: string;
}

export class AddItemNoteDto {
  @trim() @IsString() @Length(1, 4000) body!: string;
  /** Defaults to staff-only. See the column docblock for why that direction. */
  @IsOptional() @IsBoolean() publicNote?: boolean;
}

export class ShelfListQueryDto {
  @IsString() @Length(1, 64) branchId!: string;
  @IsOptional() @IsString() @Length(0, 128) afterCallNumberSort?: string;
  @IsOptional() @IsString() @Length(1, 64) afterId?: string;
  /**
   * A query parameter arrives as a string, and `validateDto` runs
   * `enableImplicitConversion: false` on purpose — so the coercion is explicit
   * here rather than global. `NaN` falls through to `@IsInt`, which rejects it.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? Number(value) : value))
  @IsInt()
  @Min(1)
  take?: number;
}

export class CreateStatusReasonDto {
  @trim() @IsString() @Length(1, 64) code!: string;
  @trim() @IsString() @Length(1, 200) name!: string;
  @IsOptional() @IsBoolean() staffSelectable?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}
