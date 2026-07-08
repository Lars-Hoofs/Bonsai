import { LlmMessage, LlmProvider } from './llm-provider';

/**
 * Deterministic, offline answer model for tests/dev. It stays "grounded": it
 * echoes a short answer that cites the first provided source ([1]), so the
 * surrounding pipeline (citation enforcement, confidence gating) can be
 * exercised without a network call.
 */
export class FakeLlmProvider implements LlmProvider {
  complete(messages: LlmMessage[]): Promise<string> {
    // Groundedness self-check calls carry the [[VERIFY]] marker; the fake
    // considers grounded answers supported.
    if (messages.some((m) => m.content.includes('[[VERIFY]]'))) {
      return Promise.resolve('{"supported": true}');
    }
    const user = [...messages].reverse().find((m) => m.role === 'user');
    const hasSources = /\[1\]/.test(user?.content ?? '');
    if (!hasSources) {
      return Promise.resolve('Ik weet het niet zeker.');
    }
    return Promise.resolve(
      'Op basis van de kennisbank is dit het antwoord op je vraag [1].',
    );
  }
}
