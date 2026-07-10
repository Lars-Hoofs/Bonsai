import { Body, Controller, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/auth.types';
import type { AuthUser } from '../auth/auth.types';
import { VerifyTotpDto } from './dto';
import {
  EnrollResult,
  StatusResult,
  TwoFactorService,
} from './two-factor.service';

/**
 * Self-service TOTP 2FA management for the authenticated user (#49).
 * Deliberately NOT tenant-scoped (no :tenantId param): this is a per-user
 * account setting, not a per-tenant resource, so it goes through AuthGuard
 * only — MembershipGuard passes routes without a :tenantId param through
 * unchanged (see MembershipGuard).
 */
@Controller('me/2fa')
export class TwoFactorController {
  constructor(private readonly twoFactor: TwoFactorService) {}

  @Post('enroll')
  enroll(@CurrentUser() user: AuthUser): Promise<EnrollResult> {
    return this.twoFactor.enroll(user.id, user.email);
  }

  @Post('verify')
  verify(
    @CurrentUser() user: AuthUser,
    @Body() dto: VerifyTotpDto,
  ): Promise<StatusResult> {
    return this.twoFactor.verify(user.id, dto.code);
  }

  @Post('disable')
  disable(
    @CurrentUser() user: AuthUser,
    @Body() dto: VerifyTotpDto,
  ): Promise<StatusResult> {
    return this.twoFactor.disable(user.id, dto.code);
  }

  @Get('status')
  status(@CurrentUser() user: AuthUser): Promise<StatusResult> {
    return this.twoFactor.status(user.id);
  }
}
