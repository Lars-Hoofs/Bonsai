import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
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
import { CreateSourceDto } from './dto';
import { extractUploadText } from './ingestion/extract-text';
import { KnowledgeSourcesService } from './knowledge-sources.service';
import { isAudioOrVideo } from './transcription/media-type';
import { TRANSCRIPTION_PROVIDER } from './transcription/transcription-provider';
import type { TranscriptionProvider } from './transcription/transcription-provider';

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
    @Inject(TRANSCRIPTION_PROVIDER)
    private readonly transcription: TranscriptionProvider,
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
    // Audio/video uploads are transcribed to text via the self-hosted Whisper
    // provider (#25); the resulting transcript is fed into the normal
    // chunking/embedding pipeline exactly like any other extracted text. When
    // Whisper is not enabled the upload is rejected with a clear 400 rather
    // than silently indexing nothing.
    let text: string;
    if (isAudioOrVideo(file.originalname, file.mimetype)) {
      if (!this.transcription.enabled) {
        throw new BadRequestException(
          'Audio/video transcription is not enabled on this deployment.',
        );
      }
      try {
        text = await this.transcription.transcribe(
          file.buffer,
          file.originalname,
          file.mimetype,
        );
      } catch {
        throw new BadRequestException(
          'Failed to transcribe the uploaded audio/video file.',
        );
      }
      if (text.length === 0) {
        throw new BadRequestException(
          'The uploaded audio/video produced an empty transcript.',
        );
      }
    } else {
      text = await extractUploadText(
        file.originalname,
        file.mimetype,
        file.buffer,
      );
    }
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
