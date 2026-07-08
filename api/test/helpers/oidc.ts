import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  JWTVerifyGetKey,
  SignJWT,
} from 'jose';

export interface TestIdp {
  keyGetter: JWTVerifyGetKey;
  sign(
    claims: { sub: string; email: string; name?: string },
    opts?: { issuer?: string; audience?: string; expired?: boolean },
  ): Promise<string>;
}

export const TEST_ISSUER = 'https://id.example.eu';
export const TEST_AUDIENCE = 'bonsai-api';

export async function makeTestIdp(): Promise<TestIdp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';
  const keyGetter = createLocalJWKSet({ keys: [jwk] });
  return {
    keyGetter,
    async sign(claims, opts = {}) {
      return new SignJWT({ email: claims.email, name: claims.name })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setSubject(claims.sub)
        .setIssuer(opts.issuer ?? TEST_ISSUER)
        .setAudience(opts.audience ?? TEST_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(opts.expired ? '-1h' : '1h')
        .sign(privateKey);
    },
  };
}
