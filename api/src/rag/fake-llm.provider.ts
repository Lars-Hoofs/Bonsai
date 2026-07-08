import { LlmMessage, LlmProvider } from './llm-provider';

/**
 * Deterministic, offline answer model for tests/dev. It stays "grounded": it
 * echoes a short answer that cites the first provided source ([1]), so the
 * surrounding pipeline (citation enforcement, confidence gating) can be
 * exercised without a network call.
 */
export class FakeLlmProvider implements LlmProvider {
  complete(messages: LlmMessage[]): Promise<string> {
    // Groundedness self-check calls are routed via a distinct system-role
    // instruction (BONSAI_SELF_CHECK_V1), never via shared/user content, so
    // that retrieved knowledge-base text can never spoof a verify call. The
    // fake considers grounded answers supported.
    const system = messages.find((m) => m.role === 'system');
    if (system?.content.includes('BONSAI_SELF_CHECK_V1')) {
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
