import { IsObject, IsOptional, IsString, Length } from 'class-validator';

export class SaveThemeDto {
  @IsObject() theme!: Record<string, unknown>;
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
