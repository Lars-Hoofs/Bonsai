import 'reflect-metadata';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OidcVerifier } from './oidc.verifier';
import { AuthGuard } from './auth.guard';
import {
  makeTestIdp,
  TEST_AUDIENCE,
  TEST_ISSUER,
  TestIdp,
} from '../../test/helpers/oidc';

function ctxWithAuth(header?: string): ExecutionContext {
  const req: Record<string, unknown> = {
    headers: header ? { authorization: header } : {},
  };
  const handler = (): void => undefined;
  const klass = class TestClass {};
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => klass,
  } as unknown as ExecutionContext;
}

describe('AuthGuard', () => {
  let idp: TestIdp;
  let guard: AuthGuard;
  const upserted = { id: 'user-1', email: 'a@b.eu' };
  const usersService = {
    upsertFromClaims: jest.fn().mockResolvedValue(upserted),
  };

  beforeAll(async () => {
    idp = await makeTestIdp();
    const verifier = new OidcVerifier(idp.keyGetter, {
      oidcIssuer: TEST_ISSUER,
      oidcAudience: TEST_AUDIENCE,
    } as never);
    guard = new AuthGuard(verifier, usersService as never, new Reflector());
  });

  it('accepts a valid token and attaches req.user', async () => {
    const token = await idp.sign({ sub: 'oidc|1', email: 'a@b.eu' });
    const ctx = ctxWithAuth(`Bearer ${token}`);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx
      .switchToHttp()
      .getRequest<{ user: { id: string; oidcSubject: string } }>();
    expect(req.user).toEqual({
      id: 'user-1',
      oidcSubject: 'oidc|1',
      email: 'a@b.eu',
    });
  });

  it('rejects a missing header', async () => {
    await expect(guard.canActivate(ctxWithAuth())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a wrong-issuer token', async () => {
    const token = await idp.sign(
      { sub: 'oidc|1', email: 'a@b.eu' },
      { issuer: 'https://evil.example' },
    );
    await expect(
      guard.canActivate(ctxWithAuth(`Bearer ${token}`)),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an expired token', async () => {
    const token = await idp.sign(
      { sub: 'oidc|1', email: 'a@b.eu' },
      { expired: true },
    );
    await expect(
      guard.canActivate(ctxWithAuth(`Bearer ${token}`)),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token whose email is not verified', async () => {
    const token = await idp.sign(
      { sub: 'oidc|1', email: 'a@b.eu' },
      { emailUnverified: true },
    );
    await expect(
      guard.canActivate(ctxWithAuth(`Bearer ${token}`)),
    ).rejects.toThrow(UnauthorizedException);
  });
});
