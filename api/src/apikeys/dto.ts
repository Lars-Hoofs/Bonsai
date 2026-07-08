import { IsArray, IsIn, IsOptional, IsString, Length } from 'class-validator';

export class CreateApiKeyDto {
  @IsString()
  @Length(2, 100)
  name!: string;

  @IsIn(['secret', 'public_widget'])
  kind!: 'secret' | 'public_widget';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedOrigins?: string[];
}
