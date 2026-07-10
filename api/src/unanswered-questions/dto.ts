import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/**
 * Query params for the editor-facing unanswered-questions list. `resolved`
 * defaults to only-open questions (the review queue); pass `resolved=all` to
 * include already-addressed ones.
 */
export class ListUnansweredQuestionsDto {
  @IsOptional()
  @IsIn(['open', 'resolved', 'all'])
  status?: 'open' | 'resolved' | 'all';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/**
 * Query params for the clustering / KB-gap-suggestion endpoint. `threshold`
 * is the cosine-similarity cut-off for grouping questions; higher = tighter
 * clusters. `minSize` hides trivial one-off questions from the suggestions so
 * editors see only recurring gaps.
 */
export class ClusterUnansweredQuestionsDto {
  @IsOptional()
  @IsNumberString()
  threshold?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minSize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit?: number;
}

/** Body for toggling an unanswered question's resolved flag. */
export class SetResolvedDto {
  @IsBoolean() resolved!: boolean;
}
