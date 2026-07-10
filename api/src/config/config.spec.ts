import { loadConfig } from './config';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/bonsai',
  OIDC_ISSUER: 'https://id.example.eu',
  OIDC_AUDIENCE: 'bonsai-api',
  OIDC_JWKS_URL: 'https://id.example.eu/keys',
  NODE_ENV: 'test',
};

describe('loadConfig', () => {
  it('parses valid env with default port', () => {
    const cfg = loadConfig(valid);
    expect(cfg.port).toBe(3000);
    expect(cfg.oidcIssuer).toBe('https://id.example.eu');
  });
  it('throws on missing DATABASE_URL', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { DATABASE_URL, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it('defaults multiQueryEnabled to true', () => {
    const cfg = loadConfig(valid);
    expect(cfg.multiQueryEnabled).toBe(true);
  });

  it('parses MULTI_QUERY_ENABLED=false', () => {
    const cfg = loadConfig({ ...valid, MULTI_QUERY_ENABLED: 'false' });
    expect(cfg.multiQueryEnabled).toBe(false);
  });

  it('defaults multiTurnContextEnabled to true and multiTurnMaxTurns to 6', () => {
    const cfg = loadConfig(valid);
    expect(cfg.multiTurnContextEnabled).toBe(true);
    expect(cfg.multiTurnMaxTurns).toBe(6);
  });

  it('parses MULTI_TURN_CONTEXT_ENABLED=false', () => {
    const cfg = loadConfig({ ...valid, MULTI_TURN_CONTEXT_ENABLED: 'false' });
    expect(cfg.multiTurnContextEnabled).toBe(false);
  });

  it('parses MULTI_TURN_MAX_TURNS', () => {
    const cfg = loadConfig({ ...valid, MULTI_TURN_MAX_TURNS: '10' });
    expect(cfg.multiTurnMaxTurns).toBe(10);
  });

  it('rejects a non-positive MULTI_TURN_MAX_TURNS', () => {
    expect(() => loadConfig({ ...valid, MULTI_TURN_MAX_TURNS: '0' })).toThrow(
      /MULTI_TURN_MAX_TURNS/,
    );
  });

  it('defaults retrievalWindow to 1', () => {
    const cfg = loadConfig(valid);
    expect(cfg.retrievalWindow).toBe(1);
  });

  it('parses RETRIEVAL_WINDOW', () => {
    const cfg = loadConfig({ ...valid, RETRIEVAL_WINDOW: '2' });
    expect(cfg.retrievalWindow).toBe(2);
  });

  it('rejects a negative RETRIEVAL_WINDOW', () => {
    expect(() => loadConfig({ ...valid, RETRIEVAL_WINDOW: '-1' })).toThrow(
      /RETRIEVAL_WINDOW/,
    );
  });

  it('defaults followupSuggestionsEnabled to true', () => {
    const cfg = loadConfig(valid);
    expect(cfg.followupSuggestionsEnabled).toBe(true);
  });

  it('parses FOLLOWUP_SUGGESTIONS_ENABLED=false', () => {
    const cfg = loadConfig({
      ...valid,
      FOLLOWUP_SUGGESTIONS_ENABLED: 'false',
    });
    expect(cfg.followupSuggestionsEnabled).toBe(false);
  });

  it('leaves encryptionKey undefined when ENCRYPTION_KEY is unset', () => {
    const cfg = loadConfig(valid);
    expect(cfg.encryptionKey).toBeUndefined();
  });

  it('decodes a base64-encoded 32-byte ENCRYPTION_KEY', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const cfg = loadConfig({ ...valid, ENCRYPTION_KEY: key });
    expect(cfg.encryptionKey).toHaveLength(32);
    expect(cfg.encryptionKey?.equals(Buffer.alloc(32, 7))).toBe(true);
  });

  it('decodes a hex-encoded 32-byte ENCRYPTION_KEY', () => {
    const key = Buffer.alloc(32, 9).toString('hex');
    const cfg = loadConfig({ ...valid, ENCRYPTION_KEY: key });
    expect(cfg.encryptionKey).toHaveLength(32);
    expect(cfg.encryptionKey?.equals(Buffer.alloc(32, 9))).toBe(true);
  });

  it('throws a clear error when ENCRYPTION_KEY decodes to the wrong length', () => {
    const shortKey = Buffer.alloc(16, 1).toString('base64');
    expect(() => loadConfig({ ...valid, ENCRYPTION_KEY: shortKey })).toThrow(
      /ENCRYPTION_KEY must decode.*32 bytes/,
    );
  });

  it('defaults dedupEnabled to true', () => {
    const cfg = loadConfig(valid);
    expect(cfg.dedupEnabled).toBe(true);
  });

  it('parses DEDUP_ENABLED=false', () => {
    const cfg = loadConfig({ ...valid, DEDUP_ENABLED: 'false' });
    expect(cfg.dedupEnabled).toBe(false);
  });

  it('defaults nearDupThreshold to 0.97', () => {
    const cfg = loadConfig(valid);
    expect(cfg.nearDupThreshold).toBe(0.97);
  });

  it('parses NEAR_DUP_THRESHOLD', () => {
    const cfg = loadConfig({ ...valid, NEAR_DUP_THRESHOLD: '0.9' });
    expect(cfg.nearDupThreshold).toBe(0.9);
  });

  it('rejects a NEAR_DUP_THRESHOLD of 0', () => {
    expect(() => loadConfig({ ...valid, NEAR_DUP_THRESHOLD: '0' })).toThrow(
      /NEAR_DUP_THRESHOLD/,
    );
  });

  it('rejects a NEAR_DUP_THRESHOLD above 1', () => {
    expect(() => loadConfig({ ...valid, NEAR_DUP_THRESHOLD: '1.5' })).toThrow(
      /NEAR_DUP_THRESHOLD/,
    );
  });

  it('defaults whisperEnabled to false with a default model/timeout', () => {
    const cfg = loadConfig(valid);
    expect(cfg.whisperEnabled).toBe(false);
    expect(cfg.whisperEndpoint).toBeUndefined();
    expect(cfg.whisperModel).toBe('whisper-1');
    expect(cfg.whisperTimeoutMs).toBe(300_000);
  });

  it('parses WHISPER_ENABLED + endpoint/model/timeout', () => {
    const cfg = loadConfig({
      ...valid,
      WHISPER_ENABLED: 'true',
      WHISPER_ENDPOINT: 'http://whisper:8000/v1/audio/transcriptions',
      WHISPER_MODEL: 'small',
      WHISPER_TIMEOUT_MS: '60000',
    });
    expect(cfg.whisperEnabled).toBe(true);
    expect(cfg.whisperEndpoint).toBe(
      'http://whisper:8000/v1/audio/transcriptions',
    );
    expect(cfg.whisperModel).toBe('small');
    expect(cfg.whisperTimeoutMs).toBe(60_000);
  });

  it('rejects a non-URL WHISPER_ENDPOINT', () => {
    expect(() =>
      loadConfig({ ...valid, WHISPER_ENDPOINT: 'not-a-url' }),
    ).toThrow(/WHISPER_ENDPOINT/);
  });

  it('defaults planLimits to the built-in map when PLAN_LIMITS_JSON is unset', () => {
    const cfg = loadConfig(valid);
    expect(cfg.planLimits.starter).toEqual({
      maxProjects: 2,
      maxSourcesPerProject: 20,
      maxMembers: 10,
    });
    expect(cfg.planLimits.pro).toEqual({
      maxProjects: 20,
      maxSourcesPerProject: 200,
      maxMembers: 20,
    });
    expect(cfg.planLimits.enterprise).toEqual({
      maxProjects: null,
      maxSourcesPerProject: null,
      maxMembers: null,
    });
  });

  it('overrides a single plan via PLAN_LIMITS_JSON while keeping other defaults', () => {
    const cfg = loadConfig({
      ...valid,
      PLAN_LIMITS_JSON: JSON.stringify({
        starter: { maxProjects: 1, maxSourcesPerProject: 5, maxMembers: 2 },
      }),
    });
    expect(cfg.planLimits.starter).toEqual({
      maxProjects: 1,
      maxSourcesPerProject: 5,
      maxMembers: 2,
    });
    // 'pro' wasn't in the override, so it keeps the built-in default.
    expect(cfg.planLimits.pro).toEqual({
      maxProjects: 20,
      maxSourcesPerProject: 200,
      maxMembers: 20,
    });
  });

  it('treats a null field in PLAN_LIMITS_JSON as unlimited', () => {
    const cfg = loadConfig({
      ...valid,
      PLAN_LIMITS_JSON: JSON.stringify({
        custom: { maxProjects: null, maxSourcesPerProject: 10, maxMembers: 5 },
      }),
    });
    expect(cfg.planLimits.custom).toEqual({
      maxProjects: null,
      maxSourcesPerProject: 10,
      maxMembers: 5,
    });
  });

  it('throws on invalid PLAN_LIMITS_JSON (not valid JSON)', () => {
    expect(() =>
      loadConfig({ ...valid, PLAN_LIMITS_JSON: '{not json' }),
    ).toThrow(/PLAN_LIMITS_JSON/);
  });

  it('throws on PLAN_LIMITS_JSON with the wrong shape', () => {
    expect(() =>
      loadConfig({
        ...valid,
        PLAN_LIMITS_JSON: JSON.stringify({ starter: { maxProjects: 'two' } }),
      }),
    ).toThrow(/PLAN_LIMITS_JSON/);
  });
});
