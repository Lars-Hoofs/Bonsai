# Bonsai Backend — Design Spec

**Date:** 2026-07-08
**Status:** Approved (verbal, session with Lars)
**Scope:** Full backend (API-first) for Bonsai, a multi-tenant AI customer-service chatbot SaaS. Frontend (dashboard + widget UI) is explicitly out of scope for this spec; the backend serves them as API clients.

## Product principles (drive every decision)

1. **Reliability / anti-hallucination is an architecture principle.** Answers come exclusively from the tenant's knowledge base or connected live APIs. Below a configurable confidence threshold the bot refuses honestly and offers human handover. Citations are first-class data.
2. **Design quality** is a frontend concern, but the backend must serve it: theme config as versioned draft/published JSON, delivered fast and cacheable.
3. **100% compliance (GDPR/AVG), EU-only data.** Audit logging, data export, right-to-erasure, retention policies, and EU-hosted dependencies are foundation features, not add-ons.
4. **Quality over speed.** No hard MVP deadline. TDD throughout.

## Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | **Modular monolith (NestJS)**, AI/RAG pipeline as an isolated module with a service-shaped interface | One deployable; AI module can be lifted to its own service later without rewrite |
| Language/framework | **TypeScript + NestJS** (user preference) | Full-stack TS; NestJS module system matches the modular-monolith design |
| Database | **PostgreSQL 16+** with **pgvector** | One system for relational + vector in phase 1 |
| Tenant isolation | **Schema-per-tenant** (user choice). Control-plane tables in `public`; each tenant gets `tenant_<id>` schema | Structural isolation; strong compliance story. Documented escape hatch: a shared "pool" schema tier if tenant count ever explodes (not built now) |
| Data access | **Drizzle ORM** | Explicit connection/transaction control needed for per-request `search_path` switching |
| Auth | **Managed OIDC provider, EU-hosted** (user choice). Candidates: Zitadel (EU), Ory Network (EU), Auth0 EU region. Treated as swappable dependency: backend only validates JWTs and maps identities to memberships | SSO/SAML/MFA out of the box for enterprise; must have EU hosting + DPA |
| Queue/workers | **Redis + BullMQ** | Ingestion, crawling, embedding, transcription as async jobs |
| Object storage | **MinIO** (S3-compatible, self-hosted on Hetzner) | Raw uploads/media, EU data control |
| Hosting | **Hetzner VPS, Docker Compose** (API + Postgres + Redis + MinIO + Caddy/Traefik TLS on `chat.bonsaimedia.nl`) | Existing VPS; K8s deferred |
| Answer model | **Lightweight-class LLM behind a provider abstraction** (Haiku-class / mini/flash-class / EU-hosted open model). Pluggable per tenant/plan; no single hard-wired vendor | Cost target well under €1/chat; quality comes from the pipeline, not model size |
| Embeddings | Multilingual model behind the same abstraction; embedding model versioned per corpus | NL+EN required; re-embed on model change |
| Realtime | **WebSockets (NestJS gateway + Redis pub/sub adapter)** | Chat streaming + live agent handover |
| Public API | **REST + OpenAPI** (auto-generated), WebSockets for chat | API-first requirement |

## System overview

```
widget/dashboard/API clients
        │ HTTPS/WSS
   [Caddy/Traefik TLS]
        │
   [NestJS modular monolith]
   ├── auth (OIDC validation, API keys, RBAC guards)
   ├── tenancy (tenant lifecycle, schema provisioning, search_path context)
   ├── projects
   ├── knowledge (sources, documents, chunks; ingestion orchestration)
   ├── ai-pipeline (retrieval → rerank → grounded generation → verify → confidence)  [isolated]
   ├── conversations (sessions, messages, escalation, agent inbox, WS gateway)
   ├── widget-config (theme JSON, draft/published, public delivery)
   ├── analytics (aggregates, unanswered questions)
   ├── developer (API keys, webhooks, OpenAPI)
   ├── billing/usage (metering, caps)
   └── compliance (audit log, export, erasure, retention)
        │                │
   [PostgreSQL+pgvector] [Redis/BullMQ workers] [MinIO]
        │
   External: LLM/embedding providers, OIDC provider, tenant APIs, integrations
```

## Data model

**Control plane (`public` schema):**
- `tenants(id, name, slug, plan, data_region, status, created_at)`
- `users(id, oidc_subject, email, name, created_at)` — mirror of provider identities
- `memberships(tenant_id, user_id, role)` — roles: owner, admin, editor, agent, viewer
- `api_keys(id, tenant_id, project_ref, key_prefix, key_hash, scopes[], kind: secret|public_widget, allowed_origins[], last_used_at, revoked_at)`
- `audit_log(id, tenant_id, actor, action, resource, metadata, created_at)` — append-only
- `tenant_migrations(tenant_id, version, applied_at)`

