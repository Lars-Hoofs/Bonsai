import { IsIn, IsObject, IsOptional, IsString, Length } from 'class-validator';

export class CreateSourceDto {
  @IsIn(['manual', 'csv', 'website']) type!: 'manual' | 'csv' | 'website';
  @IsString() @Length(1, 200) name!: string;
  // Shape depends on type: manual -> { title, body, language? };
  // csv -> { csv, titleColumn?, bodyColumns? }; website -> { url }.
  @IsObject() config!: Record<string, unknown>;
}

export class ExportKnowledgeDto {
  @IsOptional()
  @IsIn(['json', 'csv', 'zip'])
  format?: 'json' | 'csv' | 'zip';
}

export class ImportKnowledgeDto {
  @IsIn(['json', 'csv', 'zip']) format!: 'json' | 'csv' | 'zip';
}
