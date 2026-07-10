import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import {
  ClusterUnansweredQuestionsDto,
  ListUnansweredQuestionsDto,
  SetResolvedDto,
} from './dto';
import { UnansweredQuestionsService } from './unanswered-questions.service';

/**
 * Editor-facing view over questions the bot could not answer (#32) and the
 * clustered KB-gap suggestions derived from them (#41). Read/cluster is
 * `viewer`+ (analysts inspecting gaps), toggling a question resolved is
 * `editor`+ (someone actually curating the KB).
 */
@Controller('tenants/:tenantId/projects/:projectId/unanswered-questions')
export class UnansweredQuestionsController {
  constructor(private readonly unanswered: UnansweredQuestionsService) {}

  @Get()
  @RequireRole('viewer')
  list(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ListUnansweredQuestionsDto,
  ) {
    return this.unanswered.list(tenant.schemaName, projectId, {
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Get('suggestions')
  @RequireRole('viewer')
  suggestions(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ClusterUnansweredQuestionsDto,
  ) {
    return this.unanswered.suggestKbGaps(tenant.schemaName, projectId, {
      threshold:
        query.threshold === undefined ? undefined : Number(query.threshold),
      minSize: query.minSize,
      limit: query.limit,
    });
  }

  @Patch(':id')
  @RequireRole('editor')
  setResolved(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetResolvedDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.unanswered.setResolved(
      tenant,
      projectId,
      id,
      dto.resolved,
      user.id,
    );
  }
}
