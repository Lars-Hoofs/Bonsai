import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MembershipGuard } from './membership.guard';
import { IS_PUBLIC } from './public.decorator';
import { REQUIRED_ROLE } from './roles.decorator';

function ctx(
  params: Record<string, string>,
  requiredRole?: string,
  options?: { noUser?: boolean; isPublic?: boolean },
): ExecutionContext {
  const req: Record<string, unknown> = options?.noUser
    ? { params }
    : { params, user: { id: 'u1' } };
  const handler = (): void => undefined;
  Reflect.defineMetadata(REQUIRED_ROLE, requiredRole, handler);
  if (options?.isPublic) {
    Reflect.defineMetadata(IS_PUBLIC, true, handler);
  }
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('MembershipGuard', () => {
  const tenant = { id: 't1', schemaName: 't_' + 'a'.repeat(32) };
  const svc = { find: jest.fn() };
  const guard = new MembershipGuard(svc as never, new Reflector());

  it('allows a member with sufficient role and attaches tenant', async () => {
    svc.find.mockResolvedValue({ role: 'admin', tenant });
    const c = ctx({ tenantId: 't1' }, 'editor');
    await expect(guard.canActivate(c)).resolves.toBe(true);
    const req = c
      .switchToHttp()
      .getRequest<{ tenant: unknown; membership: unknown }>();
    expect(req.tenant).toEqual(tenant);
    expect(req.membership).toEqual({ role: 'admin' });
  });

  it('denies insufficient role', async () => {
    svc.find.mockResolvedValue({ role: 'viewer', tenant });
    await expect(
      guard.canActivate(ctx({ tenantId: 't1' }, 'admin')),
    ).rejects.toThrow(ForbiddenException);
  });

  it('denies non-members', async () => {
    svc.find.mockResolvedValue(null);
    await expect(
      guard.canActivate(ctx({ tenantId: 't1' }, 'viewer')),
    ).rejects.toThrow(ForbiddenException);
  });

  it('passes through routes without :tenantId', async () => {
    await expect(guard.canActivate(ctx({}, undefined))).resolves.toBe(true);
  });

  it('passes through a @Public() route with :tenantId and no req.user', async () => {
    const callsBefore = svc.find.mock.calls.length;
    const c = ctx({ tenantId: 't1' }, undefined, {
      noUser: true,
      isPublic: true,
    });
    await expect(guard.canActivate(c)).resolves.toBe(true);
    expect(svc.find.mock.calls.length).toBe(callsBefore);
  });

  it('fails closed with UnauthorizedException when req.user is missing on a non-public route with :tenantId', async () => {
    const c = ctx({ tenantId: 't1' }, 'viewer', { noUser: true });
    await expect(guard.canActivate(c)).rejects.toThrow(UnauthorizedException);
  });

  it('fails closed when the membership lookup throws', async () => {
    svc.find.mockRejectedValue(new Error('db unavailable'));
    await expect(
      guard.canActivate(ctx({ tenantId: 't1' }, 'viewer')),
    ).rejects.toBeDefined();
  });
});
