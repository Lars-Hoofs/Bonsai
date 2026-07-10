import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

export class AuditLogFilterDto {
  @IsOptional() @IsString() @Length(1, 200) action?: string;
  @IsOptional() @IsUUID() actorUserId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

export class AuditLogQueryDto extends AuditLogFilterDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

export class AuditLogExportQueryDto extends AuditLogFilterDto {
  @IsIn(['csv', 'json']) format!: 'csv' | 'json';
}
