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
import { CreateSynonymDto } from './dto';
import { SynonymsService } from './synonyms.service';

@Controller('tenants/:tenantId/projects/:projectId/synonyms')
export class SynonymsController {
  constructor(private readonly synonyms: SynonymsService) {}

  @Post()
  @RequireRole('editor')
  create(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateSynonymDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.synonyms.create(
      tenant.schemaName,
      projectId,
      dto,
      user.id,
      tenant.id,
    );
  }

  @Get()
  @RequireRole('viewer')
  list(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.synonyms.list(tenant.schemaName, projectId);
  }

  @Delete(':synonymId')
  @RequireRole('editor')
  async remove(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('synonymId', ParseUUIDPipe) synonymId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.synonyms.remove(tenant, projectId, synonymId, user.id);
    return { ok: true };
  }
}
