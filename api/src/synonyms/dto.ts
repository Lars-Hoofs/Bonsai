import { ArrayMaxSize, IsArray, IsString, Length } from 'class-validator';

export class CreateSynonymDto {
  @IsString() @Length(1, 200) term!: string;
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Length(1, 200, { each: true })
  aliases!: string[];
}
