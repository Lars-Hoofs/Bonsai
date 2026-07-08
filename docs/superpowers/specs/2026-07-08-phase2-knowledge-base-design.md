# Phase 2 — Knowledge Base Core — Design Spec

**Date:** 2026-07-08
**Status:** Approved to build
**Base:** builds on Phase 1 (commit 46fa240); per-tenant schema-per-tenant model, TenantDbService.withTenant, BullMQ-capable (Redis in compose).

## Goal
Each project gets a knowledge base that can be filled from multiple sources, processed into embedded + full-text-indexed chunks, with per-source status, and managed (inspect/reprocess/delete) via the API. This is the substrate the RAG pipeline (Phase 3) grounds on.

## Provider decision (from user)
Everything self-hosted on the Hetzner VPS; **the AI (embeddings + LLM) is called via an external HTTP API**. So: an `EmbeddingProvider` port with (a) an HTTP implementation configured by env (endpoint + key + model + dimension), and (b) a deterministic in-process fake for tests. Vector storage = **pgvector** (already in the Postgres image). Provider/model is a config choice, not hard-wired.

## Data model (per-tenant schema, migration 0002)
- `knowledge_sources(id, project_id, type, name, config jsonb, status, error_detail, last_synced_at, created_at, updated_at)`
  - type: manual | upload | csv | website (website in a later slice)
  - status: pending | processing | processed | failed | stale
- `documents(id, source_id, project_id, title, origin_url, content_hash, language, status, error_detail, created_at, updated_at)`
- `chunks(id, document_id, project_id, ordinal, text, token_count, section, metadata jsonb, embedding vector(EMBEDDING_DIM), tsv tsvector, created_at)`
  - HNSW index on embedding (vector_cosine_ops); GIN index on tsv; index on document_id/project_id.

Note: pgvector column dimension is fixed at creation. Default EMBEDDING_DIM = 1024. Changing the embedding model to a different dimension requires a migration + re-embed (documented).

## Config additions (zod)
- EMBEDDING_API_URL (url), EMBEDDING_API_KEY (string), EMBEDDING_MODEL (string), EMBEDDING_DIM (int, default 1024). Optional in `test`/`development` so tests use the fake.

## Components
- `EmbeddingProvider` port: `embed(texts: string[]): Promise<number[][]>` (batch). Impls: `HttpEmbeddingProvider` (POST {model, input} to EMBEDDING_API_URL, OpenAI-compatible response shape, configurable), `FakeEmbeddingProvider` (deterministic hash→unit vector of EMBEDDING_DIM, no network).
- `ChunkingService`: structure-aware, token-based (~300–800 tokens, ~12% overlap), returns {text, ordinal, section}.
- `IngestionService`: per document: normalize → chunk → embed (batch) → upsert chunks (embedding + tsv via to_tsvector) → set statuses; content-hash for dedupe/stale detection; sets source/document status transitions and error_detail on failure. Runs inside TenantDbService.withTenant.
- Source ingest adapters (slice 1): `manual` (title+markdown body), `csv` (column mapping question/answer or generic rows → documents). Slice 2: `upload` (TXT/MD now; PDF/Word later). Slice 3: `website` crawler + async BullMQ workers + re-crawl.
- Management endpoints under `/v1/tenants/:tenantId/projects/:projectId/…`:
  - POST `sources` (type+config+content) → creates source, ingests; GET `sources`, GET `sources/:id`; POST `sources/:id/reprocess`; DELETE `sources/:id` (cascades documents+chunks + vector cleanup).
  - GET `documents`, GET `documents/:id` (incl. chunks preview), PUT `documents/:id` (edit manual doc → re-embed), DELETE `documents/:id`.
  - RBAC: editor to mutate, viewer to read.

## Testing
TDD. Fake embedding provider (deterministic) so ingestion/retrieval are fully tested offline. Integration tests (testcontainers pgvector): ingest manual + CSV → assert documents/chunks created with non-null embeddings + tsv; reprocess idempotency; delete cascade; tenant isolation (chunks only in tenant schema); vector similarity query returns nearest chunk.

## Build slices
- 2a: datamodel migration + drizzle tables + config env + EmbeddingProvider (http+fake) + ChunkingService + IngestionService + manual & CSV sources + management endpoints + tests.
- 2b: file upload (TXT/MD/PDF/Word extraction).
- 2c: website scrape crawler + BullMQ async workers + scheduled re-crawl + change detection.

## Out of scope (this phase)
RAG retrieval/answer (Phase 3), integrations (Notion/Zendesk/Shopify), email-inbox learning, video/audio transcription — later phases.
