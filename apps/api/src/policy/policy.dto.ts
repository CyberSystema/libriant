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
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/** The six selectors plus the instant. `ResolveContext`, over the wire. */
export class ExplainQueryDto {
  @IsOptional() @IsString() @Length(1, 64) patronCategoryId?: string;
  @IsOptional() @IsString() @Length(1, 64) itemTypeId?: string;
  @IsOptional() @IsString() @Length(1, 64) owningBranchId?: string;
  @IsOptional() @IsString() @Length(1, 64) shelvingLocationId?: string;
  @IsOptional() @IsString() @Length(1, 64) checkoutBranchId?: string;
  @IsOptional() @IsString() @Length(1, 64) pickupBranchId?: string;

  /**
   * The instant to resolve AT, defaulting to now.
   *
   * It is a parameter rather than always-now because that is the difference
   * between "why is this due on the 19th?" and "why WAS that due on the 19th?".
   * A rule with an `effective_from` resolves differently either side of it, and
   * a librarian looking at a loan taken in March needs March's answer.
   */
  @IsOptional() @IsISO8601() at?: string;

  /** Whether the item has a hold on it — it changes the loan period. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  hasOutstandingHold?: boolean;
}

/** One selector set + policy ids, for `POST /circulation/rules`. */
export class CreateRuleDto {
  @trim() @IsString() @Length(1, 200) name!: string;
  @IsOptional() @trim() @IsString() @Length(0, 2000) notes?: string;

  @IsOptional() @IsString() @Length(1, 64) patronCategoryId?: string | null;
  @IsOptional() @IsString() @Length(1, 64) itemTypeId?: string | null;
  @IsOptional() @IsString() @Length(1, 64) owningBranchId?: string | null;
  @IsOptional() @IsString() @Length(1, 64) shelvingLocationId?: string | null;
  @IsOptional() @IsString() @Length(1, 64) checkoutBranchId?: string | null;
  @IsOptional() @IsString() @Length(1, 64) pickupBranchId?: string | null;

  @IsString() @Length(1, 64) loanPolicyId!: string;
  @IsString() @Length(1, 64) overdueFinePolicyId!: string;
  @IsString() @Length(1, 64) lostItemFeePolicyId!: string;
  @IsString() @Length(1, 64) holdPolicyId!: string;
  @IsString() @Length(1, 64) noticePolicyId!: string;

  @IsOptional() @IsInt() @Min(0) maxLoansForRule?: number | null;
  @IsOptional() @IsInt() @Min(0) maxHoldsForRule?: number | null;
  @IsOptional() @IsInt() @Min(0) ageRestrictionMinYears?: number | null;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsISO8601() effectiveFrom?: string | null;
  @IsOptional() @IsISO8601() effectiveTo?: string | null;
}

export class UpdateRuleDto {
  @IsOptional() @trim() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @trim() @IsString() @Length(0, 2000) notes?: string | null;
  @IsOptional() @IsString() @Length(1, 64) loanPolicyId?: string;
  @IsOptional() @IsString() @Length(1, 64) overdueFinePolicyId?: string;
  @IsOptional() @IsString() @Length(1, 64) lostItemFeePolicyId?: string;
  @IsOptional() @IsString() @Length(1, 64) holdPolicyId?: string;
  @IsOptional() @IsString() @Length(1, 64) noticePolicyId?: string;
  @IsOptional() @IsInt() @Min(0) maxLoansForRule?: number | null;
  @IsOptional() @IsInt() @Min(0) maxHoldsForRule?: number | null;
  @IsOptional() @IsInt() @Min(0) ageRestrictionMinYears?: number | null;
  @IsOptional() @IsInt() priority?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsISO8601() effectiveFrom?: string | null;
  @IsOptional() @IsISO8601() effectiveTo?: string | null;
}

export class SetModeDto {
  @IsBoolean() circulationRulesEnabled!: boolean;
}

/**
 * An UNSAVED loan policy, for the preview endpoint.
 *
 * Only the fields that move a due date. A preview that accepted the whole
 * `LoanPolicy` would be a second write path with no audit trail — this one
 * cannot write anything, and the resolver it feeds is pure, so the worst a bad
 * body can do is produce a wrong answer on the screen of the person who typed
 * it.
 */
export class PreviewLoanPolicyDto {
  @IsIn(['rolling', 'fixed', 'indefinite']) profile!: 'rolling' | 'fixed' | 'indefinite';
  @IsOptional() @IsInt() @Min(1) periodValue?: number;
  @IsOptional()
  @IsIn(['minutes', 'hours', 'days', 'weeks', 'months'])
  periodUnit?: 'minutes' | 'hours' | 'days' | 'weeks' | 'months';
  @IsOptional() @IsInt() @Min(0) dueTimeOfDayMin?: number | null;
  @IsOptional()
  @IsIn([
    'keep',
    'endOfPreviousOpenDay',
    'startOfNextOpenDay',
    'endOfNextOpenDay',
    'endOfCurrentOpenHours',
  ])
  closedDayHandling?:
    | 'keep'
    | 'endOfPreviousOpenDay'
    | 'startOfNextOpenDay'
    | 'endOfNextOpenDay'
    | 'endOfCurrentOpenHours';
}

export class PreviewDto {
  /** Which branch's calendar and timezone to compute in. */
  @IsString() @Length(1, 64) branchId!: string;
  @IsOptional() @IsISO8601() at?: string;
  @IsOptional() @IsBoolean() hasOutstandingHold?: boolean;
  @ValidateNested()
  @Type(() => PreviewLoanPolicyDto)
  loanPolicy!: PreviewLoanPolicyDto;
}
