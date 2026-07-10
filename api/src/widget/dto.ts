import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SaveThemeDto {
  @IsObject() theme!: Record<string, unknown>;
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
