import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Tenant } from '../../auth/auth.types';
import type { TenantRef } from '../../auth/auth.types';
import { RequireRole } from '../../auth/roles.decorator';
import { RagDebugService } from './rag-debug.service';
import type { DebugRetrieveResult } from './rag-debug.service';
import { DebugRetrieveDto } from './dto';

/**
 * Retrieval-only debug/explainability endpoint (#26): for a given question,
 * shows exactly what `RetrievalService` returns (chunks + scores + similarity
 * + preview), for tuning/inspection. Deliberately editor+ only (surfaces raw
 * chunk text/source metadata) and NEVER calls the LLM — this is purely a
 * read-only view over retrieval, with no effect on the `/answer` endpoint.
 */
@Controller('tenants/:tenantId/projects/:projectId/debug')
export class RagDebugController {
  constructor(private readonly debugService: RagDebugService) {}

  @Post('retrieve')
  @RequireRole('editor')
  retrieve(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: DebugRetrieveDto,
  ): Promise<DebugRetrieveResult> {
    return this.debugService.retrieve(
      tenant.schemaName,
      projectId,
      dto.question,
      dto.topK,
    );
  }
}
