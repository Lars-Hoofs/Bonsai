import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour
const ISSUER = 'bonsai-widget-preview';

export interface PreviewTokenClaims {
  schemaName: string;
  projectId: string;
}

/**
 * Issues and verifies short-lived, opaque, signed (HS256) tokens for the
 * "shareable widget preview" link (#3 in the theme roadmap). The token is
 * stateless — no DB row — so verification works from any instance and there
 * is nothing to garbage-collect; the JWT's own `exp` claim is the only
 * expiry mechanism. It carries just enough to resolve *which* draft theme to
 * serve (`schemaName` + `projectId`); it does not grant edit access.
 */
@Injectable()
export class PreviewTokenService {
  private readonly secret: Uint8Array;

  /**
   * NOT a constructor param — Nest's DI would otherwise try to resolve an
   * injectable for a second constructor argument. Kept as a protected,
   * overridable field so unit tests can subclass with a short TTL to
   * exercise expiry without waiting a real hour; app code always gets the
   * 1-hour default.
   */
  protected readonly ttlSeconds: number = DEFAULT_TTL_SECONDS;

  constructor(
    @Inject(APP_CONFIG)
    cfg: Pick<AppConfig, 'widgetPreviewTokenSecret'>,
  ) {
    this.secret = new TextEncoder().encode(cfg.widgetPreviewTokenSecret);
  }

  async issue(schemaName: string, projectId: string): Promise<string> {
    return new SignJWT({ schemaName, projectId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + this.ttlSeconds)
      .sign(this.secret);
  }

  async verify(token: string): Promise<PreviewTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: ISSUER,
        algorithms: ['HS256'],
      });
      const { schemaName, projectId } = payload;
      if (typeof schemaName !== 'string' || typeof projectId !== 'string') {
        throw new Error('missing claims');
      }
      return { schemaName, projectId };
    } catch {
      throw new UnauthorizedException('Invalid or expired preview token');
    }
  }
}
