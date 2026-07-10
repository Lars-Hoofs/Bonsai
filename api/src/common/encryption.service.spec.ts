import { EncryptionService } from './encryption.service';

function keyOf32Bytes(fill: number): Buffer {
  return Buffer.alloc(32, fill);
}

describe('EncryptionService', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const svc = new EncryptionService({ encryptionKey: keyOf32Bytes(1) });
    const plaintext = JSON.stringify({ type: 'bearer', token: 'secret-token' });
    const ciphertext = svc.encrypt(plaintext);
    expect(svc.decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces ciphertext that does not equal the plaintext', () => {
    const svc = new EncryptionService({ encryptionKey: keyOf32Bytes(2) });
    const plaintext = 'super-secret-value';
    const ciphertext = svc.encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext).not.toContain(plaintext);
  });

  it('produces different ciphertext for two encrypts of the same input (random IV)', () => {
    const svc = new EncryptionService({ encryptionKey: keyOf32Bytes(3) });
    const plaintext = 'same-input';
    const c1 = svc.encrypt(plaintext);
    const c2 = svc.encrypt(plaintext);
    expect(c1).not.toBe(c2);
    expect(svc.decrypt(c1)).toBe(plaintext);
    expect(svc.decrypt(c2)).toBe(plaintext);
  });

  it('throws when decrypting with a different key', () => {
    const svc1 = new EncryptionService({ encryptionKey: keyOf32Bytes(4) });
    const svc2 = new EncryptionService({ encryptionKey: keyOf32Bytes(5) });
    const ciphertext = svc1.encrypt('hello');
    expect(() => svc2.decrypt(ciphertext)).toThrow();
  });

  it('throws on encrypt when no ENCRYPTION_KEY is configured', () => {
    const svc = new EncryptionService({ encryptionKey: undefined });
    expect(() => svc.encrypt('x')).toThrow('ENCRYPTION_KEY not configured');
  });

  it('throws on decrypt when no ENCRYPTION_KEY is configured', () => {
    const svc = new EncryptionService({ encryptionKey: undefined });
    expect(() => svc.decrypt('a.b.c')).toThrow('ENCRYPTION_KEY not configured');
  });

  it('produces a blob of three dot-separated base64 segments (iv.authTag.ciphertext)', () => {
    const svc = new EncryptionService({ encryptionKey: keyOf32Bytes(6) });
    const blob = svc.encrypt('payload');
    const parts = blob.split('.');
    expect(parts).toHaveLength(3);
    const iv = Buffer.from(parts[0], 'base64');
    const authTag = Buffer.from(parts[1], 'base64');
    expect(iv).toHaveLength(12);
    expect(authTag).toHaveLength(16);
  });
});
