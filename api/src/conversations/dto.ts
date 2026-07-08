import { IsOptional, IsString, Length } from 'class-validator';

export class StartConversationDto {
  @IsOptional() @IsString() @Length(1, 200) visitorId?: string;
  @IsOptional() @IsString() @Length(2, 8) language?: string;
}

export class PostMessageDto {
  @IsString() @Length(1, 4000) content!: string;
}

export class EscalateDto {
  @IsOptional() @IsString() @Length(1, 500) reason?: string;
}

export class AgentMessageDto {
  @IsString() @Length(1, 4000) content!: string;
}
