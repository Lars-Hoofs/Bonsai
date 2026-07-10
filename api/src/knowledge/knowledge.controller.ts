import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { sanitizeFilename } from '../storage/sanitize-filename';
import { StorageService } from '../storage/storage.service';
import { CreateSourceDto, SetSourceScheduleDto } from './dto';
import { extractUploadText } from './ingestion/extract-text';
import { KnowledgeSourcesService } from './knowledge-sources.service';

interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

// Multer buffers the whole upload into memory (MemoryStorage), so an
// unbounded file size is a memory-exhaustion DoS vector. Nest's
// FileInterceptor already maps the resulting Multer `LIMIT_FILE_SIZE` error
// to a clean PayloadTooLargeException (413) via its built-in
// transformException — no extra exception mapping needed here.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

@Controller('tenants/:tenantId/projects/:projectId/knowledge')
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeSourcesService,
    private readonly storage: StorageService,
  ) {}

  @Post('sources')
  @RequireRole('editor')
  create(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateSourceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.knowledge.create(tenant, projectId, dto, user.id);
  }

  @Post('sources/upload')
  @RequireRole('editor')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  async upload(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @UploadedFile() file: UploadedFileLike | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    if (!file) throw new BadRequestException('No file uploaded (field "file")');
    const text = await extractUploadText(
      file.originalname,
      file.mimetype,
      file.buffer,
    );
    // Retain the raw file in object storage when configured (for re-processing,
    // download and audit); text extraction/indexing works regardless.
    let storageKey: string | undefined;
    if (this.storage.enabled) {
      storageKey = `${tenant.schemaName}/uploads/${randomUUID()}-${sanitizeFilename(file.originalname)}`;
      await this.storage.put(storageKey, file.buffer, file.mimetype);
    }
    return this.knowledge.create(
      tenant,
      projectId,
      {
        type: 'upload',
        name: file.originalname,
        config: { title: file.originalname, body: text, storageKey },
      },
      user.id,
    );
  }

  @Get('sources')
  listSources(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.knowledge.list(tenant.schemaName, projectId);
  }

  // Aggregate health overview across all sources (roadmap #20): status, last
  // crawl time/error, and doc/chunk counts per source. Declared before the
  // `sources/:sourceId` route so 'health' is not swallowed as a source id.
  @Get('sources/health')
  @RequireRole('viewer')
  sourceHealth(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.knowledge.healthOverview(tenant.schemaName, projectId);
  }

  @Get('sources/:sourceId')
  getSource(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
  ) {
    return this.knowledge.get(tenant.schemaName, projectId, sourceId);
  }

  @Post('sources/:sourceId/reprocess')
  @RequireRole('editor')
  reprocess(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
  ) {
    return this.knowledge.reprocess(tenant.schemaName, projectId, sourceId);
  }

  // "Crawl now" (roadmap #19): trigger an immediate re-crawl/re-ingest.
  @Post('sources/:sourceId/crawl')
  @RequireRole('editor')
  crawlNow(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.knowledge.crawlNow(tenant, projectId, sourceId, user.id);
  }

  // Set (or clear) a per-source recurring re-crawl schedule (roadmap #19).
  @Put('sources/:sourceId/schedule')
  @RequireRole('editor')
  setSchedule(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @Body() dto: SetSourceScheduleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.knowledge.setSchedule(
      tenant,
      projectId,
      sourceId,
      dto.recrawlIntervalMs ?? null,
      user.id,
    );
  }

  @Delete('sources/:sourceId')
  @RequireRole('admin')
  async removeSource(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ ok: true }> {
    await this.knowledge.remove(tenant, projectId, sourceId, user.id);
    return { ok: true };
  }

  @Get('documents')
  listDocuments(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('sourceId') sourceId?: string,
  ) {
    return this.knowledge.listDocuments(tenant.schemaName, projectId, sourceId);
  }

  @Get('documents/:documentId')
  getDocument(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.knowledge.getDocument(tenant.schemaName, projectId, documentId);
  }
}
