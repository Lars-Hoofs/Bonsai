import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { EmbeddingModule } from '../knowledge/embedding/embedding.module';
import { ChunksController } from './chunks.controller';
import { ChunksService } from './chunks.service';

/**
 * Chunk inspector: view/search/edit/delete individual knowledge chunks of a
 * project, for KB tuning/debugging. Registered last in AppModule — it only
 * reads/writes the `chunks`/`documents` tables that KnowledgeModule's
 * ingestion already owns, via the same TenancyModule + EmbeddingModule
 * (EMBEDDING_PROVIDER is @Global(), but declared here explicitly for
 * clarity/DI correctness independent of import order).
 */
@Module({
  imports: [TenancyModule, EmbeddingModule],
  controllers: [ChunksController],
  providers: [ChunksService],
})
export class ChunksModule {}
