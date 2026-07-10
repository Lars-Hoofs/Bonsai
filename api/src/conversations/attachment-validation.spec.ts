import {
  ALLOWED_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  validateAttachment,
} from './attachment-validation';

describe('validateAttachment', () => {
  it('accepts an allowed image type within the size cap', () => {
    expect(
      validateAttachment({ contentType: 'image/png', sizeBytes: 1234 }),
    ).toEqual({ ok: true });
  });

  it('accepts every allow-listed type', () => {
    for (const type of ALLOWED_ATTACHMENT_TYPES) {
      expect(validateAttachment({ contentType: type, sizeBytes: 10 }).ok).toBe(
        true,
      );
    }
  });

  it('normalizes content types with a charset parameter and casing', () => {
    expect(
      validateAttachment({
        contentType: 'TEXT/Plain; charset=utf-8',
        sizeBytes: 10,
      }),
    ).toEqual({ ok: true });
  });

  it('rejects a disallowed type (e.g. svg / html / executable)', () => {
    for (const type of [
      'image/svg+xml',
      'text/html',
      'application/x-msdownload',
      'application/zip',
      '',
    ]) {
      const res = validateAttachment({ contentType: type, sizeBytes: 10 });
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/Unsupported file type/);
    }
  });

  it('rejects an empty file', () => {
    const res = validateAttachment({ contentType: 'image/png', sizeBytes: 0 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/empty/);
  });

  it('rejects a negative or non-finite size', () => {
    expect(
      validateAttachment({ contentType: 'image/png', sizeBytes: -1 }).ok,
    ).toBe(false);
    expect(
      validateAttachment({ contentType: 'image/png', sizeBytes: NaN }).ok,
    ).toBe(false);
  });

  it('rejects a file over the size cap', () => {
    const res = validateAttachment({
      contentType: 'image/png',
      sizeBytes: MAX_ATTACHMENT_BYTES + 1,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/too large/);
  });

  it('accepts a file exactly at the size cap', () => {
    expect(
      validateAttachment({
        contentType: 'image/png',
        sizeBytes: MAX_ATTACHMENT_BYTES,
      }).ok,
    ).toBe(true);
  });
});
