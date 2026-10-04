// Anthropic Messages API adapter (raw HTTP, no SDK dependency).
import type { Message, ToolCall } from "../types.js";
import { postJson, type RetryOptions } from "./http.js";
import type { CompletionRequest, CompletionResponse, Provider } from "./types.js";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicResponse {
  content: Block[];
  usage?: { input_tokens: number; output_tokens: number };
}

/** Convert internal messages to Anthropic format: system split out, tool results batched into user turns. */
export function toAnthropic(messages: Message[]): { system: string; messages: { role: "user" | "assistant"; content: Block[] }[] } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  const push = (role: "user" | "assistant", block: Block) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") push("user", { type: "text", text: m.content });
    else if (m.role === "tool") push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: m.content });
    else {
      if (m.content) push("assistant", { type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) push("assistant", { type: "tool_use", id: c.id, name: c.name, input: c.args });
      if (!m.content && !m.toolCalls?.length) push("assistant", { type: "text", text: "(no response)" });
    }
  }
  return { system, messages: out };
}

/** Anthropic Messages API adapter with tool use. Temperature defaults to 0. */
export class AnthropicProvider implements Provider {
  readonly synthetic = false;
  constructor(
    readonly id: string,
    private model: string,
    private apiKey: string,
    private retry: RetryOptions = {},
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const { system, messages } = toAnthropic(req.messages);
    const res = await postJson<AnthropicResponse>(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0,
        system,
        messages,
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      },
      this.retry,
    );
    const text = res.content
      .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const toolCalls: ToolCall[] = res.content
      .filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
    return {
      content: text,
      toolCalls,
      usage: res.usage ? { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } : undefined,
    };
  }
}
