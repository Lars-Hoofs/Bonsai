import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { ChunksService } from './chunks.service';
import type { ChunkDetail, ChunkListItem } from './chunks.service';
import { UpdateChunkDto } from './dto';

@Controller('tenants/:tenantId/projects/:projectId/chunks')
export class ChunksController {
  constructor(private readonly chunks: ChunksService) {}

  @Get()
  @RequireRole('viewer')
  list(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('documentId') documentId?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<ChunkListItem[]> {
    return this.chunks.list(tenant.schemaName, projectId, {
      documentId,
      q,
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
    });
  }

  @Get(':chunkId')
  @RequireRole('viewer')
  get(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('chunkId', ParseUUIDPipe) chunkId: string,
  ): Promise<ChunkDetail> {
    return this.chunks.get(tenant.schemaName, projectId, chunkId);
  }

  @Patch(':chunkId')
  @RequireRole('editor')
  update(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('chunkId', ParseUUIDPipe) chunkId: string,
    @Body() dto: UpdateChunkDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ChunkDetail> {
    return this.chunks.update(tenant, projectId, chunkId, dto.text, user.id);
  }

  @Delete(':chunkId')
  @RequireRole('editor')
  async remove(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('chunkId', ParseUUIDPipe) chunkId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.chunks.remove(tenant, projectId, chunkId, user.id);
    return { ok: true };
  }
}
