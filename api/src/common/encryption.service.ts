import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { APP_CONFIG } from '../config/config';
import type { AppConfig } from '../config/config';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * AES-256-GCM encryption for at-rest secrets (tenant-owned API connector
 * credentials — see ConnectorsService). Not used for anything else.
 *
 * Blob format: `base64(iv).base64(authTag).base64(ciphertext)`. A fresh
 * random 12-byte IV is generated per `encrypt()` call, so encrypting the
 * same plaintext twice yields different ciphertext.
 *
 * Requires `ENCRYPTION_KEY` to be configured (see config.ts); both
 * `encrypt` and `decrypt` throw otherwise, so a misconfigured deployment
 * fails loudly rather than silently storing/returning plaintext.
 */
@Injectable()
export class EncryptionService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: Pick<AppConfig, 'encryptionKey'>,
  ) {}

  private requireKey(): Buffer {
    if (!this.cfg.encryptionKey) {
      throw new Error('ENCRYPTION_KEY not configured');
    }
    return this.cfg.encryptionKey;
  }

  encrypt(plaintext: string): string {
    const key = this.requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return [
      iv.toString('base64'),
      authTag.toString('base64'),
      ciphertext.toString('base64'),
    ].join('.');
  }

  decrypt(blob: string): string {
    const key = this.requireKey();
    const parts = blob.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted blob format');
    }
    const [ivPart, authTagPart, ciphertextPart] = parts;
    const iv = Buffer.from(ivPart, 'base64');
    const authTag = Buffer.from(authTagPart, 'base64');
    const ciphertext = Buffer.from(ciphertextPart, 'base64');
    if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
      throw new Error('Invalid encrypted blob format');
    }
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }
}
