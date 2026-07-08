export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Port for the answer model. The concrete provider calls an external, small
 * ("mini/flash/haiku"-class) chat-completions API; tests use a deterministic
 * fake. Quality/anti-hallucination comes from the surrounding pipeline
 * (grounding, retrieval, confidence gating), not from model size.
 */
export interface LlmProvider {
  complete(
    messages: LlmMessage[],
    opts?: { temperature?: number; maxTokens?: number },
  ): Promise<string>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
