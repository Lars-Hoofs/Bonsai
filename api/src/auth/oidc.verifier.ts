import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';

export const JWT_KEY_GETTER = Symbol('JWT_KEY_GETTER');

// Namespace for custom claims injected by the Auth0 Login Action. Auth0 (and
// most IdPs) do NOT include `email`/`email_verified` in an API *access* token
// by default; a Login Action adds them, and Auth0 requires custom claims to be
// namespaced with a non-auth0 URL you control.
export const CLAIM_NS = 'https://chat.bonsaimedia.nl/';

// Read an OIDC claim as a string, preferring the namespaced Auth0 custom claim
// and falling back to the standard claim (ID-token style / test IdP). Returns
// undefined when neither is a string. `payload[...]` is typed `unknown`, so the
// typeof narrowing keeps this free of `any`.
function readClaimString(
  payload: JWTPayload,
  name: string,
): string | undefined {
  const namespaced = payload[`${CLAIM_NS}${name}`];
  if (typeof namespaced === 'string') return namespaced;
  const standard = payload[name];
  return typeof standard === 'string' ? standard : undefined;
}

export interface VerifiedClaims {
  sub: string;
  email: string;
  name?: string;
}

@Injectable()
export class OidcVerifier {
  constructor(
    @Inject(JWT_KEY_GETTER) private readonly keyGetter: JWTVerifyGetKey,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async verify(token: string): Promise<VerifiedClaims> {
    try {
      const { payload } = await jwtVerify(token, this.keyGetter, {
        issuer: this.cfg.oidcIssuer,
        audience: this.cfg.oidcAudience,
        // Defence-in-depth: pin the signing algorithm so a JWKS that ever
        // publishes a key usable with a weaker/attacker-favourable alg cannot
        // be exploited (algorithm-confusion). Most OIDC IdPs sign with RS256.
        algorithms: ['RS256'],
      });
      // Auth0 access tokens carry these as namespaced custom claims; ID tokens
      // and the test IdP carry them as standard claims. Read either.
      const email = readClaimString(payload, 'email');
      const name = readClaimString(payload, 'name');
      const emailVerified =
        payload[`${CLAIM_NS}email_verified`] ?? payload.email_verified;

      if (typeof payload.sub !== 'string' || email === undefined) {
        throw new Error('missing claims');
      }
      // Only trust a verified email. An unverified email must never be usable
      // for identity/membership resolution (invite-by-email takeover vector).
      if (emailVerified !== true) {
        throw new Error('email not verified');
      }
      return { sub: payload.sub, email, name };
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }
}
