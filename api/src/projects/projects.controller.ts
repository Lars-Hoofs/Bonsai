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
import { CreateProjectDto, UpdateProjectDto } from './dto';
import { ProjectsService } from './projects.service';

@Controller('tenants/:tenantId/projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @RequireRole('editor')
  create(@Tenant() tenant: TenantRef, @Body() dto: CreateProjectDto) {
    return this.projectsService.create(tenant, dto);
  }

  @Get()
  list(@Tenant() tenant: TenantRef) {
    return this.projectsService.list(tenant.schemaName);
  }

  @Get(':projectId')
  get(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) id: string,
  ) {
    return this.projectsService.get(tenant.schemaName, id);
  }

  @Patch(':projectId')
  @RequireRole('editor')
  update(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectsService.update(tenant.schemaName, id, dto);
  }

  @Delete(':projectId')
  @RequireRole('admin')
  async remove(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.projectsService.remove(tenant, id, user.id);
    return { ok: true };
  }
}
