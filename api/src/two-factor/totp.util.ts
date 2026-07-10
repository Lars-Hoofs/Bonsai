import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Self-hosted RFC 6238 TOTP (Time-based One-Time Password), built on
 * node:crypto's HMAC-SHA1 — no external/paid 2FA service, and no extra
 * runtime dependency. Compatible with any standard authenticator app
 * (Google Authenticator, Authy, 1Password, etc.), which all implement the
 * same RFC 4226 (HOTP) + RFC 6238 (TOTP) algorithms with these same
 * defaults (SHA1, 30s step, 6 digits).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_STEP_SECONDS = 30;
const DEFAULT_DIGITS = 6;
// How many steps before/after the current one still verify, to tolerate
// clock drift between the server and the user's device. +/-1 step (i.e. up
// to ~30-60s of drift) is the conventional default used by most TOTP
// implementations.
const DEFAULT_WINDOW_STEPS = 1;

/** RFC 4648 base32 encode (unpadded, uppercase) — used for the secret shown/typed into an authenticator app. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/** RFC 4648 base32 decode. Accepts upper/lowercase and ignores `=` padding/whitespace. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Generates a fresh random TOTP secret (raw bytes, 160 bits by default — the RFC 6238-recommended size for SHA1). */
export function generateTotpSecret(byteLength = 20): Buffer {
  return randomBytes(byteLength);
}

export interface TotpOptions {
  timestampMs?: number;
  stepSeconds?: number;
  digits?: number;
}

/** RFC 4226 HOTP: HMAC-SHA1 over the 8-byte big-endian counter, dynamically truncated to `digits` decimal digits. */
function hotp(secret: Buffer, counter: bigint, digits: number): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const truncated =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const code = (truncated % 10 ** digits).toString().padStart(digits, '0');
  return code;
}

/** Generates the TOTP code for the time step containing `timestampMs` (defaults to now). */
export function generateTotp(secret: Buffer, opts: TotpOptions = {}): string {
  const stepSeconds = opts.stepSeconds ?? DEFAULT_STEP_SECONDS;
  const digits = opts.digits ?? DEFAULT_DIGITS;
  const timestampMs = opts.timestampMs ?? Date.now();
  const counter = BigInt(Math.floor(timestampMs / 1000 / stepSeconds));
  return hotp(secret, counter, digits);
}

/**
 * Verifies a user-supplied code against the secret, tolerating clock skew
 * within +/- `windowSteps` time steps of the current one.
 *
 * Constant-time-compares each candidate code so this doesn't leak timing
 * information about which step (if any) matched.
 */
export function verifyTotp(
  secret: Buffer,
  code: string,
  opts: TotpOptions & { windowSteps?: number } = {},
): boolean {
  const digits = opts.digits ?? DEFAULT_DIGITS;
  if (!/^\d+$/.test(code) || code.length !== digits) return false;
  const stepSeconds = opts.stepSeconds ?? DEFAULT_STEP_SECONDS;
  const timestampMs = opts.timestampMs ?? Date.now();
  const windowSteps = opts.windowSteps ?? DEFAULT_WINDOW_STEPS;
  const currentCounter = BigInt(Math.floor(timestampMs / 1000 / stepSeconds));
  const codeBuf = Buffer.from(code, 'utf8');
  for (let delta = -windowSteps; delta <= windowSteps; delta++) {
    const counter = currentCounter + BigInt(delta);
    if (counter < 0n) continue;
    const candidate = Buffer.from(hotp(secret, counter, digits), 'utf8');
    if (
      candidate.length === codeBuf.length &&
      timingSafeEqual(candidate, codeBuf)
    ) {
      return true;
    }
  }
  return false;
}

/** Builds the `otpauth://` URI an authenticator app scans/imports (no QR image server needed — apps can accept the raw URI/secret). */
export function buildOtpauthUri(opts: {
  secret: Buffer;
  accountName: string;
  issuer: string;
  digits?: number;
  stepSeconds?: number;
}): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.accountName}`);
  const params = new URLSearchParams({
    secret: base32Encode(opts.secret),
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(opts.digits ?? DEFAULT_DIGITS),
    period: String(opts.stepSeconds ?? DEFAULT_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
