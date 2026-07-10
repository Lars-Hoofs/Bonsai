import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { CreateArticleDto, UpdateArticleDto } from './article.dto';
import { ArticlesService } from './articles.service';

/**
 * Manual Q&A / article editor. Editors author knowledge articles (rich-text ->
 * Markdown) or Q&A pairs with categories/tags; each becomes a first-class
 * `article` knowledge source that is chunked + embedded via the shared
 * ingestion pipeline, exactly like uploads/websites.
 */
@Controller('tenants/:tenantId/projects/:projectId/knowledge/articles')
export class ArticlesController {
  constructor(private readonly articles: ArticlesService) {}

  @Post()
  @RequireRole('editor')
  create(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateArticleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.articles.create(tenant, projectId, dto, user.id);
  }

  @Get()
  @RequireRole('viewer')
  list(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.articles.list(tenant.schemaName, projectId);
  }

  @Get(':articleId')
  @RequireRole('viewer')
  get(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('articleId', ParseUUIDPipe) articleId: string,
  ) {
    return this.articles.get(tenant.schemaName, projectId, articleId);
  }

  @Put(':articleId')
  @RequireRole('editor')
  update(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('articleId', ParseUUIDPipe) articleId: string,
    @Body() dto: UpdateArticleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.articles.update(tenant, projectId, articleId, dto, user.id);
  }

  @Delete(':articleId')
  @RequireRole('admin')
  async remove(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('articleId', ParseUUIDPipe) articleId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.articles.remove(tenant, projectId, articleId, user.id);
    return { ok: true };
  }
}
