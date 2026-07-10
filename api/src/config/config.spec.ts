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
});
