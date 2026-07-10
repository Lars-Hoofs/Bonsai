import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class DebugRetrieveDto {
  @IsString() @Length(1, 2000) question!: string;

  @IsOptional() @IsInt() @Min(1) @Max(50) topK?: number;
}
