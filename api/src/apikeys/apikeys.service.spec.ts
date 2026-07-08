import { generateKey, hashKey } from './apikeys.service';

describe('api key generation', () => {
  it('generates bsk_-prefixed keys with 12-char prefix and sha256 hash', () => {
    const { key, prefix, hash } = generateKey();
    expect(key).toMatch(/^bsk_[A-Za-z0-9_-]{43}$/);
    expect(prefix).toBe(key.slice(0, 12));
    expect(hash).toBe(hashKey(key));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique keys', () => {
    expect(generateKey().key).not.toBe(generateKey().key);
  });
});
