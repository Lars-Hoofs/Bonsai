import { ArrayNotEmpty, IsArray, IsString, IsUrl } from 'class-validator';

export class CreateWebhookDto {
  @IsUrl({ require_tld: false }) url!: string;
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) events!: string[];
}
