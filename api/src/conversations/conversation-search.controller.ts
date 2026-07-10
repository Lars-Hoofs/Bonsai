import {
  BadRequestException,
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
import type {
  ConversationFilter,
  ConversationSearchResult,
  ConversationTag,
  SavedFilter,
} from './conversation-search.service';
import { ConversationSearchService } from './conversation-search.service';
import {
  ConversationFilterDto,
  CreateConversationTagDto,
  CreateSavedFilterDto,
  TagConversationDto,
} from './dto';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the free-form `assignee` filter value ('me' | 'unassigned' | a
 * user id) to the concrete predicate the service expects. 'me' is resolved
 * here since only the request knows who the calling agent is.
 */
function resolveAssignee(
  raw: string | undefined,
  currentUserId: string,
): ConversationFilter['assignee'] {
  if (raw === undefined) return undefined;
  if (raw === 'unassigned') return 'unassigned';
  if (raw === 'me') return { userId: currentUserId };
  if (UUID_RE.test(raw)) return { userId: raw };
  throw new BadRequestException(
    "assignee must be 'me', 'unassigned', or a user id",
  );
}

function toFilter(
  dto: ConversationFilterDto,
  currentUserId: string,
): ConversationFilter {
  return {
    text: dto.text,
    status: dto.status,
    tagIds: dto.tagIds,
    assignee: resolveAssignee(dto.assignee, currentUserId),
    from: dto.from,
    to: dto.to,
  };
}

/**
 * Agent back-office: conversation tags, saved filter presets, and
 * filtered/full-text search over conversations. OIDC + tenant-membership
 * gated (global AuthGuard + MembershipGuard), agent role minimum — this is
 * the same audience as the conversation inbox itself.
 */
@Controller('tenants/:tenantId/projects/:projectId/conversations')
export class ConversationSearchController {
  constructor(private readonly search: ConversationSearchService) {}

  // --- Search ---------------------------------------------------------------

  @Post('search')
  @RequireRole('agent')
  runSearch(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: ConversationFilterDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ConversationSearchResult[]> {
    return this.search.search(
      tenant.schemaName,
      projectId,
      toFilter(dto, user.id),
    );
  }

  // --- Tags -----------------------------------------------------------------

  @Post('tags')
  @RequireRole('agent')
  createTag(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateConversationTagDto,
  ): Promise<ConversationTag> {
    return this.search.createTag(tenant.schemaName, projectId, dto);
  }

  @Get('tags')
  @RequireRole('agent')
  listTags(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<ConversationTag[]> {
    return this.search.listTags(tenant.schemaName, projectId);
  }

  @Delete('tags/:tagId')
  @RequireRole('agent')
  async deleteTag(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('tagId', ParseUUIDPipe) tagId: string,
  ): Promise<{ ok: true }> {
    await this.search.deleteTag(tenant.schemaName, projectId, tagId);
    return { ok: true };
  }

  @Post(':conversationId/tags')
  @RequireRole('agent')
  async tagConversation(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: TagConversationDto,
  ): Promise<{ ok: true }> {
    await this.search.tagConversation(
      tenant.schemaName,
      projectId,
      conversationId,
      dto.tagId,
    );
    return { ok: true };
  }

  @Delete(':conversationId/tags/:tagId')
  @RequireRole('agent')
  async untagConversation(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Param('tagId', ParseUUIDPipe) tagId: string,
  ): Promise<{ ok: true }> {
    await this.search.untagConversation(
      tenant.schemaName,
      projectId,
      conversationId,
      tagId,
    );
    return { ok: true };
  }

  // --- Saved filters --------------------------------------------------------

  @Post('saved-filters')
  @RequireRole('agent')
  createSavedFilter(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateSavedFilterDto,
    @CurrentUser() user: AuthUser,
  ): Promise<SavedFilter> {
    return this.search.createSavedFilter(
      tenant.schemaName,
      projectId,
      user.id,
      {
        name: dto.name,
        filter: dto.filter,
      },
    );
  }

  @Get('saved-filters')
  @RequireRole('agent')
  listSavedFilters(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<SavedFilter[]> {
    return this.search.listSavedFilters(tenant.schemaName, projectId, user.id);
  }

  @Delete('saved-filters/:filterId')
  @RequireRole('agent')
  async deleteSavedFilter(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('filterId', ParseUUIDPipe) filterId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.search.deleteSavedFilter(
      tenant.schemaName,
      projectId,
      user.id,
      filterId,
    );
    return { ok: true };
  }
}
