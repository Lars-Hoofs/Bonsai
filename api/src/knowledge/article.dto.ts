import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

/**
 * Payload for the manual Q&A / article editor. `contentFormat` tells the server
 * how to interpret `content`: rich-text editors submit `html` (converted to
 * Markdown server-side); a plain Markdown/text editor submits `markdown`.
 *
 * An article is either a free-form knowledge article (title + content) or a
 * Q&A pair (question + answer, with content optional/supplementary). Categories
 * and tags are free-form taxonomy carried into the indexed chunks' metadata.
 */

const ARTICLE_TITLE_MAX = 200;
const ARTICLE_CONTENT_MAX = 200_000;
const ARTICLE_QA_MAX = 20_000;
const TAXONOMY_ENTRY_MAX = 100;
const TAXONOMY_ARRAY_MAX = 50;

export class CreateArticleDto {
  @IsString()
  @Length(1, ARTICLE_TITLE_MAX)
  title!: string;

  @IsOptional()
  @IsString()
  @Length(0, ARTICLE_CONTENT_MAX)
  content?: string;

  @IsOptional()
  @IsIn(['html', 'markdown'])
  contentFormat?: 'html' | 'markdown';

  @IsOptional()
  @IsString()
  @Length(1, ARTICLE_QA_MAX)
  question?: string;

  @IsOptional()
  @IsString()
  @Length(1, ARTICLE_QA_MAX)
  answer?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TAXONOMY_ARRAY_MAX)
  @IsString({ each: true })
  @Length(1, TAXONOMY_ENTRY_MAX, { each: true })
  categories?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(TAXONOMY_ARRAY_MAX)
  @IsString({ each: true })
  @Length(1, TAXONOMY_ENTRY_MAX, { each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  @Length(2, 8)
  language?: string;
}

// Update allows partial edits; title stays required to keep the source name
// meaningful. Same field-level bounds as create.
export class UpdateArticleDto extends CreateArticleDto {}
