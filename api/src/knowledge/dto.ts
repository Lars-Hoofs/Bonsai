import { IsIn, IsObject, IsString, Length } from 'class-validator';

export class CreateSourceDto {
  @IsIn(['manual', 'csv']) type!: 'manual' | 'csv';
  @IsString() @Length(1, 200) name!: string;
  // Shape depends on type: manual -> { title, body, language? };
  // csv -> { csv, titleColumn?, bodyColumns? }.
  @IsObject() config!: Record<string, unknown>;
}
