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

export interface Provider {
  /** fully qualified model id, e.g. `groq:llama-3.3-70b-versatile` */
  readonly id: string;
  readonly synthetic: boolean;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}
