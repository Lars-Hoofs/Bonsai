import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { CreateSourceDto } from './dto';
import { KnowledgeSourcesService } from './knowledge-sources.service';

@Controller('tenants/:tenantId/projects/:projectId/knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeSourcesService) {}

  @Post('sources')
  @RequireRole('editor')
  create(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateSourceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.knowledge.create(tenant, projectId, dto, user.id);
  }

  @Get('sources')
  listSources(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.knowledge.list(tenant.schemaName, projectId);
  }

  @Get('sources/:sourceId')
  getSource(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
  ) {
    return this.knowledge.get(tenant.schemaName, projectId, sourceId);
  }

  @Post('sources/:sourceId/reprocess')
  @RequireRole('editor')
  reprocess(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
  ) {
    return this.knowledge.reprocess(tenant.schemaName, projectId, sourceId);
  }

  @Delete('sources/:sourceId')
  @RequireRole('admin')
  async removeSource(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.knowledge.remove(tenant, projectId, sourceId, user.id);
    return { ok: true };
  }

  @Get('documents')
  listDocuments(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('sourceId') sourceId?: string,
  ) {
    return this.knowledge.listDocuments(tenant.schemaName, projectId, sourceId);
  }

  @Get('documents/:documentId')
  getDocument(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.knowledge.getDocument(tenant.schemaName, projectId, documentId);
  }
}
