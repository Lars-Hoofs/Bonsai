import { renderTranscript } from './transcript';
import type { MessageRow } from './conversations.service';

function msg(role: string, content: string): MessageRow {
  return {
    id: `id-${role}-${content.slice(0, 4)}`,
    role,
    content,
    confidence: null,
    refused: false,
    createdAt: '2026-07-10T10:00:00.000Z',
  };
}

describe('renderTranscript', () => {
  it('renders a subject, plain-text body, and HTML body with role labels', () => {
    const { subject, text, html } = renderTranscript(
      [
        msg('visitor', 'Wat zijn jullie openingstijden?'),
        msg('bot', 'Wij zijn open van 9 tot 17 uur.'),
        msg('agent', 'Kan ik verder nog helpen?'),
      ],
      '2026-07-10T09:59:00.000Z',
    );

    expect(subject).toBe('Your conversation transcript');
    // Text uses human-readable role labels.
    expect(text).toContain('You: Wat zijn jullie openingstijden?');
    expect(text).toContain('Assistant: Wij zijn open van 9 tot 17 uur.');
    expect(text).toContain('Agent: Kan ik verder nog helpen?');
    expect(text).toContain('Started: 2026-07-10T09:59:00.000Z');
    // HTML mirrors the same content.
    expect(html).toContain('<strong>You:</strong>');
    expect(html).toContain('<strong>Assistant:</strong>');
  });

  it('HTML-escapes message content to prevent markup injection', () => {
    const { html, text } = renderTranscript(
      [msg('visitor', '<script>alert(1)</script> & "quotes"')],
      '2026-07-10T09:59:00.000Z',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    // Plain text is not escaped (it's not markup).
    expect(text).toContain('<script>alert(1)</script>');
  });

  it('renders a placeholder for an empty conversation', () => {
    const { html, text } = renderTranscript([], '2026-07-10T09:59:00.000Z');
    expect(html).toContain('No messages.');
    expect(text).toContain('Your conversation transcript');
  });

  it('falls back to a title-cased label for unknown roles', () => {
    const { text } = renderTranscript(
      [msg('supervisor', 'hi')],
      '2026-07-10T09:59:00.000Z',
    );
    expect(text).toContain('Supervisor: hi');
  });
});
