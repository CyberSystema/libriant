import { Type } from 'class-transformer';
import { MaxPasswordBytes } from '../../auth/dto/password-bounds.js';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * DTOs that exist only to be measured.
 *
 * `check:openapi` has no public endpoints to check against until M6, so without
 * these it would pass by having nothing to do — the exact vacuity that made the
 * metrics registry's "every declaration is emitted" check meaningless in phase
 * 5 until a deliberate break test failed to fail.
 *
 * So these two classes carry every construct the deriver claims to understand,
 * their derived schema is committed to `docs/api/openapi.fixture.json`, and the
 * gate additionally proves the schema agrees with what `validateDto()` actually
 * accepts and rejects. Change a decorator here and the gate fails — which is
 * the "deliberately drifted fixture" the phase's acceptance criterion asks for.
 *
 * They are never registered as an endpoint and never reach a route.
 */
export class ExampleAuthorDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsString()
  role?: string;
}

export class ExampleRecordDto {
  @IsString()
  @Length(1, 500)
  @Matches(/^[^\n]+$/)
  title!: string;

  @IsOptional()
  @IsString()
  subtitle?: string;

  @IsEmail()
  contactEmail!: string;

  @IsInt()
  @Min(1450)
  @Max(2200)
  publicationYear!: number;

  @IsIn(['marc21', 'unimarc'])
  schema!: 'marc21' | 'unimarc';

  @IsBoolean()
  circulates!: boolean;

  /**
   * Falsy `const`. The deriver's "did anything establish a type?" test used to
   * be a truthiness check, so this property alone made the whole DTO throw
   * "has validators but none that establishes a type".
   */
  @Equals(false)
  draft!: boolean;

  @IsDateString()
  acquiredAt!: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  subjects!: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExampleAuthorDto)
  authors!: ExampleAuthorDto[];
}

/**
 * DTOs the deriver must REFUSE. `check:openapi` asserts each one throws.
 *
 * They live here — beside the DTOs that must succeed — rather than inside the
 * gate script, for a mechanical reason worth writing down: `tsx` applies
 * `apps/api/tsconfig.json` only to the files that tsconfig's `include`
 * (`src/**`) actually covers. A decorated class declared inside
 * `scripts/check-openapi.ts` is transpiled with TC39 standard decorators and
 * dies at class-definition time with
 * `TypeError: Cannot read properties of undefined (reading 'constructor')`.
 * The gate script therefore declares no decorated classes at all.
 */

/**
 * `@ValidateIf` records `conditionalValidation` with `name: undefined` — the
 * same metadata type as `@IsOptional()`, which records `name: 'isOptional'`.
 * Reading the type alone would publish this required field as optional.
 */
export class RefusedConditionalDto {
  @IsString()
  @ValidateIf((_o: unknown, v: unknown) => v !== null)
  note!: string | null;
}

/** A project-defined validator the deriver has no rule for. */
export class RefusedCustomValidatorDto {
  @IsString()
  @MaxPasswordBytes()
  password!: string;
}
