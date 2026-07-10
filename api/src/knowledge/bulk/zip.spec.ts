import { buildZip, parseZip } from './zip';

describe('zip (store) writer/reader', () => {
  it('round-trips entries byte-for-byte', () => {
    const entries = [
      { name: 'a.md', content: Buffer.from('hello wereld', 'utf8') },
      { name: 'dir/b.txt', content: Buffer.from('meer tekst\nmet regels') },
      { name: 'empty', content: Buffer.alloc(0) },
    ];
    const zip = buildZip(entries);
    const parsed = parseZip(zip);
    expect(parsed).toHaveLength(3);
    for (const orig of entries) {
      const found = parsed.find((p) => p.name === orig.name);
      expect(found).toBeDefined();
      expect(Buffer.compare(found!.content, orig.content)).toBe(0);
    }
  });

  it('produces a valid EOCD signature and deterministic output', () => {
    const a = buildZip([{ name: 'x', content: Buffer.from('y') }]);
    const b = buildZip([{ name: 'x', content: Buffer.from('y') }]);
    expect(Buffer.compare(a, b)).toBe(0);
    // EOCD magic present at the tail (no comment).
    expect(a.readUInt32LE(a.length - 22)).toBe(0x06054b50);
  });

  it('rejects a non-zip buffer', () => {
    expect(() => parseZip(Buffer.from('not a zip at all'))).toThrow();
  });

  it('handles utf-8 filenames', () => {
    const zip = buildZip([
      { name: 'vragén-ç.md', content: Buffer.from('ïnhoud') },
    ]);
    const [entry] = parseZip(zip);
    expect(entry.name).toBe('vragén-ç.md');
  });
});
