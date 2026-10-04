// OpenAI-compatible Chat Completions adapter. Covers OpenAI, Groq, OpenRouter,
// Together, and any self-hosted endpoint speaking the same wire format.
import type { Message, ToolCall } from "../types.js";
import { postJson, type RetryOptions } from "./http.js";
import { type CompletionRequest, type CompletionResponse, type Provider, ProviderError } from "./types.js";

/**
 * OpenAI-compatible endpoints. Adding a hosted provider that speaks Chat
 * Completions is one line here: a base URL and the env var holding its key.
 * `compat` is the generic escape hatch; its base URL is read at call time
 * from DRAINBENCH_COMPAT_BASE_URL (see providers/index.ts).
 */
export const OPENAI_COMPAT_PRESETS: Record<string, { baseUrl: string; keyEnv: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  together: { baseUrl: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY" },
  compat: { baseUrl: "http://localhost:11434/v1", keyEnv: "DRAINBENCH_COMPAT_API_KEY" },
};

interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface OAIResponse {
  choices: { message: { content: string | null; tool_calls?: OAIToolCall[] } }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** Convert internal messages to the Chat Completions wire format. */
export function toOpenAIMessages(messages: Message[]): unknown[] {
  return messages.map(toOpenAIMessage);
}

function toOpenAIMessage(m: Message): unknown {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
}

/** Parse tool-call arguments. Malformed JSON is kept as `{ _raw }` so the call still reaches the rail and is denied there, not silently dropped. */
export function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

/** Chat Completions adapter with tool calling. Temperature defaults to 0. */
export class OpenAICompatProvider implements Provider {
  readonly synthetic = false;
  constructor(
    readonly id: string,
    private model: string,
    private baseUrl: string,
    private apiKey: string,
    private retry: RetryOptions = {},
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const body = {
      model: this.model,
      messages: toOpenAIMessages(req.messages),
      tools: req.tools.map((t) => ({ type: "function", function: t })),
      tool_choice: "auto",
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens ?? 1024,
    };
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    if (this.baseUrl.includes("openrouter.ai")) {
      headers["http-referer"] = "https://github.com/agnij-dutta/drainbench";
      headers["x-title"] = "Drainbench";
    }
    const res = await postJson<OAIResponse>(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, headers, body, this.retry);
    const msg = res.choices?.[0]?.message;
    if (!msg) throw new ProviderError(`empty response: ${JSON.stringify(res).slice(0, 300)}`);
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      args: parseArgs(c.function.arguments),
    }));
    return {
      content: msg.content ?? "",
      toolCalls,
      usage: res.usage ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens } : undefined,
    };
  }
}
