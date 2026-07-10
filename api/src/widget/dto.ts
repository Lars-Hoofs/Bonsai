import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BUILT_IN_PRESETS } from './presets';
import type { PresetName } from './presets';

export class SaveThemeDto {
  @IsObject() theme!: Record<string, unknown>;
}

export class ImportThemeDto {
  @IsObject() theme!: Record<string, unknown>;
}

const PRESET_NAMES = Object.keys(BUILT_IN_PRESETS) as PresetName[];

export class ApplyPresetDto {
  @IsIn(PRESET_NAMES) preset!: PresetName;
}

/** A single page-targeting rule (#11). */
export class TargetingRuleDto {
  @IsIn(['show', 'hide']) mode!: 'show' | 'hide';
  @IsIn(['glob', 'regex']) matchType!: 'glob' | 'regex';
  @IsString() @MinLength(1) @MaxLength(2048) pattern!: string;
}

/** Page-targeting rules (#11) payload. */
export class SaveTargetingDto {
  @IsOptional() @IsBoolean() defaultShow?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TargetingRuleDto)
  rules?: TargetingRuleDto[];
}

/** Proactive triggers (#12) payload. */
export class SaveTriggersDto {
  @IsOptional() @IsInt() @Min(0) @Max(86400) afterSeconds?: number | null;

  @IsOptional() @IsInt() @Min(0) @Max(100) scrollDepth?: number | null;

  @IsOptional() @IsBoolean() exitIntent?: boolean;
}

export class SaveCopyDto {
  // A map of locale -> flat copy object (string keys to string values).
  // Detailed shape/size/locale validation lives in `assertCopyShape`.
  @IsOptional()
  @IsObject()
  copy?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @Length(2, 35)
  defaultLocale?: string;
}
