import { IsString, Length } from 'class-validator';

export class CreateConversationNoteDto {
  @IsString() @Length(1, 4000) body!: string;
}
