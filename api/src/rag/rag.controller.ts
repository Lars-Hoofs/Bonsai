import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Tenant } from '../auth/auth.types';
import type { TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { AnswerService } from './answer.service';
import { AnswerQuestionDto } from './dto';

@Controller('tenants/:tenantId/projects/:projectId')
export class RagController {
  constructor(private readonly answerService: AnswerService) {}

  @Post('answer')
  @RequireRole('viewer')
  answer(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: AnswerQuestionDto,
  ) {
    return this.answerService.answer(
      tenant.schemaName,
      projectId,
      dto.question,
    );
  }
}
