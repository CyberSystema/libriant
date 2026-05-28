import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
} from 'class-validator';

const MODES = ['maintenance', 'read_only', 'out_of_order', 'under_construction'] as const;

export class OpenSystemModeDto {
  @IsIn(MODES, {
    message: 'mode must be one of: maintenance, read_only, out_of_order, under_construction',
  })
  mode!: (typeof MODES)[number];

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  messageMarkdown?: string | null;

  /** When the window begins. NULL / omitted means "right now". */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  startsAt?: string | null;

  /** When the window ends. NULL = open-ended (admin will end manually). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  endsAt?: string | null;

  @IsOptional()
  @IsBoolean()
  allowAdminBypass?: boolean;
}
