import { LlmMessage, LlmProvider } from './llm-provider';

/**
 * Calls an external, OpenAI-compatible chat-completions API
 * (POST { model, messages } -> { choices: [{ message: { content } }] }).
 * Endpoint/key/model are configuration so any EU-hosted or DPA-covered
 * lightweight model can be used without code changes.
 */
export class HttpLlmProvider implements LlmProvider {
  constructor(
    private readonly opts: { url: string; apiKey: string; model: string },
  ) {}

  async complete(
    messages: LlmMessage[],
    opts: { temperature?: number; maxTokens?: number } = {},
  ): Promise<string> {
    const res = await fetch(this.opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages,
        temperature: opts.temperature ?? 0.1,
        max_tokens: opts.maxTokens ?? 700,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LLM API error ${res.status}: ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('LLM API returned an unexpected shape');
    }
    return content;
  }
}
