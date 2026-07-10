import {
  base32Decode,
  base32Encode,
  generateTotp,
  generateTotpSecret,
  verifyTotp,
} from './totp.util';

describe('totp.util', () => {
  describe('base32Encode / base32Decode', () => {
    it('round-trips arbitrary bytes', () => {
      const original = Buffer.from('hello totp secret bytes!!', 'utf8');
      const encoded = base32Encode(original);
      expect(base32Decode(encoded).equals(original)).toBe(true);
    });

    it('produces an unpadded, uppercase RFC 4648 base32 string', () => {
      // "12345678901234567890" is the RFC 6238 test-vector SHA1 secret.
      const secret = Buffer.from('12345678901234567890', 'ascii');
      expect(base32Encode(secret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    });
  });

  describe('generateTotp / RFC 6238 test vectors (SHA1)', () => {
    // https://datatracker.ietf.org/doc/html/rfc6238#appendix-B
    // Secret is the ASCII string "12345678901234567890", step=30s, T0=0.
    const secret = Buffer.from('12345678901234567890', 'ascii');

    it('matches the RFC vector at T=59s (8-digit truncation)', () => {
      const code = generateTotp(secret, {
        timestampMs: 59_000,
        digits: 8,
        stepSeconds: 30,
      });
      expect(code).toBe('94287082');
    });

    it('matches the RFC vector at T=1111111109s (8-digit truncation)', () => {
      const code = generateTotp(secret, {
        timestampMs: 1_111_111_109_000,
        digits: 8,
        stepSeconds: 30,
      });
      expect(code).toBe('07081804');
    });

    it('matches the RFC vector at T=1234567890s (8-digit truncation)', () => {
      const code = generateTotp(secret, {
        timestampMs: 1_234_567_890_000,
        digits: 8,
        stepSeconds: 30,
      });
      expect(code).toBe('89005924');
    });

    it('defaults to 6 digits', () => {
      const code = generateTotp(secret, { timestampMs: 59_000 });
      expect(code).toBe('287082');
    });
  });

  describe('verifyTotp', () => {
    it('accepts the current-window code', () => {
      const secret = generateTotpSecret();
      const now = Date.now();
      const code = generateTotp(secret, { timestampMs: now });
      expect(verifyTotp(secret, code, { timestampMs: now })).toBe(true);
    });

    it('accepts a code from the previous step (clock-skew tolerance)', () => {
      const secret = generateTotpSecret();
      const now = Date.now();
      const prevStepCode = generateTotp(secret, {
        timestampMs: now - 30_000,
      });
      expect(verifyTotp(secret, prevStepCode, { timestampMs: now })).toBe(true);
    });

    it('accepts a code from the next step (clock-skew tolerance)', () => {
      const secret = generateTotpSecret();
      const now = Date.now();
      const nextStepCode = generateTotp(secret, {
        timestampMs: now + 30_000,
      });
      expect(verifyTotp(secret, nextStepCode, { timestampMs: now })).toBe(true);
    });

    it('rejects a code two steps away', () => {
      const secret = generateTotpSecret();
      const now = Date.now();
      const farCode = generateTotp(secret, { timestampMs: now + 60_000 });
      expect(verifyTotp(secret, farCode, { timestampMs: now })).toBe(false);
    });

    it('rejects a garbage code', () => {
      const secret = generateTotpSecret();
      expect(verifyTotp(secret, '000000', { timestampMs: Date.now() })).toBe(
        false,
      );
    });

    it('rejects malformed input without throwing', () => {
      const secret = generateTotpSecret();
      expect(verifyTotp(secret, 'not-a-code', {})).toBe(false);
      expect(verifyTotp(secret, '', {})).toBe(false);
    });
  });

  describe('generateTotpSecret', () => {
    it('generates a 20-byte (160-bit) secret by default', () => {
      const secret = generateTotpSecret();
      expect(secret.length).toBe(20);
    });

    it('generates different secrets on each call', () => {
      expect(generateTotpSecret().equals(generateTotpSecret())).toBe(false);
    });
  });
});
