import type { MessageRow } from './conversations.service';

/**
 * Human-readable label for a message role in the rendered transcript.
 * Falls back to the raw role (title-cased) for any future/unknown role so
 * rendering never throws on unexpected data.
 */
function roleLabel(role: string): string {
  switch (role) {
    case 'visitor':
      return 'You';
    case 'bot':
      return 'Assistant';
    case 'agent':
      return 'Agent';
    case 'system':
      return 'System';
    default:
      return role.charAt(0).toUpperCase() + role.slice(1);
  }
}

/** Minimal HTML entity escaping so message content can't inject markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderedTranscript {
  subject: string;
  text: string;
  html: string;
}

/**
 * Renders a conversation transcript into a plain-text body and a minimal,
 * self-contained HTML body suitable for emailing to a visitor. Pure and
 * deterministic (no I/O), so it's unit-testable in isolation. All message
 * content is HTML-escaped in the HTML rendering to prevent markup injection
 * from visitor- or source-derived text.
 */
export function renderTranscript(
  messages: MessageRow[],
  startedAt: string,
): RenderedTranscript {
  const subject = 'Your conversation transcript';

  const textLines = [subject, `Started: ${startedAt}`, ''];
  for (const m of messages) {
    textLines.push(`${roleLabel(m.role)}: ${m.content}`);
  }
  const text = textLines.join('\n');

  const rows =
    messages.length > 0
      ? messages
          .map(
            (m) =>
              `<p style="margin:0 0 12px"><strong>${escapeHtml(
                roleLabel(m.role),
              )}:</strong> ${escapeHtml(m.content)}</p>`,
          )
          .join('')
      : '<p style="margin:0 0 12px"><em>No messages.</em></p>';

  const html =
    `<div style="font-family:sans-serif;max-width:640px">` +
    `<h1 style="font-size:18px">${escapeHtml(subject)}</h1>` +
    `<p style="color:#666;font-size:13px">Started: ${escapeHtml(startedAt)}</p>` +
    rows +
    `</div>`;

  return { subject, text, html };
}
