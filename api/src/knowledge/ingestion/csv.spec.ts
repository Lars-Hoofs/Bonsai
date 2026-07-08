import { csvToDocuments, parseCsv } from './csv';

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted fields with commas, newlines and escaped quotes', () => {
    const csv = 'name,note\n"Doe, John","line1\nline2"\n"a ""quote""",x';
    expect(parseCsv(csv)).toEqual([
      ['name', 'note'],
      ['Doe, John', 'line1\nline2'],
      ['a "quote"', 'x'],
    ]);
  });

  it('skips blank lines', () => {
    expect(parseCsv('a\n\nb')).toEqual([['a'], ['b']]);
  });
});

describe('csvToDocuments', () => {
  it('maps by named columns', () => {
    const csv = 'vraag,antwoord\nOpeningstijden?,Ma-vr 9-17';
    const docs = csvToDocuments(csv, {
      titleColumn: 'vraag',
      bodyColumns: ['antwoord'],
    });
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('Openingstijden?');
    expect(docs[0].body).toContain('antwoord: Ma-vr 9-17');
  });

  it('defaults to first column as title, rest as body', () => {
    const docs = csvToDocuments('a,b,c\nT,B1,B2');
    expect(docs[0].title).toBe('T');
    expect(docs[0].body).toContain('b: B1');
    expect(docs[0].body).toContain('c: B2');
  });
});
