import { IsString, Length } from 'class-validator';

export class UpdateChunkDto {
  @IsString() @Length(1, 100_000) text!: string;
}
