import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { createRemoteJWKSet } from 'jose';
import { APP_CONFIG, AppConfig } from '../config/config';
import { AuthGuard } from './auth.guard';
import { JWT_KEY_GETTER, OidcVerifier } from './oidc.verifier';
import { UsersService } from './users.service';

@Module({
  providers: [
    {
      provide: JWT_KEY_GETTER,
      useFactory: (cfg: AppConfig) =>
        createRemoteJWKSet(new URL(cfg.oidcJwksUrl)),
      inject: [APP_CONFIG],
    },
    OidcVerifier,
    UsersService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [OidcVerifier, UsersService],
})
export class AuthModule {}
