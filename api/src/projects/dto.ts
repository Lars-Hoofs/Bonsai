import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateProjectDto {
  @IsString() @Length(2, 100) name!: string;
  @IsOptional() @IsString() @Length(2, 8) defaultLanguage?: string;
}

export class UpdateProjectDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsString() @Length(2, 8) defaultLanguage?: string;
  // GDPR retention window (#47), in days. A positive integer enables the
  // retention auto-purge for this project; `null` explicitly clears the
  // window (retain forever). `undefined` (key omitted) leaves it unchanged.
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  retentionDays?: number | null;
}
