import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { AnswerTemplatesService } from './answer-templates.service';
import { CreateAnswerTemplateDto, UpdateAnswerTemplateDto } from './dto';

@Controller('tenants/:tenantId/projects/:projectId/answer-templates')
export class AnswerTemplatesController {
  constructor(private readonly templates: AnswerTemplatesService) {}

  @Post()
  @RequireRole('editor')
  create(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateAnswerTemplateDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.templates.create(
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
    return this.templates.list(tenant.schemaName, projectId);
  }

  @Patch(':templateId')
  @RequireRole('editor')
  update(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @Body() dto: UpdateAnswerTemplateDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.templates.update(tenant, projectId, templateId, dto, user.id);
  }

  @Delete(':templateId')
  @RequireRole('editor')
  async remove(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('templateId', ParseUUIDPipe) templateId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.templates.remove(tenant, projectId, templateId, user.id);
    return { ok: true };
  }
}
