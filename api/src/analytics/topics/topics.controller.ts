import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Tenant } from '../../auth/auth.types';
import type { TenantRef } from '../../auth/auth.types';
import { RequireRole } from '../../auth/roles.decorator';
import { TopicQueryDto, TopicTrendsQueryDto } from './dto';
import { TopicsService } from './topics.service';

/**
 * Topic/intent analytics (#42). Classifies the opening visitor question of each
 * conversation in a time window into support intents (fixed keyword heuristics)
 * and/or emergent embedding clusters, and exposes the distribution and trends
 * over time for a project.
 *
 * Read-only, viewer-gated to match the rest of the analytics module. Tenant is
 * resolved from the request context (schema-scoped) and the project is a route
 * param, so results are strictly tenant- and project-scoped.
 */
@Controller('tenants/:tenantId/projects/:projectId/analytics/topics')
@RequireRole('viewer')
export class TopicsController {
  constructor(private readonly topics: TopicsService) {}

  @Get()
  distribution(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: TopicQueryDto,
  ) {
    return this.topics.distribution(tenant.schemaName, projectId, query);
  }

  @Get('trends')
  trends(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: TopicTrendsQueryDto,
  ) {
    return this.topics.trends(tenant.schemaName, projectId, query);
  }
}
