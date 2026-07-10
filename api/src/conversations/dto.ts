import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { WORKFLOW_STATUSES } from './sla';
import type { WorkflowStatus } from './sla';

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

export class EmailTranscriptDto {
  @IsEmail() @Length(3, 320) email!: string;
}

/**
 * Multipart body accompanying a visitor attachment upload. The file itself
 * arrives via the `file` multipart part (handled by FileInterceptor); this is
 * just the optional visitor-supplied caption for the message the upload
 * creates.
 */
export class UploadAttachmentDto {
  @IsOptional() @IsString() @Length(1, 4000) caption?: string;
}

export class CreateConversationTagDto {
  @IsString() @Length(1, 100) name!: string;
  // Optional presentation hint, e.g. a hex color like #ff8800.
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be a hex color' })
  color?: string;
}

export class TagConversationDto {
  @IsUUID() tagId!: string;
}

/**
 * A conversation search/filter body. Also used as the persisted shape of a
 * saved filter's `filter`. `assignee` is 'me' | 'unassigned' | a user id; the
 * controller resolves 'me' to the current user before hitting the service.
 */
export class ConversationFilterDto {
  @IsOptional() @IsString() @Length(1, 500) text?: string;
  @IsOptional() @IsIn(['bot', 'handover', 'closed']) status?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  tagIds?: string[];
  @IsOptional() @IsString() @Length(1, 200) assignee?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

export class CreateSavedFilterDto {
  @IsString() @Length(1, 100) name!: string;
  @IsObject()
  @ValidateNested()
  @Type(() => ConversationFilterDto)
  filter!: ConversationFilterDto;
}

export class SetWorkflowStatusDto {
  @IsIn(WORKFLOW_STATUSES) status!: WorkflowStatus;
}

export class SubmitAnsweredSignalDto {
  // "Did this answer your question?" — true = yes, false = no.
  @IsBoolean() answered!: boolean;
}
