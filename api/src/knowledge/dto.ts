import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateSourceDto {
  @IsIn(['manual', 'csv', 'website']) type!: 'manual' | 'csv' | 'website';
  @IsString() @Length(1, 200) name!: string;
  // Shape depends on type: manual -> { title, body, language? };
  // csv -> { csv, titleColumn?, bodyColumns? }; website -> { url }.
  @IsObject() config!: Record<string, unknown>;
}

// Smallest sane per-source re-crawl interval: 60s. Prevents an editor from
// pinning a source to a punishingly tight loop that would hammer ingestion.
const MIN_RECRAWL_INTERVAL_MS = 60_000;

export class SetSourceScheduleDto {
  // `null` clears the per-source schedule (fall back to the global scan
  // cadence); a positive integer sets a recurring re-crawl interval in ms.
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(MIN_RECRAWL_INTERVAL_MS)
  recrawlIntervalMs!: number | null;
}
