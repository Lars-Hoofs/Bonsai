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
import { CannedResponsesService } from './canned-responses.service';
import {
  CreateCannedResponseDto,
  RenderCannedResponseDto,
  UpdateCannedResponseDto,
} from './dto';

// Project-scoped library of reusable canned responses / macros for human
// agents in the agent console (#35). Agent+ across the board: agents both
// manage the library and insert from it while replying.
@Controller('tenants/:tenantId/projects/:projectId/canned-responses')
export class CannedResponsesController {
  constructor(private readonly cannedResponses: CannedResponsesService) {}

  @Post()
  @RequireRole('agent')
  create(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateCannedResponseDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.cannedResponses.create(
      tenant.schemaName,
      projectId,
      dto,
      user.id,
      tenant.id,
    );
  }

  @Get()
  @RequireRole('agent')
  list(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.cannedResponses.list(tenant.schemaName, projectId);
  }

  @Get(':cannedResponseId')
  @RequireRole('agent')
  get(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('cannedResponseId', ParseUUIDPipe) cannedResponseId: string,
  ) {
    return this.cannedResponses.get(
      tenant.schemaName,
      projectId,
      cannedResponseId,
    );
  }

  @Patch(':cannedResponseId')
  @RequireRole('agent')
  update(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('cannedResponseId', ParseUUIDPipe) cannedResponseId: string,
    @Body() dto: UpdateCannedResponseDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.cannedResponses.update(
      tenant.schemaName,
      projectId,
      cannedResponseId,
      dto,
      user.id,
      tenant.id,
    );
  }

  // Preview/produce the insertable text with {{placeholder}} variables filled
  // in from the supplied values. Does not create a message — the agent sends
  // it through the normal agent-message flow.
  @Post(':cannedResponseId/render')
  @RequireRole('agent')
  render(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('cannedResponseId', ParseUUIDPipe) cannedResponseId: string,
    @Body() dto: RenderCannedResponseDto,
  ) {
    return this.cannedResponses.render(
      tenant.schemaName,
      projectId,
      cannedResponseId,
      dto.values ?? {},
    );
  }

  @Delete(':cannedResponseId')
  @RequireRole('agent')
  async remove(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('cannedResponseId', ParseUUIDPipe) cannedResponseId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.cannedResponses.remove(
      tenant,
      projectId,
      cannedResponseId,
      user.id,
    );
    return { ok: true };
  }
}
