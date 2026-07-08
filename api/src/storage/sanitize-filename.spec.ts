import { sanitizeFilename } from './sanitize-filename';

describe('sanitizeFilename', () => {
  it('preserves a normal filename', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
  });

  it('strips path separators and traversal segments', () => {
    expect(sanitizeFilename('../../etc/passwd')).not.toMatch(/[/\\]/);
    expect(sanitizeFilename('../../etc/passwd')).not.toContain('..');
    expect(sanitizeFilename('..\\..\\windows\\system32\\evil.dll')).not.toMatch(
      /[/\\]/,
    );
  });

  it('removes control characters', () => {
    const withControlChars = 'bad\x00name\x1f.txt';
    // eslint-disable-next-line no-control-regex -- asserting control chars are gone
    expect(sanitizeFilename(withControlChars)).not.toMatch(/[\x00-\x1f]/);
  });

  it('caps very long filenames to a reasonable length', () => {
    const long = `${'a'.repeat(500)}.txt`;
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('falls back to a default name when nothing safe remains', () => {
    expect(sanitizeFilename('../../../')).toBe('upload');
    expect(sanitizeFilename('')).toBe('upload');
  });

  it('replaces unsafe characters with underscores', () => {
    expect(sanitizeFilename('my file (final)!.pdf')).toBe(
      'my_file__final__.pdf',
    );
  });
});
