import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

/**
 * Query params for the topic/intent analytics endpoints (#42).
 *
 * `from`/`to` bound the time window (ISO-8601; defaults applied in the
 * service). `mode` selects the classifier: fixed intent heuristics
 * (`intent`), embedding clustering of the long tail (`cluster`), or both
 * (`hybrid`, the default). `maxConversations` caps how many visitor questions
 * are pulled/embedded for a single request so the on-read compute stays
 * bounded.
 */
export class TopicQueryDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;

  @IsOptional()
  @IsIn(['intent', 'cluster', 'hybrid'])
  mode?: 'intent' | 'cluster' | 'hybrid';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  maxConversations?: number;
}

export class TopicTrendsQueryDto extends TopicQueryDto {
  /** Time-bucket granularity for the trend series. */
  @IsOptional() @IsIn(['day', 'week', 'month']) granularity?:
    'day' | 'week' | 'month';
}
