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
  };
}
