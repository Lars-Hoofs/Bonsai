import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

export class StartConversationDto {
  @IsOptional() @IsString() @Length(1, 200) visitorId?: string;
  @IsOptional() @IsString() @Length(2, 8) language?: string;
}

export class PostMessageDto {
  @IsString() @Length(1, 4000) content!: string;
}

export class ResumeConversationDto {
  @IsString() @Length(1, 512) visitorSecret!: string;
}

export class EscalateDto {
  @IsOptional() @IsString() @Length(1, 500) reason?: string;
}

export class AgentMessageDto {
  @IsString() @Length(1, 4000) content!: string;
}

export class SetPresenceDto {
  @IsIn(['available', 'away']) status!: 'available' | 'away';
}

export class AssignConversationDto {
  @IsOptional() @IsUUID() agentUserId?: string;
}

export class SubmitCsatDto {
  @IsInt() @Min(1) @Max(5) score!: number;
  @IsOptional() @IsString() @Length(1, 2000) comment?: string;
}

export class SubmitMessageFeedbackDto {
  @IsIn(['up', 'down']) rating!: 'up' | 'down';
}
