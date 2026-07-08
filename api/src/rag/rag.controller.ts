import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Tenant } from '../auth/auth.types';
import type { TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { UsageService } from '../usage/usage.service';
import { RateLimitGuard } from '../usage/rate-limit.guard';
import { AnswerService } from './answer.service';
import type { AnswerResult } from './answer.service';
import { AnswerQuestionDto } from './dto';

@Controller('tenants/:tenantId/projects/:projectId')
export class RagController {
  constructor(
    private readonly answerService: AnswerService,
    private readonly usage: UsageService,
  ) {}

  @Post('answer')
  @RequireRole('viewer')
  @UseGuards(RateLimitGuard)
  async answer(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: AnswerQuestionDto,
  ): Promise<AnswerResult> {
    await this.usage.enforceAnswerQuota(tenant.id);
    const result = await this.answerService.answer(
      tenant.schemaName,
      projectId,
      dto.question,
    );
    await this.usage.recordAnswer(tenant.id);
    return result;
  }
}
