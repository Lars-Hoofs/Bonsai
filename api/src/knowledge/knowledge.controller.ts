import {
  BadRequestException,
  Controller,
  Body,
  Delete,
  Get,
  Inject,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, Tenant } from '../auth/auth.types';
import type { AuthUser, TenantRef } from '../auth/auth.types';
import { RequireRole } from '../auth/roles.decorator';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';
import { sanitizeFilename } from '../storage/sanitize-filename';
import { StorageService } from '../storage/storage.service';
import { KbBulkService, ImportSummary } from './bulk/kb-bulk.service';
import { CreateSourceDto, ExportKnowledgeDto, ImportKnowledgeDto } from './dto';
import { extractUploadText } from './ingestion/extract-text';
import { OCR_PROVIDER } from './ingestion/ocr-provider';
import type { OcrProvider } from './ingestion/ocr-provider';
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
    private readonly bulk: KbBulkService,
    // Optional so tests that construct KnowledgeController directly (no DI
    // container) keep working unchanged; without a config, OCR is treated as
    // disabled (extractUploadText requires ocrEnabled truthy to ever OCR).
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
    @Optional()
    @Inject(OCR_PROVIDER)
    private readonly ocrProvider?: OcrProvider,
  ) {}

  @Get('export')
  @RequireRole('editor')
  async exportKnowledge(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ExportKnowledgeDto,
    @CurrentUser() user: AuthUser,
    // Non-passthrough: we write the body ourselves so a Buffer (the zip
    // bundle) is sent verbatim rather than JSON-serialized by Nest's
    // serializer into `{"type":"Buffer",...}`.
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.bulk.export(
      tenant,
      projectId,
      query.format ?? 'json',
      user.id,
    );
    res.setHeader('Content-Type', result.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`,
    );
    res.send(result.body);
  }

  @Post('import')
  @RequireRole('editor')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }),
  )
  async importKnowledge(
    @Tenant() tenant: TenantRef,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: ImportKnowledgeDto,
    @UploadedFile() file: UploadedFileLike | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<ImportSummary> {
    if (!file) throw new BadRequestException('No file uploaded (field "file")');
    try {
      return await this.bulk.import(
        tenant,
        projectId,
        dto.format,
        file.buffer,
        user.id,
      );
    } catch (err) {
      // Bundle-level parse/size failures (not per-row) surface as 400s with
      // the clear message from the bundle parser.
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Ongeldige bundle',
      );
    }
  }

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
      {
        ocrEnabled: this.config?.ocrEnabled ?? false,
        ocrProvider: this.ocrProvider,
      },
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
