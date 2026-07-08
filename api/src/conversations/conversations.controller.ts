import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { ConversationsService } from './conversations.service';
import { AgentMessageDto } from './dto';

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
    @Query('status') status = 'handover',
  ) {
    return this.conversations.listInbox(tenant.schemaName, projectId, status);
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
}
