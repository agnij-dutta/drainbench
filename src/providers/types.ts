// The provider contract. A provider turns the conversation so far into the
// model's next message. It must not execute tools; the harness does that.
import type { ToolSpec } from "../tools.js";
import type { DefenseId, Message, Scenario, ToolCall } from "../types.js";

export interface CompletionRequest {
  messages: Message[];
  tools: ToolSpec[];
  /** available to the mock provider only; real providers never see it. */
  scenario: Scenario;
  defense: DefenseId;
  temperature?: number;
  maxTokens?: number;
}

export interface CompletionResponse {
  content: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * One model behind one API. Implementations must be stateless across calls:
 * the full conversation is passed every time, and episodes run concurrently.
 * Throw (ideally a ProviderError) on failure; the harness records the error
 * on the transcript and excludes the episode from rates.
 */
export interface Provider {
  /** fully qualified model id, e.g. `groq:openai/gpt-oss-120b` */
  readonly id: string;
  /** True for scripted mocks. Any run containing one is labeled MOCK in every output. */
  readonly synthetic: boolean;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

/** An HTTP or protocol failure. `retryable` drives the backoff in postJson(). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
