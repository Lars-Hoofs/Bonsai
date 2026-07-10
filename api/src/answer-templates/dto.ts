import { IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';

export class CreateAnswerTemplateDto {
  @IsIn(['keyword', 'intent']) triggerType!: 'keyword' | 'intent';
  @IsString() @Length(1, 200) trigger!: string;
  @IsString() @Length(1, 4000) answer!: string;
  @IsOptional() @IsString() @Length(1, 200) attribution?: string;
  @IsOptional() @IsBoolean() shortCircuit?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateAnswerTemplateDto {
  @IsOptional() @IsIn(['keyword', 'intent']) triggerType?: 'keyword' | 'intent';
  @IsOptional() @IsString() @Length(1, 200) trigger?: string;
  @IsOptional() @IsString() @Length(1, 4000) answer?: string;
  @IsOptional() @IsString() @Length(1, 200) attribution?: string;
  @IsOptional() @IsBoolean() shortCircuit?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}
