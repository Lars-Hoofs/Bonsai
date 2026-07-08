import { IsString, Length } from 'class-validator';

export class AnswerQuestionDto {
  @IsString() @Length(1, 2000) question!: string;
}
