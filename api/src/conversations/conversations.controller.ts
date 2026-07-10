import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { PresenceService } from '../presence/presence.service';
import type {
  AssigneeFilter,
  ConversationSummary,
} from './conversations.service';
import { ConversationsService } from './conversations.service';
import { AgentMessageDto, AssignConversationDto, SetPresenceDto } from './dto';

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
  ): Promise<ConversationSummary[]> {
    const assigneeFilter = resolveAssigneeFilter(assignee, user.id);
    return this.conversations.listInbox(
      tenant.schemaName,
      projectId,
      status,
      assigneeFilter,
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
