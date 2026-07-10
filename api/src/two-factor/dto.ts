import { IsString, Length } from 'class-validator';

export class VerifyTotpDto {
  @IsString() @Length(6, 8) code!: string;
}
