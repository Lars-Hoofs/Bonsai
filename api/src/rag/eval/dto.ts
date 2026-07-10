import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Length,
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
