import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateEvalCaseDto {
  @IsString() @Length(1, 2000) question!: string;

  @IsOptional() @IsBoolean() expectRefusal?: boolean;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  expectedSourceIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  expectedSubstrings?: string[];
}

/** One A/B variant (feature #30): a candidate prompt and/or threshold. */
export class CreateVariantDto {
  @IsString() @Length(1, 200) name!: string;

  // Omitted/null = use the built-in answering system prompt.
  @IsOptional() @IsString() @Length(1, 10000) systemPrompt?: string;

  // Omitted/null = use the project's configured confidenceThreshold.
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidenceThreshold?: number;
}

export class CreateExperimentDto {
  @IsString() @Length(1, 200) name!: string;

  @IsOptional() @IsString() @Length(1, 2000) description?: string;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  variants!: CreateVariantDto[];
}
