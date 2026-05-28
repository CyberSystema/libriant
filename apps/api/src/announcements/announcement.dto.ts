import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { Transform } from 'class-transformer';

const SEVERITIES = ['info', 'warning', 'critical'] as const;

/**
 * Wire shape for `POST /admin/announcements`. The audience filter is kept
 * as an opaque JSON blob here and parsed via `audienceFromJson` in the
 * service — class-validator can't reliably validate a discriminated union
 * across class boundaries, and the audience shape needs cross-field
 * checks (one-of) that are easier to express in code.
 */
export class CreateAnnouncementDto {
  @IsString()
  @Length(1, 200)
  title!: string;

  @IsString()
  @Length(1, 20000)
  bodyMarkdown!: string;

  @IsIn(SEVERITIES)
  severity!: (typeof SEVERITIES)[number];

  @IsObject()
  audience!: Record<string, unknown>;

  @IsBoolean()
  deliverInApp!: boolean;

  @IsBoolean()
  deliverEmail!: boolean;

  @IsOptional()
  @IsDateString()
  publishAt?: string | null;

  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @IsBoolean()
  dismissible!: boolean;

  @IsBoolean()
  requiresAck!: boolean;
}

export class UpdateAnnouncementDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 20000)
  bodyMarkdown?: string;

  @IsOptional()
  @IsIn(SEVERITIES)
  severity?: (typeof SEVERITIES)[number];

  @IsOptional()
  @IsObject()
  audience?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  deliverInApp?: boolean;

  @IsOptional()
  @IsBoolean()
  deliverEmail?: boolean;

  @IsOptional()
  @IsDateString()
  publishAt?: string | null;

  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @IsOptional()
  @IsBoolean()
  dismissible?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresAck?: boolean;
}

export class SetTenantTagsDto {
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) =>
    Array.isArray(value)
      ? Array.from(
          new Set(
            value
              .filter((t: unknown): t is string => typeof t === 'string')
              .map((t: string) => t.trim().toLowerCase())
              .filter((t: string) => t.length > 0 && t.length <= 50),
          ),
        )
      : value,
  )
  tags!: string[];
}
