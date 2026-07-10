import { IsBoolean, IsIn, IsObject, IsString, Length } from 'class-validator';

export class CreateSourceDto {
  @IsIn(['manual', 'csv', 'website']) type!: 'manual' | 'csv' | 'website';
  @IsString() @Length(1, 200) name!: string;
  // Shape depends on type: manual -> { title, body, language? };
  // csv -> { csv, titleColumn?, bodyColumns? }; website -> { url }.
  @IsObject() config!: Record<string, unknown>;
}

/** Per-document enable/disable (#21): toggles whether a document's chunks are
 * included in retrieval. Disabled documents are excluded, not deleted. */
export class SetDocumentEnabledDto {
  @IsBoolean() enabled!: boolean;
}
