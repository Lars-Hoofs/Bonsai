import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  // Availability guardrails on the shared pg Pool: cap how long a single
  // statement or an idle-in-transaction session may hold a pooled
  // connection, so one hung query or abandoned transaction can't exhaust
  // the pool for every tenant. The control-plane migration runner exempts
  // its own session from statement_timeout (see migrator.ts) since DDL can
  // legitimately run long; these defaults are for normal request-path
  // queries/transactions only.
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // Must exceed INGESTION_TIMEOUT_MS (60s): ingestion holds a tenant
  // transaction open while awaiting the embedding HTTP call (the tx is "idle"
  // during that await), so this must not fire before the ingestion timeout
  // does its own clean failure. Guards against truly abandoned transactions.
  DB_IDLE_TX_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_JWKS_URL: z.string().url(),
  // Embeddings are fetched from an external API (self-host everything else on
  // the VPS). Optional so tests/dev can use the deterministic fake provider.
  EMBEDDING_API_URL: z.string().url().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(1024),
  // Answer LLM, also an external API. Optional so tests/dev use the fake.
  LLM_API_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  // Optional reranker (external API). Falls back to a deterministic lexical
  // fake when unset, so retrieval still works offline/in tests.
  RERANK_API_URL: z.string().url().optional(),
  RERANK_API_KEY: z.string().optional(),
  RERANK_MODEL: z.string().optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  // Per-IP cap on the unauthenticated widget config endpoint (see
  // WidgetPublicController): the widget key is resolved *inside* the
  // handler, so this route is an easy target for widget-key brute-forcing.
  // 60/min/IP is generous for a real embedded widget (config is fetched
  // once per page load) while still bounding guesswork.
  WIDGET_CONFIG_RATE_PER_MIN: z.coerce.number().int().positive().default(60),
  // Per-project+IP cap on the visitor `start` conversation endpoint (see
  // ConversationsPublicController): unbounded calls each create a
  // conversation row (and, on the first message, LLM spend), so this needs
  // its own tighter cap independent of the general per-tenant/per-route
  // limit above.
  CONVERSATION_START_RATE_PER_MIN: z.coerce
    .number()
    .int()
    .positive()
    .default(20),
  // Per-project+IP cap on the visitor "email me this transcript" endpoint
  // (see ConversationsPublicController): each call sends a real email via
  // self-hosted SMTP to a visitor-supplied address, so it's an obvious
  // abuse/spam-relay vector and needs its own tight cap independent of the
  // general per-tenant/per-route limit. 5/min/project+IP is ample for a
  // human clicking "email me this" while bounding automated abuse.
  TRANSCRIPT_EMAIL_RATE_PER_MIN: z.coerce.number().int().positive().default(5),
  // Redis for the re-crawl queue/scheduler. When unset, scheduled re-crawl is
  // disabled (on-demand reprocess still works).
  REDIS_URL: z.string().url().optional(),
  RECRAWL_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000),
  // A source stuck in 'processing' for longer than this (process crash /
  // uncaught termination mid-ingestion, so no catch block ever ran) is
  // treated as stale/abandoned and becomes eligible for re-ingestion again,
  // via reprocess or the recrawl scan — otherwise it could never recover.
  INGESTION_STALE_MS: z.coerce.number().int().positive().default(900_000),
  // Hard cap on inline (synchronous, in the HTTP request path) ingestion, so
  // a pathological source (slow website fetch, huge embedding batch) cannot
  // hold the request open indefinitely. Ingestion keeps running in the
  // background past this point; the request just stops waiting for it.
  INGESTION_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Object storage (MinIO / S3-compatible) for raw uploads. Optional: when
  // unset, uploads still work (text is extracted) but the raw file isn't kept.
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  // Second-pass groundedness self-check (extra small LLM call). On by default;
  // can be disabled to trade a bit of safety for lower cost/latency.
  SELF_CHECK_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Which groundedness verifier runs when SELF_CHECK_ENABLED is true (A7):
  // 'self-check' (default) issues one verdict for the whole answer, as
  // before. 'claim-nli' is a stricter, opt-in mode that splits the answer
  // into individual claims and requires EVERY claim to be independently
  // entailed by the sources, refusing if any single claim is unsupported.
  // When SELF_CHECK_ENABLED is false (e.g. tests), no verifier runs
  // regardless of this mode.
  VERIFICATION_MODE: z.enum(['self-check', 'claim-nli']).default('self-check'),
  // Multi-query retrieval (query expansion + cross-query RRF fusion): before
  // retrieving, an extra LLM call proposes alternative phrasings of the
  // question, each is retrieved independently, and the results are fused.
  // Improves recall on vague/short questions. On by default; requires a real
  // LLM to be configured (LLM_API_URL/KEY/MODEL) — with only the fake LLM
  // (tests/dev), expansion is skipped regardless of this flag so behavior
  // stays deterministic/single-query.
  MULTI_QUERY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Multi-turn conversational context (#27): when a question arrives with
  // recent conversation history, an extra LLM call condenses the (possibly
  // elliptical/follow-up) question into a standalone query for retrieval, and
  // the prior turns are additionally included as context in the answer
  // prompt. Global default; can be overridden per project via
  // `settings.multiTurnContextEnabled`. On by default; only ever engages when
  // a REAL llm is configured (LLM_API_URL) AND non-empty history is passed —
  // with only the fake LLM (tests/dev) or no history, behavior is identical to
  // single-turn (standalone query === question, no history in the prompt),
  // regardless of this flag.
  MULTI_TURN_CONTEXT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Max number of most-recent prior conversation turns fed into the
  // condense-query call and the answer prompt when multi-turn context is
  // active (#27). Bounds prompt size/cost; older turns are dropped.
  MULTI_TURN_MAX_TURNS: z.coerce.number().int().positive().default(6),
  // Parent-child retrieval (A6): context-window expansion. The reranker/top-k
  // selection still runs on the small embedded chunk (precision), but each
  // returned chunk also carries `expandedText` — that chunk plus up to
  // `retrievalWindow` neighboring chunks (by `ordinal`) from the same
  // document, concatenated in order — which is what actually gets sent to
  // the LLM as context. 0 disables expansion (expandedText === text),
  // reproducing pre-A6 behavior exactly.
  RETRIEVAL_WINDOW: z.coerce.number().int().nonnegative().default(1),
  // Billing/paywall enforcement. OFF by default for now (no payment provider
  // wired), so every tenant runs as if on a paid plan: answer usage is still
  // METERED for analytics, but the monthly quota is never enforced (no 402).
  // Flip to 'true' once a billing provider is connected.
  BILLING_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Allowed browser origins for the real-time chat Socket.IO gateway
  // (comma-separated). The `join` handler is the real security boundary
  // (widget key + visitor secret check), but this still bounds which origins
  // can open a socket connection at all. Empty by default (no cross-origin
  // socket access) until configured for a deployment's widget-embed domains.
  WIDGET_CORS_ORIGINS: z.string().default(''),
  // Answer cache (A9): caches grounded (non-refused) answers per project so
  // identical repeated questions skip retrieval+LLM. On by default; the
  // cache key includes a knowledge-version derived from
  // knowledge_sources.updated_at, so re-ingestion automatically invalidates
  // stale entries without any explicit purge.
  ANSWER_CACHE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  ANSWER_CACHE_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  // Bearer token gating GET /metrics (self-hosted Prometheus scrape
  // endpoint). Optional: when unset, the endpoint is only reachable outside
  // production (NODE_ENV !== 'production') so local/dev scraping still works
  // without extra setup; in production an unset token means the endpoint is
  // hard-disabled (404), since the metrics payload leaks internal
  // cardinalities (route names, tenant-scale counters) and must never be
  // publicly world-readable.
  METRICS_TOKEN: z.string().min(1).optional(),
  // Follow-up question suggestions (A11): after a non-refused answer, one
  // extra small LLM call proposes 2-3 short follow-up questions the visitor
  // might ask next, based only on the sources/answer. On by default; also
  // requires a real LLM to be configured (see AnswerService) — with only the
  // fake LLM (tests/dev), suggestions are always `[]` regardless of this flag.
  FOLLOWUP_SUGGESTIONS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Answer templates / canned answers per intent (#28): when a visitor's
  // question matches an active, short-circuiting answer-template trigger
  // (keyword or intent phrase) configured for the project, the answer
  // pipeline returns the editor-authored canned answer with attribution and
  // skips retrieval + LLM entirely. On by default; purely additive — a
  // project with no matching active template answers exactly as before, and
  // flipping this off disables template matching regardless of configured
  // templates.
  ANSWER_TEMPLATES_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Symmetric key for encrypting tenant-owned API connector credentials at
  // rest (AES-256-GCM, see EncryptionService). Accepts base64 or hex; must
  // decode to exactly 32 bytes. Optional so most of the app/tests can run
  // without it — but any code path that actually stores/reads connector
  // credentials requires it to be set, and fails loudly otherwise.
  ENCRYPTION_KEY: z.string().optional(),
  // Live tool-calling (part 2 of the connectors feature): lets the answer
  // pipeline route a question to a tenant-configured connector (see
  // ConnectorToolService) to fetch live data and cite it alongside KB
  // chunks. On by default; only ever engages when a REAL llm is configured
  // AND a ConnectorToolService is actually injected (see AnswerService), so
  // fake-LLM tests remain deterministic/unaffected regardless of this flag.
  TOOL_CALLING_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Near-duplicate chunk detection at ingest (#16): drops chunks whose
  // normalized text exactly matches an already-kept chunk, or whose
  // embedding cosine similarity to an already-kept chunk (within the same
  // source ingestion run) is >= NEAR_DUP_THRESHOLD. Keeps retrieval from
  // being polluted by repeated boilerplate (e.g. crawled nav/footer text)
  // and cuts embedding cost. On by default.
  DEDUP_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  NEAR_DUP_THRESHOLD: z.coerce.number().gt(0).lte(1).default(0.97),
  // Frustration/sentiment auto-escalation (#24): when a bot-driven
  // conversation shows signs of visitor frustration (explicit request for a
  // human, negative sentiment, or a run of consecutive bot refusals), the
  // conversation is automatically escalated to the existing handover flow
  // instead of waiting for the visitor to hit `escalate` themselves. On by
  // default.
  FRUSTRATION_AUTO_ESCALATE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Number of consecutive trailing bot refusals (most-recent-first,
  // including the answer just computed) that counts as a frustration signal
  // on its own, even without explicit negative wording.
  FRUSTRATION_REFUSAL_STREAK: z.coerce.number().int().positive().default(2),
  // Usage/cost analytics (#43): rough cost estimate = answers *
  // EST_TOKENS_PER_ANSWER / 1000 * COST_PER_1K_TOKENS. Both default to values
  // that make the estimate a no-op (price 0 => cost always 0) so there's no
  // dependency on external pricing data until an operator opts in by setting
  // a real price.
  COST_PER_1K_TOKENS: z.coerce.number().nonnegative().default(0),
  EST_TOKENS_PER_ANSWER: z.coerce.number().int().positive().default(1500),
  // Self-hosted Whisper transcription (#25): when WHISPER_ENABLED is true and
  // WHISPER_ENDPOINT points at a self-hosted, OpenAI-compatible Whisper HTTP
  // service (a Docker sidecar — no paid SaaS), uploaded audio/video files are
  // transcribed to text and fed into the normal chunking/embedding pipeline.
  // Off by default: audio/video uploads are rejected with a clear error until
  // an operator opts in. WHISPER_API_KEY is optional (most self-hosted servers
  // need none). The timeout bounds a single (potentially slow) transcription.
  WHISPER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  WHISPER_ENDPOINT: z.string().url().optional(),
  WHISPER_API_KEY: z.string().optional(),
  WHISPER_MODEL: z.string().default('whisper-1'),
  WHISPER_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // Self-hosted SMTP mail (free — no paid email provider). Optional: when
  // SMTP_HOST is unset, MailService is a no-op (logs at debug only), so
  // dev/test never send real mail. Fill these in for a real deployment.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // HMAC secret signing the widget theme "shareable preview" token (see
  // WidgetThemeController.createPreviewToken / WidgetPublicController.preview).
  // Optional: when unset, a fixed dev-only default is used so local/test runs
  // work out of the box — any real deployment that wants preview links to be
  // unforgeable across restarts/instances should set this explicitly.
  WIDGET_PREVIEW_TOKEN_SECRET: z
    .string()
    .min(1)
    .default('dev-only-insecure-widget-preview-secret'),
  // OCR fallback for scanned uploads (#24): self-hosted Tesseract via
  // tesseract.js (in-process WASM — free, no external Docker service, no
  // paid API). On by default. Languages are Tesseract language codes
  // ('+'-joined for multi-language recognition); 'nld' is Dutch, matching
  // this app's primary locale, with English as a fallback. Language
  // traineddata is downloaded/cached by tesseract.js itself on first use of
  // a given language — no bundling step required here.
  OCR_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OCR_LANGUAGES: z.string().min(1).default('nld+eng'),
  // Cap on PDF pages rasterized for OCR (follow-up: PDF rasterization isn't
  // implemented yet — see TesseractOcrProvider — but the cap is defined now
  // so it's already config-driven when that lands).
  OCR_MAX_PAGES: z.coerce.number().int().positive().default(20),
  // Plan/tier limits (#50), self-managed — no billing provider required.
  // Optional JSON object mapping a `tenants.plan` value to its limits, e.g.
  // '{"starter":{"maxProjects":2,"maxSourcesPerProject":20,"maxMembers":3}}'.
  // Any plan omitted from this map (or when the env var itself is unset)
  // falls back to the built-in DEFAULT_PLAN_LIMITS below. A plan whose
  // limits object sets a field to `null` (or the special "enterprise" plan,
  // which is always unlimited) means "no limit" for that dimension.
  PLAN_LIMITS_JSON: z.string().optional(),
});

// A `null` field means "no limit" for that dimension.
export interface PlanLimits {
  maxProjects: number | null;
  maxSourcesPerProject: number | null;
  maxMembers: number | null;
}

const UNLIMITED_PLAN_LIMITS: PlanLimits = {
  maxProjects: null,
  maxSourcesPerProject: null,
  maxMembers: null,
};

// Built-in defaults, used for any plan not present in PLAN_LIMITS_JSON (or
// when that env var is unset entirely). Deliberately generous for 'starter'
// so existing tenants/tests (which default to plan 'starter') don't trip
// these limits; enforcement itself is proven via a dedicated test suite
// (test/plan-limits.e2e.integration.spec.ts) that overrides PLAN_LIMITS_JSON
// with a tight 'tiny' plan and assigns it to a specific test tenant.
// maxMembers in particular is 10 (rather than a lower "typical starter"
// number) because test/conversations.e2e.integration.spec.ts's agent-
// presence suite accumulates 6 non-owner members (5 agents + 1 viewer) on a
// single tenant across its test cases.
export const DEFAULT_PLAN_LIMITS: Record<string, PlanLimits> = {
  starter: { maxProjects: 2, maxSourcesPerProject: 20, maxMembers: 10 },
  pro: { maxProjects: 20, maxSourcesPerProject: 200, maxMembers: 20 },
  enterprise: { ...UNLIMITED_PLAN_LIMITS },
};

const planLimitsSchema = z.record(
  z.string(),
  z.object({
    maxProjects: z.number().int().positive().nullable().optional(),
    maxSourcesPerProject: z.number().int().positive().nullable().optional(),
    maxMembers: z.number().int().positive().nullable().optional(),
  }),
);

function parsePlanLimits(raw: string | undefined): Record<string, PlanLimits> {
  if (!raw) return DEFAULT_PLAN_LIMITS;
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error(
      'Invalid configuration: PLAN_LIMITS_JSON is not valid JSON',
    );
  }
  const r = planLimitsSchema.safeParse(parsedJson);
  if (!r.success) {
    throw new Error(
      `Invalid configuration: PLAN_LIMITS_JSON: ${r.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const merged: Record<string, PlanLimits> = { ...DEFAULT_PLAN_LIMITS };
  for (const [plan, limits] of Object.entries(r.data)) {
    merged[plan] = {
      maxProjects: limits.maxProjects ?? null,
      maxSourcesPerProject: limits.maxSourcesPerProject ?? null,
      maxMembers: limits.maxMembers ?? null,
    };
  }
  return merged;
}

function decodeEncryptionKey(raw: string | undefined): Buffer | undefined {
  if (!raw) return undefined;
  // A 32-byte key is 64 hex chars but 44 base64 chars (with padding) — the
  // lengths never overlap, so we can disambiguate by input length rather
  // than by guessing from the alphabet (a hex string is also a valid,
  // differently-valued base64 string, so alphabet-sniffing is ambiguous).
  const isHexAlphabet = /^[0-9a-fA-F]+$/.test(raw);
  const decoded =
    isHexAlphabet && raw.length === 64
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');

  if (decoded.length !== 32) {
    throw new Error(
      `Invalid configuration: ENCRYPTION_KEY must decode (base64 or hex) to exactly 32 bytes, got ${decoded.length}`,
    );
  }
  return decoded;
}

export interface AppConfig {
  databaseUrl: string;
  dbStatementTimeoutMs: number;
  dbIdleTxTimeoutMs: number;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  oidcIssuer: string;
  oidcAudience: string;
  oidcJwksUrl: string;
  embeddingApiUrl?: string;
  embeddingApiKey?: string;
  embeddingModel?: string;
  embeddingDim: number;
  llmApiUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  rerankApiUrl?: string;
  rerankApiKey?: string;
  rerankModel?: string;
  rateLimitPerMinute: number;
  widgetConfigRatePerMin: number;
  conversationStartRatePerMin: number;
  transcriptEmailRatePerMin: number;
  redisUrl?: string;
  recrawlIntervalMs: number;
  ingestionStaleMs: number;
  ingestionTimeoutMs: number;
  s3Endpoint?: string;
  s3Region: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  s3Bucket?: string;
  selfCheckEnabled: boolean;
  verificationMode: 'self-check' | 'claim-nli';
  multiQueryEnabled: boolean;
  multiTurnContextEnabled: boolean;
  multiTurnMaxTurns: number;
  retrievalWindow: number;
  billingEnabled: boolean;
  widgetCorsOrigins: string[];
  metricsToken?: string;
  answerCacheEnabled: boolean;
  answerCacheTtlMs: number;
  followupSuggestionsEnabled: boolean;
  answerTemplatesEnabled: boolean;
  encryptionKey?: Buffer;
  toolCallingEnabled: boolean;
  dedupEnabled: boolean;
  nearDupThreshold: number;
  frustrationAutoEscalateEnabled: boolean;
  frustrationRefusalStreak: number;
  costPer1kTokens: number;
  estTokensPerAnswer: number;
  whisperEnabled: boolean;
  whisperEndpoint?: string;
  whisperApiKey?: string;
  whisperModel: string;
  whisperTimeoutMs: number;
  smtpHost?: string;
  smtpPort: number;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
  smtpSecure: boolean;
  widgetPreviewTokenSecret: string;
  ocrEnabled: boolean;
  ocrLanguages: string;
  ocrMaxPages: number;
  planLimits: Record<string, PlanLimits>;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const r = schema.safeParse(env);
  if (!r.success) {
    throw new Error(
      `Invalid configuration: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const d = r.data;
  return {
    databaseUrl: d.DATABASE_URL,
    dbStatementTimeoutMs: d.DB_STATEMENT_TIMEOUT_MS,
    dbIdleTxTimeoutMs: d.DB_IDLE_TX_TIMEOUT_MS,
    port: d.PORT,
    nodeEnv: d.NODE_ENV,
    oidcIssuer: d.OIDC_ISSUER,
    oidcAudience: d.OIDC_AUDIENCE,
    oidcJwksUrl: d.OIDC_JWKS_URL,
    embeddingApiUrl: d.EMBEDDING_API_URL,
    embeddingApiKey: d.EMBEDDING_API_KEY,
    embeddingModel: d.EMBEDDING_MODEL,
    embeddingDim: d.EMBEDDING_DIM,
    llmApiUrl: d.LLM_API_URL,
    llmApiKey: d.LLM_API_KEY,
    llmModel: d.LLM_MODEL,
    rerankApiUrl: d.RERANK_API_URL,
    rerankApiKey: d.RERANK_API_KEY,
    rerankModel: d.RERANK_MODEL,
    rateLimitPerMinute: d.RATE_LIMIT_PER_MINUTE,
    widgetConfigRatePerMin: d.WIDGET_CONFIG_RATE_PER_MIN,
    conversationStartRatePerMin: d.CONVERSATION_START_RATE_PER_MIN,
    transcriptEmailRatePerMin: d.TRANSCRIPT_EMAIL_RATE_PER_MIN,
    redisUrl: d.REDIS_URL,
    recrawlIntervalMs: d.RECRAWL_INTERVAL_MS,
    ingestionStaleMs: d.INGESTION_STALE_MS,
    ingestionTimeoutMs: d.INGESTION_TIMEOUT_MS,
    s3Endpoint: d.S3_ENDPOINT,
    s3Region: d.S3_REGION,
    s3AccessKey: d.S3_ACCESS_KEY,
    s3SecretKey: d.S3_SECRET_KEY,
    s3Bucket: d.S3_BUCKET,
    selfCheckEnabled: d.SELF_CHECK_ENABLED,
    verificationMode: d.VERIFICATION_MODE,
    multiQueryEnabled: d.MULTI_QUERY_ENABLED,
    multiTurnContextEnabled: d.MULTI_TURN_CONTEXT_ENABLED,
    multiTurnMaxTurns: d.MULTI_TURN_MAX_TURNS,
    retrievalWindow: d.RETRIEVAL_WINDOW,
    billingEnabled: d.BILLING_ENABLED,
    widgetCorsOrigins: d.WIDGET_CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    metricsToken: d.METRICS_TOKEN,
    answerCacheEnabled: d.ANSWER_CACHE_ENABLED,
    answerCacheTtlMs: d.ANSWER_CACHE_TTL_MS,
    followupSuggestionsEnabled: d.FOLLOWUP_SUGGESTIONS_ENABLED,
    answerTemplatesEnabled: d.ANSWER_TEMPLATES_ENABLED,
    encryptionKey: decodeEncryptionKey(d.ENCRYPTION_KEY),
    toolCallingEnabled: d.TOOL_CALLING_ENABLED,
    dedupEnabled: d.DEDUP_ENABLED,
    nearDupThreshold: d.NEAR_DUP_THRESHOLD,
    frustrationAutoEscalateEnabled: d.FRUSTRATION_AUTO_ESCALATE_ENABLED,
    frustrationRefusalStreak: d.FRUSTRATION_REFUSAL_STREAK,
    costPer1kTokens: d.COST_PER_1K_TOKENS,
    estTokensPerAnswer: d.EST_TOKENS_PER_ANSWER,
    whisperEnabled: d.WHISPER_ENABLED,
    whisperEndpoint: d.WHISPER_ENDPOINT,
    whisperApiKey: d.WHISPER_API_KEY,
    whisperModel: d.WHISPER_MODEL,
    whisperTimeoutMs: d.WHISPER_TIMEOUT_MS,
    smtpHost: d.SMTP_HOST,
    smtpPort: d.SMTP_PORT,
    smtpUser: d.SMTP_USER,
    smtpPass: d.SMTP_PASS,
    smtpFrom: d.SMTP_FROM,
    smtpSecure: d.SMTP_SECURE,
    widgetPreviewTokenSecret: d.WIDGET_PREVIEW_TOKEN_SECRET,
    ocrEnabled: d.OCR_ENABLED,
    ocrLanguages: d.OCR_LANGUAGES,
    ocrMaxPages: d.OCR_MAX_PAGES,
    planLimits: parsePlanLimits(d.PLAN_LIMITS_JSON),
  };
}
