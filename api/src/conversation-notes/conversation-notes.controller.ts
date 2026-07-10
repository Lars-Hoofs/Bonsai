import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import {
  ConversationNote,
  ConversationNotesService,
} from './conversation-notes.service';
import { CreateConversationNoteDto } from './dto';

/**
 * Internal (agent-only) notes on a conversation (#34). Nested under the same
 * agent-facing path prefix as `ConversationsController` — never exposed on
 * `ConversationsPublicController` (the visitor/widget path), so a note can
 * never reach the widget UI.
 */
@Controller(
  'tenants/:tenantId/projects/:projectId/conversations/:conversationId/notes',
)
export class ConversationNotesController {
  constructor(private readonly notes: ConversationNotesService) {}

  @Post()
  @RequireRole('agent')
  add(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: CreateConversationNoteDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ConversationNote> {
    return this.notes.add(
      tenant.id,
      tenant.schemaName,
      projectId,
      conversationId,
      dto.body,
      user.id,
    );
  }

  @Get()
  @RequireRole('agent')
  list(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ): Promise<ConversationNote[]> {
    return this.notes.list(tenant.schemaName, projectId, conversationId);
  }

  @Delete(':noteId')
  @RequireRole('agent')
  async remove(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.notes.remove(
      tenant.id,
      tenant.schemaName,
      projectId,
      conversationId,
      noteId,
      user.id,
    );
    return { ok: true };
  }
}
