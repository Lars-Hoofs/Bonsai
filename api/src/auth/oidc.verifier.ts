import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';

export const JWT_KEY_GETTER = Symbol('JWT_KEY_GETTER');

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
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.email !== 'string'
      ) {
        throw new Error('missing claims');
      }
      return {
        sub: payload.sub,
        email: payload.email,
        name: typeof payload.name === 'string' ? payload.name : undefined,
      };
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }
}
