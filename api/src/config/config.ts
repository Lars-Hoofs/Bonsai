import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
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
  // Second-pass groundedness self-check (extra small LLM call). On by default;
  // can be disabled to trade a bit of safety for lower cost/latency.
  SELF_CHECK_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export interface AppConfig {
  databaseUrl: string;
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
  selfCheckEnabled: boolean;
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
    selfCheckEnabled: d.SELF_CHECK_ENABLED,
  };
}
