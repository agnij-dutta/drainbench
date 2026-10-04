import { describe, expect, it } from "vitest";
import { toAnthropic } from "../src/providers/anthropic.js";
import { makeProvider, registerProvider } from "../src/providers/index.js";
import { OpenAICompatProvider, parseArgs, toOpenAIMessages } from "../src/providers/openai.js";
import { TOOLS } from "../src/tools.js";
import type { Message } from "../src/types.js";
import { scenario } from "./fixtures.js";

const convo: Message[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hi" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "c1", name: "fetch_page", args: { url: "x" } },
      { id: "c2", name: "list_emails", args: {} },
    ],
  },
  { role: "tool", toolCallId: "c1", name: "fetch_page", content: "page" },
  { role: "tool", toolCallId: "c2", name: "list_emails", content: "[]" },
  { role: "assistant", content: "done" },
];

describe("message conversion", () => {
  it("OpenAI format carries tool_calls and tool_call_id", () => {
    const m = toOpenAIMessages(convo) as any[];
    expect(m[2].tool_calls[0]).toMatchObject({ id: "c1", type: "function", function: { name: "fetch_page", arguments: '{"url":"x"}' } });
    expect(m[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "page" });
  });
  it("Anthropic format splits system and batches tool results into one user turn", () => {
    const a = toAnthropic(convo);
    expect(a.system).toBe("sys");
    expect(a.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(a.messages[2].content).toHaveLength(2);
    expect(a.messages[1].content[0]).toMatchObject({ type: "tool_use", id: "c1" });
  });
  it("parseArgs tolerates bad JSON", () => {
    expect(parseArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseArgs("not json")).toEqual({ _raw: "not json" });
  });
});

describe("OpenAI-compatible adapter", () => {
  it("parses tool calls and retries on 429", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "x", type: "function", function: { name: "pay", arguments: '{"to":"0x1","amount":5,"asset":"USDC","memo":"m"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      });
    }) as typeof fetch;
    const p = new OpenAICompatProvider("groq:test", "test", "https://example.invalid/v1", "k", { fetchImpl, baseDelayMs: 1 });
    const r = await p.complete({ messages: convo, tools: TOOLS, scenario: scenario(), defense: "none" });
    expect(calls).toBe(2);
    expect(r.toolCalls[0]).toMatchObject({ name: "pay", args: { amount: 5 } });
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });
  it("does not retry on 401", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("no", { status: 401 });
    }) as typeof fetch;
    const p = new OpenAICompatProvider("groq:test", "test", "https://example.invalid/v1", "k", { fetchImpl, baseDelayMs: 1 });
    await expect(p.complete({ messages: convo, tools: TOOLS, scenario: scenario(), defense: "none" })).rejects.toThrow("401");
    expect(calls).toBe(1);
  });
});

describe("makeProvider", () => {
  it("builds mocks and validates specs", () => {
    expect(makeProvider("mock:naive").id).toBe("mock:naive");
    expect(() => makeProvider("mock:nope")).toThrow();
    expect(() => makeProvider("nocolon")).toThrow();
    expect(() => makeProvider("groq:llama", {})).toThrow("GROQ_API_KEY");
    expect(makeProvider("groq:llama", { GROQ_API_KEY: "x" }).id).toBe("groq:llama");
    expect(makeProvider("anthropic:claude-haiku-4-5", { ANTHROPIC_API_KEY: "x" }).synthetic).toBe(false);
  });
  it("rejects unknown providers and empty model names with the list of known providers", () => {
    expect(() => makeProvider("nope:model")).toThrow(/known: .*mock/);
    expect(() => makeProvider("mock:")).toThrow("empty model name");
  });
  it("compat needs no key and reads its base URL at call time", () => {
    expect(makeProvider("compat:llama3.1", { DRAINBENCH_COMPAT_BASE_URL: "http://localhost:8000/v1" }).id).toBe("compat:llama3.1");
  });
  it("registerProvider adds a provider without touching the registry source", () => {
    registerProvider("echo", (spec) => ({ id: spec, synthetic: true, complete: async () => ({ content: "", toolCalls: [] }) }));
    expect(makeProvider("echo:anything").id).toBe("echo:anything");
    expect(() => registerProvider("Bad Name", () => makeProvider("mock:naive"))).toThrow();
  });
});