**Per-tenant schema (`t_<shortid>`):**
- `projects(id, name, default_language, status, settings)` — settings: confidence threshold, escalation rules, business hours, model tier, languages
- `knowledge_sources(id, project_id, type, config, status, last_synced_at, error_detail)` — types: website, manual, upload, csv, api_connector, integration, email, media
- `documents(id, source_id, project_id, title, origin_url, content_hash, language, status, updated_at)`
- `chunks(id, document_id, project_id, text, embedding vector, token_count, section, metadata, last_seen_at)` + tsvector index (hybrid retrieval)
- `api_connectors(id, project_id, name, base_url, auth_encrypted, request_schema, response_mapping, usage_rules)`
- `conversations(id, project_id, visitor_id, channel, status, language, started_at, ended_at, resolution)`
- `messages(id, conversation_id, role: visitor|bot|agent|system, content, confidence, refused, model_used, latency_ms, tokens, created_at)`
- `message_citations(message_id, chunk_id, document_id, score)`
- `handovers(id, conversation_id, agent_user_id, reason, started_at, returned_at)`
- `widget_themes(id, project_id, config, icon_asset_ref, version, published, updated_at)` — draft + published rows
- `unanswered_questions(id, project_id, question, count, status)`
- `webhooks(id, project_id, url, events[], secret)`
- `usage_records(project_id, metric, value, period)`

## Request flow (tenancy)

1. Request arrives with OIDC JWT (dashboard) or API key (developer/widget).
2. Auth guard validates credential → resolves `tenant_id` + role/scopes.
3. Tenancy interceptor opens a transaction and issues `SET LOCAL search_path TO t_<id>, public` on the Drizzle connection.
4. All module code runs inside that transaction; wrong schema = structurally no access. App-level tenant guard is a second defense layer.
5. Widget public keys are additionally origin-checked (Allowed-Origins) and rate-limited per key.

Tenant provisioning: create schema → run per-tenant migration track → record in `tenant_migrations`. Two migration tracks (control-plane, per-tenant), both automated and transactional.

## AI pipeline (isolated module)

Interface: `answer(projectId, conversationId, message) → { answer, confidence, refused, citations[], escalationSuggested, usage }`.

Stages (each pluggable):
1. **Retrieval** — hybrid: pgvector cosine + Postgres full-text, metadata-filtered to project+language; parent-child chunk expansion.
2. **Rerank** — cross-encoder reranker (phase 2; phase 1 uses retrieval+coverage scores).
3. **Generation** — lightweight LLM, strict grounding prompt, must emit citation markers per claim; provider abstraction (`LlmProvider` port).
4. **Verification** — self-check call ("is every claim covered by the sources? yes/no+reason"); upgrade path to verifier model / claim-NLI.
5. **Confidence gate** — combined score (retrieval top score, coverage, self-check) vs. project threshold → below: honest refusal + handover offer.
6. **Live tool-calling** — tenant `api_connectors` invoked as tools; responses treated as citable sources; on failure the model must not invent.

Answer + citations + confidence stored on `messages`/`message_citations` (explains "why did the bot say this" in the dashboard).

## Ingestion (workers, BullMQ)

Common pipeline: fetch → normalize to clean text → chunk (structure-aware, parent-child, ~300–800 tokens) → embed → index → status update. Content-hash per document for re-crawl diffing. Statuses: processing | processed | failed(+detail) | stale.

Phase-1 sources: manual editor docs, file upload (PDF/TXT/MD/Word), CSV Q&A, website scrape (sitemap + link-follow, robots-respecting, interval re-crawl with hash diff).
Later: integrations (Notion/GDrive/Zendesk/Shopify), email-inbox learning (suggest → admin approves), video/audio transcription.

## Conversations & handover

- WS gateway (Redis adapter) for visitor chat streaming and agent inbox.
- Escalation triggers: low confidence, explicit request, frustration heuristic, configured intents.
- Inside business hours: live handover in the same conversation (status → handover, agent messages relayed). Outside: ticket/e-mail capture.
- Agent can return conversation to bot; resolved handovers can be converted into approved Q&A suggestions (learning loop).
- Notifications: e-mail first; Slack/webhook/push later.

## Compliance foundation

- Append-only audit log for all mutating actions.
- GDPR: per-tenant data export (JSON), right-to-erasure (subject-level and tenant-level), data-processing records, configurable retention policies (auto-purge conversations after N days).
- Encryption: TLS in transit; connector credentials encrypted at rest (app-level AES-GCM with KMS-style key handling); disk encryption on VPS.
- PII-aware logging (no message content in logs).

## Cross-cutting

Config validation (zod/env), structured logging + request IDs, health/readiness endpoints, global DTO validation + error envelope, per-tenant/per-key rate limiting (Redis), usage metering hooks, auto-generated OpenAPI at `/docs`.

## Testing strategy

TDD. Unit tests per module; integration tests against real Postgres (testcontainers) including **explicit cross-tenant isolation tests**; pipeline eval harness with golden test sets per project (groundedness, refusal correctness, citation accuracy) — regression-run on knowledge/model changes.

## Build phases

1. **Platform foundation** — NestJS skeleton, Docker Compose, control-plane schema, tenant provisioning + schema-per-tenant machinery, OIDC validation + API keys + RBAC, audit log, health/config/logging, OpenAPI.
2. **Knowledge base core** — sources/documents/chunks, ingestion workers (manual, upload, CSV, scrape), embedding + indexing, status/inspection endpoints.
3. **RAG answer pipeline** — hybrid retrieval, grounded generation, citations, self-check, confidence gate, provider abstraction.
4. **Conversations + handover** — sessions, WS gateway, escalation, agent inbox, business hours.
5. **Widget config** — theme draft/publish, public cached delivery endpoint.
6. **Analytics + developer API** — aggregates, unanswered questions, webhooks.
7. **Billing/usage + hardening** — metering, caps, rate-limit tuning, retention automation.

## Out of scope (this spec)

Dashboard/widget frontend, drag-and-drop builder UI, pricing/billing provider integration, extra channels (WhatsApp etc.), fine-tuning, K8s.
