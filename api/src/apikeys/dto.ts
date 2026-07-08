import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

export class CreateApiKeyDto {
  @IsString()
  @Length(2, 100)
  name!: string;

  @IsIn(['secret', 'public_widget'])
  kind!: 'secret' | 'public_widget';

  // Required in practice for public_widget keys (which project the widget serves).
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedOrigins?: string[];
}
