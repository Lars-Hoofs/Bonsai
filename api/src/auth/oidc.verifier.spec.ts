import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { CLAIM_NS, OidcVerifier } from './oidc.verifier';
import type { AppConfig } from '../config/config';

const ISSUER = 'https://id.example.eu';
const AUDIENCE = 'bonsai-api';

const cfg = {
  databaseUrl: 'unused',
  port: 0,
  nodeEnv: 'test',
  oidcIssuer: ISSUER,
  oidcAudience: AUDIENCE,
  oidcJwksUrl: 'https://id.example.eu/keys',
} satisfies AppConfig;

describe('OidcVerifier — Auth0 namespaced claims', () => {
  let keyGetter: JWTVerifyGetKey;
  let sign: (payload: Record<string, unknown>) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'k1';
    jwk.alg = 'RS256';
    keyGetter = createLocalJWKSet({ keys: [jwk] });
    sign = (payload: Record<string, unknown>): Promise<string> =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setSubject('auth0|abc123')
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
  });

  it('reads email/name/email_verified from namespaced Auth0 claims when standard ones are absent', async () => {
    const token = await sign({
      [`${CLAIM_NS}email`]: 'user@acme.eu',
      [`${CLAIM_NS}name`]: 'Ada',
      [`${CLAIM_NS}email_verified`]: true,
    });
    const verifier = new OidcVerifier(keyGetter, cfg);
    await expect(verifier.verify(token)).resolves.toEqual({
      sub: 'auth0|abc123',
      email: 'user@acme.eu',
      name: 'Ada',
    });
  });

  it('rejects when the namespaced email is unverified', async () => {
    const token = await sign({
      [`${CLAIM_NS}email`]: 'user@acme.eu',
      [`${CLAIM_NS}email_verified`]: false,
    });
    const verifier = new OidcVerifier(keyGetter, cfg);
    await expect(verifier.verify(token)).rejects.toThrow('Invalid token');
  });
});
