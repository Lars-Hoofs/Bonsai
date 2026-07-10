import {
  entriesToCsv,
  entriesToJson,
  entriesToMarkdownZip,
  KbEntry,
  parseBundle,
  parseCsvBundle,
  parseJsonBundle,
  parseZipBundle,
} from './bundle';

const sample: KbEntry[] = [
  { title: 'Openingstijden', body: 'Ma-Vr 9-17', language: 'nl' },
  { title: 'Retour', body: 'Binnen 30 dagen,\n"gratis"' },
];

describe('bundle JSON', () => {
  it('round-trips entries', () => {
    const parsed = parseJsonBundle(entriesToJson(sample));
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.entries).toEqual(sample);
  });

  it('accepts a bare array', () => {
    const parsed = parseJsonBundle(JSON.stringify(sample));
    expect(parsed.entries).toHaveLength(2);
  });

  it('reports per-row errors and keeps valid rows', () => {
    const parsed = parseJsonBundle(
      JSON.stringify([
        { title: 'ok', body: 'b' },
        { title: '', body: 'no title' },
        { title: 'no body', body: '   ' },
        { title: 'bad lang', body: 'b', language: 'x' },
        'not-an-object',
      ]),
    );
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.errors.map((e) => e.row)).toEqual([1, 2, 3, 4]);
  });

  it('throws on invalid json', () => {
    expect(() => parseJsonBundle('{')).toThrow();
  });
});

describe('bundle CSV', () => {
  it('round-trips including quoted fields', () => {
    const parsed = parseCsvBundle(entriesToCsv(sample));
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.entries).toEqual(sample);
  });

  it('requires title and body columns', () => {
    expect(() => parseCsvBundle('foo,bar\n1,2')).toThrow();
  });

  it('reports per-row errors', () => {
    const csv = 'title,body\nGood,content\n,missing title';
    const parsed = parseCsvBundle(csv);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].row).toBe(1);
  });
});

describe('bundle Markdown zip', () => {
  it('round-trips via manifest', () => {
    const zip = entriesToMarkdownZip(sample);
    const parsed = parseZipBundle(zip);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.entries).toEqual(sample);
  });

  it('parseBundle dispatches by format', () => {
    expect(
      parseBundle('json', Buffer.from(entriesToJson(sample))).entries,
    ).toHaveLength(2);
    expect(
      parseBundle('csv', Buffer.from(entriesToCsv(sample))).entries,
    ).toHaveLength(2);
    expect(
      parseBundle('zip', entriesToMarkdownZip(sample)).entries,
    ).toHaveLength(2);
  });
});
