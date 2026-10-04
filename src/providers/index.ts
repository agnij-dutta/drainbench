import { AnthropicProvider } from "./anthropic.js";
import { MOCK_PERSONAS, MockProvider, type MockPersona } from "./mock.js";
import { OPENAI_COMPAT_PRESETS, OpenAICompatProvider } from "./openai.js";
import type { Provider } from "./types.js";

export * from "./types.js";
export { MockProvider, MOCK_PERSONAS } from "./mock.js";

/**
 * Model spec: `<provider>:<model>`.
 *   mock:naive | mock:skimmer | mock:refuser | mock:oracle
 *   groq:llama-3.3-70b-versatile
 *   openrouter:openai/gpt-4o-mini
 *   openai:gpt-4.1-mini   together:<model>   compat:<model> (DRAINBENCH_COMPAT_BASE_URL)
 *   anthropic:claude-haiku-4-5
 */
export function makeProvider(spec: string, env: NodeJS.ProcessEnv = process.env): Provider {
  const i = spec.indexOf(":");
  if (i < 0) throw new Error(`model spec must be <provider>:<model>, got "${spec}"`);
  const provider = spec.slice(0, i);
  const model = spec.slice(i + 1);
  if (provider === "mock") {
    if (!MOCK_PERSONAS.includes(model as MockPersona)) throw new Error(`unknown mock persona "${model}" (${MOCK_PERSONAS.join(", ")})`);
    return new MockProvider(model as MockPersona);
  }
  if (provider === "anthropic") {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
    return new AnthropicProvider(spec, model, key);
  }
  const preset = OPENAI_COMPAT_PRESETS[provider];
  if (!preset) throw new Error(`unknown provider "${provider}"`);
  const key = env[preset.keyEnv] ?? (provider === "compat" ? "none" : undefined);
  if (!key) throw new Error(`${preset.keyEnv} is not set`);
  const baseUrl = provider === "compat" ? env.DRAINBENCH_COMPAT_BASE_URL ?? preset.baseUrl : preset.baseUrl;
  return new OpenAICompatProvider(spec, model, baseUrl, key);
}
