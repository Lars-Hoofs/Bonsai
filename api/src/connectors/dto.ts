import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Length,
} from 'class-validator';

// Auth shape is intentionally loose here (validated/interpreted by
// ConnectorsService and, later, the part-2 calling code): either
// { type: 'bearer', token } or { type: 'header', name, value }.
export type ConnectorAuthInput = Record<string, unknown>;

export class CreateConnectorDto {
  @IsString() @Length(1, 200) name!: string;
  @IsOptional() @IsString() @Length(0, 2000) description?: string;
  @IsUrl({ require_tld: false, require_protocol: true }) baseUrl!: string;
  @IsIn(['GET', 'POST']) method!: 'GET' | 'POST';
  @IsOptional() @IsObject() requestSchema?: Record<string, unknown>;
  @IsOptional() @IsString() @Length(0, 2000) responseTemplate?: string;
  @IsOptional() @IsString() @Length(0, 2000) usageHint?: string;
  @IsOptional() @IsObject() auth?: ConnectorAuthInput;
}

export class UpdateConnectorDto {
  @IsOptional() @IsString() @Length(1, 200) name?: string;
  @IsOptional() @IsString() @Length(0, 2000) description?: string;
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  baseUrl?: string;
  @IsOptional() @IsIn(['GET', 'POST']) method?: 'GET' | 'POST';
  @IsOptional() @IsObject() requestSchema?: Record<string, unknown>;
  @IsOptional() @IsString() @Length(0, 2000) responseTemplate?: string;
  @IsOptional() @IsString() @Length(0, 2000) usageHint?: string;
  @IsOptional() @IsObject() auth?: ConnectorAuthInput;
}
