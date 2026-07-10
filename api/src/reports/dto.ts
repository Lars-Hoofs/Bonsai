import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
} from 'class-validator';
import { REPORT_CADENCES, type ReportCadence } from './report-schedule';
import type { ReportFormat } from './report-serialization';

const FORMATS: ReportFormat[] = ['csv', 'json'];

export class CreateReportScheduleDto {
  @IsIn(REPORT_CADENCES as readonly string[]) cadence!: ReportCadence;
  @IsIn(FORMATS) format!: ReportFormat;
  @IsOptional() @IsBoolean() deliverEmail?: boolean;
  @IsOptional() @IsBoolean() deliverStorage?: boolean;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  recipients?: string[];
}

export class UpdateReportScheduleDto {
  @IsOptional()
  @IsIn(REPORT_CADENCES as readonly string[])
  cadence?: ReportCadence;
  @IsOptional() @IsIn(FORMATS) format?: ReportFormat;
  @IsOptional() @IsBoolean() deliverEmail?: boolean;
  @IsOptional() @IsBoolean() deliverStorage?: boolean;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  recipients?: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}
