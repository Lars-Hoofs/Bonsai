import { IsOptional, IsString, Length } from 'class-validator';

export class CreateProjectDto {
  @IsString() @Length(2, 100) name!: string;
  @IsOptional() @IsString() @Length(2, 8) defaultLanguage?: string;
}

export class UpdateProjectDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsString() @Length(2, 8) defaultLanguage?: string;
}
