import { BadRequestException } from '@nestjs/common';
import { validateSourceConfig } from './source-config-validation';

describe('validateSourceConfig', () => {
  describe('manual', () => {
    it('accepts a valid manual config', () => {
      expect(() =>
        validateSourceConfig('manual', {
          title: 'My Doc',
          body: 'Some body text',
          language: 'nl',
        }),
      ).not.toThrow();
    });

    it('accepts a valid manual config without optional language', () => {
      expect(() =>
        validateSourceConfig('manual', { title: 'Title', body: 'Body' }),
      ).not.toThrow();
    });

    it('rejects missing title', () => {
      expect(() => validateSourceConfig('manual', { body: 'Body' })).toThrow(
        BadRequestException,
      );
    });

    it('rejects missing body', () => {
      expect(() => validateSourceConfig('manual', { title: 'Title' })).toThrow(
        BadRequestException,
      );
    });

    it('rejects an oversized title', () => {
      expect(() =>
        validateSourceConfig('manual', {
          title: 'x'.repeat(201),
          body: 'Body',
        }),
      ).toThrow('config.title must be at most 200 characters');
    });

    it('rejects an oversized body', () => {
      expect(() =>
        validateSourceConfig('manual', {
          title: 'Title',
          body: 'x'.repeat(200_001),
        }),
      ).toThrow('config.body must be at most 200000 characters');
    });

    it('accepts body at exactly the max length', () => {
      expect(() =>
        validateSourceConfig('manual', {
          title: 'Title',
          body: 'x'.repeat(200_000),
        }),
      ).not.toThrow();
    });

    it('rejects a language shorter than 2 chars', () => {
      expect(() =>
        validateSourceConfig('manual', {
          title: 'Title',
          body: 'Body',
          language: 'n',
        }),
      ).toThrow('config.language must be at least 2 characters');
    });

    it('rejects a language longer than 8 chars', () => {
      expect(() =>
        validateSourceConfig('manual', {
          title: 'Title',
          body: 'Body',
          language: 'x'.repeat(9),
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects a non-string title', () => {
      expect(() =>
        validateSourceConfig('manual', { title: 123, body: 'Body' }),
      ).toThrow('config.title must be a string');
    });
  });

  describe('website', () => {
    it('accepts a valid https url', () => {
      expect(() =>
        validateSourceConfig('website', { url: 'https://example.com/page' }),
      ).not.toThrow();
    });

    it('accepts a valid http url', () => {
      expect(() =>
        validateSourceConfig('website', { url: 'http://example.com' }),
      ).not.toThrow();
    });

    it('rejects a missing url', () => {
      expect(() => validateSourceConfig('website', {})).toThrow(
        BadRequestException,
      );
    });

    it('rejects a structurally invalid url', () => {
      expect(() =>
        validateSourceConfig('website', { url: 'not a url' }),
      ).toThrow('config.url must be a valid URL');
    });

    it('rejects a non-http(s) scheme', () => {
      expect(() =>
        validateSourceConfig('website', { url: 'ftp://example.com/file' }),
      ).toThrow('config.url must use the http or https scheme');
    });

    it('rejects file: scheme', () => {
      expect(() =>
        validateSourceConfig('website', { url: 'file:///etc/passwd' }),
      ).toThrow('config.url must use the http or https scheme');
    });

    it('rejects an oversized url', () => {
      const longUrl = `https://example.com/${'a'.repeat(2100)}`;
      expect(() => validateSourceConfig('website', { url: longUrl })).toThrow(
        'config.url must be at most 2048 characters',
      );
    });

    it('accepts crawl mode with valid maxPages/maxDepth', () => {
      expect(() =>
        validateSourceConfig('website', {
          url: 'https://example.com',
          crawl: true,
          maxPages: 10,
          maxDepth: 3,
        }),
      ).not.toThrow();
    });

    it('accepts crawl defaulting to false/absent', () => {
      expect(() =>
        validateSourceConfig('website', { url: 'https://example.com' }),
      ).not.toThrow();
    });

    it('rejects a non-boolean crawl', () => {
      expect(() =>
        validateSourceConfig('website', {
          url: 'https://example.com',
          crawl: 'yes',
        }),
      ).toThrow('config.crawl must be a boolean');
    });

    it('rejects a maxPages above the cap', () => {
      expect(() =>
        validateSourceConfig('website', {
          url: 'https://example.com',
          maxPages: 201,
        }),
      ).toThrow('config.maxPages must be at most 200');
    });

    it('accepts maxPages exactly at the cap', () => {
      expect(() =>
        validateSourceConfig('website', {
          url: 'https://example.com',
          maxPages: 200,
        }),
      ).not.toThrow();
    });

    it('rejects a maxDepth above the cap', () => {
      expect(() =>
        validateSourceConfig('website', {
          url: 'https://example.com',
          maxDepth: 6,
        }),
      ).toThrow('config.maxDepth must be at most 5');
    });

    it('accepts maxDepth exactly at the cap', () => {
      expect(() =>
        validateSourceConfig('website', {
          url: 'https://example.com',
          maxDepth: 5,
        }),
      ).not.toThrow();
    });

    it('rejects a non-integer maxPages', () => {
      expect(() =>
        validateSourceConfig('website', {
          url: 'https://example.com',
          maxPages: 1.5,
        }),
      ).toThrow('config.maxPages must be an integer');
    });

    it('rejects maxPages below 1', () => {
      expect(() =>
        validateSourceConfig('website', {
          url: 'https://example.com',
          maxPages: 0,
        }),
      ).toThrow('config.maxPages must be at least 1');
    });
  });

  describe('csv', () => {
    it('accepts a valid csv config', () => {
      expect(() =>
        validateSourceConfig('csv', {
          csv: 'title,body\nA,B',
          titleColumn: 'title',
          bodyColumns: ['body'],
        }),
      ).not.toThrow();
    });

    it('accepts a csv config without optional column mappings', () => {
      expect(() =>
        validateSourceConfig('csv', { csv: 'title,body\nA,B' }),
      ).not.toThrow();
    });

    it('rejects missing csv', () => {
      expect(() => validateSourceConfig('csv', {})).toThrow(
        BadRequestException,
      );
    });

    it('rejects an oversized csv blob', () => {
      expect(() =>
        validateSourceConfig('csv', { csv: 'x'.repeat(1_000_001) }),
      ).toThrow('config.csv must be at most 1000000 characters');
    });

    it('accepts csv at exactly the max length', () => {
      expect(() =>
        validateSourceConfig('csv', { csv: 'x'.repeat(1_000_000) }),
      ).not.toThrow();
    });

    it('rejects an oversized bodyColumns array', () => {
      expect(() =>
        validateSourceConfig('csv', {
          csv: 'a,b',
          bodyColumns: Array.from({ length: 51 }, (_, i) => `col${i}`),
        }),
      ).toThrow('config.bodyColumns must have at most 50 entries');
    });

    it('accepts bodyColumns array at exactly the max size', () => {
      expect(() =>
        validateSourceConfig('csv', {
          csv: 'a,b',
          bodyColumns: Array.from({ length: 50 }, (_, i) => `col${i}`),
        }),
      ).not.toThrow();
    });

    it('rejects a non-array bodyColumns', () => {
      expect(() =>
        validateSourceConfig('csv', { csv: 'a,b', bodyColumns: 'body' }),
      ).toThrow('config.bodyColumns must be an array');
    });

    it('rejects a bodyColumns array with non-string entries', () => {
      expect(() =>
        validateSourceConfig('csv', { csv: 'a,b', bodyColumns: [1, 2] }),
      ).toThrow('config.bodyColumns must be an array of strings');
    });

    it('rejects a non-string titleColumn', () => {
      expect(() =>
        validateSourceConfig('csv', { csv: 'a,b', titleColumn: 5 }),
      ).toThrow('config.titleColumn must be a string');
    });
  });

  describe('unknown/other types', () => {
    it('does not throw for an unrecognized type (e.g. upload)', () => {
      expect(() =>
        validateSourceConfig('upload', { anything: 'goes', here: 123 }),
      ).not.toThrow();
    });

    it('does not throw for a completely unknown type', () => {
      expect(() => validateSourceConfig('some-future-type', {})).not.toThrow();
    });
  });
});
