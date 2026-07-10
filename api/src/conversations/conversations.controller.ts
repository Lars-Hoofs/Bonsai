import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { sanitizeFilename } from '../storage/sanitize-filename';
import { PresenceService } from '../presence/presence.service';
import type {
  AssigneeFilter,
  ConversationSummary,
} from './conversations.service';
import { ConversationsService } from './conversations.service';
import { WORKFLOW_STATUSES } from './sla';
import type { WorkflowStatus } from './sla';
import {
  AgentMessageDto,
  AssignConversationDto,
  SetPresenceDto,
  SetWorkflowStatusDto,
  TransferConversationDto,
} from './dto';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the `?assignee=` inbox query param to a concrete filter. 'me' is
 * resolved here (not in the service) since only the controller knows who
 * the calling agent is; 'unassigned' passes through; anything else must be
 * a UUID (a specific agent's user id).
 */
function resolveAssigneeFilter(
  raw: string | undefined,
  currentUserId: string,
): AssigneeFilter | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'unassigned') return 'unassigned';
  if (raw === 'me') return { userId: currentUserId };
  if (UUID_RE.test(raw)) return { userId: raw };
  throw new BadRequestException(
    "assignee must be 'me', 'unassigned', or a user id",
  );
}

/**
 * Resolves the optional `?workflowStatus=` inbox filter (#37) to a concrete
 * lifecycle value, or undefined when absent (no filter). Rejects anything
 * outside the open/pending/resolved lifecycle.
 */
function resolveWorkflowStatusFilter(
  raw: string | undefined,
): WorkflowStatus | undefined {
  if (raw === undefined) return undefined;
  if ((WORKFLOW_STATUSES as readonly string[]).includes(raw)) {
    return raw as WorkflowStatus;
  }
  throw new BadRequestException(
    `workflowStatus must be one of: ${WORKFLOW_STATUSES.join(', ')}`,
  );
}

/**
 * Agent/back-office side of conversations: OIDC + tenant-membership gated
 * (global AuthGuard + MembershipGuard). Visitor-facing actions (start a
 * conversation, post a visitor message, escalate, reload history as the
 * visitor) live on the public, widget-key + visitor-secret gated controller
 * instead (`ConversationsPublicController`) — an anonymous website visitor
 * has no OIDC identity to satisfy these guards with.
 */
@Controller('tenants/:tenantId/projects/:projectId/conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @RequireRole('agent')
  inbox(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthUser,
    @Query('status') status = 'handover',
    @Query('assignee') assignee?: string,
    @Query('workflowStatus') workflowStatus?: string,
  ): Promise<ConversationSummary[]> {
    const assigneeFilter = resolveAssigneeFilter(assignee, user.id);
    const workflowFilter = resolveWorkflowStatusFilter(workflowStatus);
    return this.conversations.listInbox(
      tenant.schemaName,
      projectId,
      status,
      assigneeFilter,
      workflowFilter,
    );
  }

  @Get(':conversationId')
  @RequireRole('agent')
  get(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return this.conversations.getWithMessages(
      tenant.schemaName,
      projectId,
      conversationId,
    );
  }

  /**
   * Lists the visitor attachments on a conversation (metadata only) so an
   * agent handling it can see what the visitor sent (#14).
   */
  @Get(':conversationId/attachments')
  @RequireRole('agent')
  listAttachments(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return this.conversations.listAttachmentsForAgent(
      tenant.schemaName,
      projectId,
      conversationId,
    );
  }

  /**
   * Downloads a single visitor attachment's raw bytes. Streamed with the
   * stored content type and an attachment Content-Disposition (never inline —
   * a visitor-supplied file is never rendered in the agent's origin). The
   * filename is sanitized before it reaches the header.
   */
  @Get(':conversationId/attachments/:attachmentId/download')
  @RequireRole('agent')
  @Header('X-Content-Type-Options', 'nosniff')
  async downloadAttachment(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { attachment, body } = await this.conversations.getAttachmentForAgent(
      tenant.schemaName,
      projectId,
      conversationId,
      attachmentId,
    );
    const safeName = sanitizeFilename(attachment.filename);
    res.setHeader('Content-Type', attachment.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    return new StreamableFile(body);
  }

  @Post(':conversationId/agent-messages')
  @RequireRole('agent')
  async agentMessage(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: AgentMessageDto,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.conversations.agentMessage(
      tenant.id,
      tenant.schemaName,
      projectId,
      conversationId,
      user.id,
      dto.content,
    );
    return { ok: true };
  }

  @Post(':conversationId/return-to-bot')
  @RequireRole('agent')
  async returnToBot(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ): Promise<{ ok: true }> {
    await this.conversations.returnToBot(
      tenant.schemaName,
      projectId,
      conversationId,
    );
    return { ok: true };
  }

  /**
   * Claim (self-assign, default) or reassign a conversation to a specific
   * agent. `agentUserId` omitted -> the caller claims it themselves.
   */
  @Post(':conversationId/assign')
  @RequireRole('agent')
  async assign(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: AssignConversationDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ConversationSummary> {
    return this.conversations.assign(
      tenant.id,
      tenant.schemaName,
      projectId,
      conversationId,
      dto.agentUserId ?? user.id,
      user.id,
    );
  }

  /**
   * Transition the agent-facing workflow status (open/pending/resolved, #37).
   * Resolving stamps the resolution SLA milestone; reopening clears it.
   */
  @Put(':conversationId/workflow-status')
  @RequireRole('agent')
  async setWorkflowStatus(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: SetWorkflowStatusDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ConversationSummary> {
    return this.conversations.setWorkflowStatus(
      tenant.id,
      tenant.schemaName,
      projectId,
      conversationId,
      dto.status,
      user.id,
    );
  }

  /**
   * Transfer (reassign) an in-handover conversation to another agent, with an
   * optional note. Records the move in `conversation_transfers` history and
   * updates the assignment. Distinct from `assign`: the target is required,
   * must be an agent+ member, and the conversation must be in handover.
   */
  @Post(':conversationId/transfer')
  @RequireRole('agent')
  async transfer(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: TransferConversationDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ConversationSummary> {
    return this.conversations.transfer(
      tenant.id,
      tenant.schemaName,
      projectId,
      conversationId,
      dto.toAgentUserId,
      user.id,
      dto.note,
    );
  }
}

/**
 * Agent presence: control-plane keyed by tenant.id + user.id (not a tenant
 * schema table), so this lives on its own tiny controller under
 * `tenants/:tenantId/...` rather than nested under `.../projects/:projectId`
 * — presence is per-tenant, not per-project. The `:tenantId` param is what
 * makes `MembershipGuard` apply (it looks for that exact param name).
 */
@Controller('tenants/:tenantId/agents/me/presence')
export class AgentPresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Put()
  @RequireRole('agent')
  async setPresence(
    @Tenant() tenant: TenantRef,
    @CurrentUser() user: AuthUser,
    @Body() dto: SetPresenceDto,
  ): Promise<{ ok: true }> {
    await this.presence.setPresence(tenant.id, user.id, dto.status);
    return { ok: true };
  }
}
