import {
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

// A placeholder variable name: letters, digits and underscores only. Kept
// deliberately strict so it maps 1:1 to the {{name}} tokens rendered in the
// body and can't smuggle regex metacharacters.
const VARIABLE_NAME_RE = /^[A-Za-z0-9_]+$/;

export class CreateCannedResponseDto {
  @IsString() @Length(1, 200) title!: string;
  @IsString() @Length(1, 10000) body!: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Matches(VARIABLE_NAME_RE, { each: true })
  @Length(1, 100, { each: true })
  variables?: string[];
}

export class UpdateCannedResponseDto {
  @IsOptional() @IsString() @Length(1, 200) title?: string;
  @IsOptional() @IsString() @Length(1, 10000) body?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Matches(VARIABLE_NAME_RE, { each: true })
  @Length(1, 100, { each: true })
  variables?: string[];
}

export class RenderCannedResponseDto {
  // Map of variable name -> value to substitute into {{name}} tokens. Missing
  // variables are left as-is (the raw {{name}} token remains) so the agent
  // sees what still needs filling in.
  @IsOptional() @IsObject() values?: Record<string, unknown>;
}
