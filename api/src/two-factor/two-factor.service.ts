import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../common/encryption.service';
import { DB } from '../db/db.module';
import type { Db } from '../db/db.module';
import { userTotp } from '../db/schema';
import {
  buildOtpauthUri,
  generateTotpSecret,
  base32Encode,
  verifyTotp,
} from './totp.util';

const TOTP_ISSUER = 'Bonsai';

export interface EnrollResult {
  otpauthUri: string;
  base32Secret: string;
}

export interface StatusResult {
  enabled: boolean;
}

/**
 * App-level TOTP second factor (#49). This is deliberately separate from
 * the primary OIDC login: a user always authenticates via the OIDC provider
 * first (see AuthGuard); this service lets them additionally enroll a
 * standard RFC 6238 TOTP factor that the API can require/check for
 * sensitive actions. One row per user in `user_totp` (control-plane); the
 * secret is always stored AES-256-GCM-encrypted (see EncryptionService),
 * never in the clear.
 */
@Injectable()
export class TwoFactorService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Starts (or restarts) enrollment: generates a fresh secret, stores it
   * encrypted with `enabled = false`, and returns the otpauth:// URI + raw
   * base32 secret so the caller can add it to any standard authenticator
   * app. Calling this again before `verify` simply replaces the pending
   * secret (no partial state to clean up).
   */
  async enroll(userId: string, accountEmail: string): Promise<EnrollResult> {
    const secret = generateTotpSecret();
    const secretEncrypted = this.encryption.encrypt(secret.toString('base64'));

    await this.db
      .insert(userTotp)
      .values({ userId, secretEncrypted, enabled: false })
      .onConflictDoUpdate({
        target: userTotp.userId,
        set: { secretEncrypted, enabled: false },
      });

    return {
      otpauthUri: buildOtpauthUri({
        secret,
        accountName: accountEmail,
        issuer: TOTP_ISSUER,
      }),
      base32Secret: base32Encode(secret),
    };
  }

  /** Verifies `code` against the stored (possibly not-yet-enabled) secret; on success, marks the factor enabled. */
  async verify(userId: string, code: string): Promise<StatusResult> {
    const secret = await this.loadSecret(userId);
    if (!verifyTotp(secret, code)) {
      throw new BadRequestException('Invalid or expired TOTP code');
    }
    await this.db
      .update(userTotp)
      .set({ enabled: true })
      .where(eq(userTotp.userId, userId));
    return { enabled: true };
  }

  /** Verifies `code`, then disables and clears the stored secret entirely (re-enrollment requires a fresh /enroll). */
  async disable(userId: string, code: string): Promise<StatusResult> {
    const secret = await this.loadSecret(userId);
    if (!verifyTotp(secret, code)) {
      throw new BadRequestException('Invalid or expired TOTP code');
    }
    await this.db.delete(userTotp).where(eq(userTotp.userId, userId));
    return { enabled: false };
  }

  async status(userId: string): Promise<StatusResult> {
    const [row] = await this.db
      .select({ enabled: userTotp.enabled })
      .from(userTotp)
      .where(eq(userTotp.userId, userId));
    return { enabled: row?.enabled ?? false };
  }

  private async loadSecret(userId: string): Promise<Buffer> {
    const [row] = await this.db
      .select({ secretEncrypted: userTotp.secretEncrypted })
      .from(userTotp)
      .where(eq(userTotp.userId, userId));
    if (!row) {
      throw new BadRequestException('No TOTP enrollment in progress');
    }
    return Buffer.from(this.encryption.decrypt(row.secretEncrypted), 'base64');
  }
}
