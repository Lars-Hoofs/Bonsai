import { renderBody } from './canned-responses.service';

describe('renderBody', () => {
  it('substitutes a known placeholder', () => {
    expect(renderBody('Hi {{name}}!', { name: 'Ada' })).toBe('Hi Ada!');
  });

  it('substitutes multiple and repeated placeholders', () => {
    expect(
      renderBody('{{greeting}} {{name}}, bye {{name}}', {
        greeting: 'Hello',
        name: 'Sam',
      }),
    ).toBe('Hello Sam, bye Sam');
  });

  it('leaves unknown placeholders as the literal token', () => {
    expect(renderBody('Order {{order_id}} for {{name}}', { name: 'Sam' })).toBe(
      'Order {{order_id}} for Sam',
    );
  });

  it('is tolerant of whitespace inside braces', () => {
    expect(renderBody('Hi {{  name  }}', { name: 'Sam' })).toBe('Hi Sam');
  });

  it('renders null/undefined values as empty strings', () => {
    expect(renderBody('[{{a}}][{{b}}]', { a: null, b: undefined })).toBe(
      '[][]',
    );
  });

  it('coerces non-string values to strings', () => {
    expect(renderBody('#{{n}}', { n: 42 })).toBe('#42');
  });

  it('returns the body unchanged when there are no placeholders', () => {
    expect(renderBody('plain text', { name: 'x' })).toBe('plain text');
  });

  it('ignores keys in values that have no matching token', () => {
    expect(renderBody('Hi {{name}}', { name: 'Sam', extra: 'unused' })).toBe(
      'Hi Sam',
    );
  });
});
