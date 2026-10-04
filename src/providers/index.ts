// Provider registry. A model spec is `<provider>:<model>`; the part before the
// first colon picks a factory from PROVIDERS, the rest is passed through as
// the model name (so `openrouter:openai/gpt-4o-mini` works).
//
// To add a provider:
//   1. If it speaks the OpenAI Chat Completions format, add an entry to
//      OPENAI_COMPAT_PRESETS in ./openai.ts. Nothing else is needed.
//   2. Otherwise write a class implementing `Provider` (see ./types.ts and
//      ./anthropic.ts for a ~60 line example), then register a factory here
//      or at runtime with registerProvider().

import { AnthropicProvider } from "./anthropic.js";
import { MOCK_PERSONAS, type MockPersona, MockProvider } from "./mock.js";
import { OPENAI_COMPAT_PRESETS, OpenAICompatProvider } from "./openai.js";
import type { Provider } from "./types.js";

export { AnthropicProvider } from "./anthropic.js";
export { MOCK_PERSONAS, type MockPersona, MockProvider } from "./mock.js";
export { OPENAI_COMPAT_PRESETS, OpenAICompatProvider } from "./openai.js";
export * from "./types.js";

/** Environment variables a factory may read. Defaults to process.env. */
export type Env = Record<string, string | undefined>;

/**
 * Builds a provider for one model.
 * @param spec  the full spec, e.g. `groq:openai/gpt-oss-120b`; use it as the Provider id
 * @param model the part after the first colon
 */
export type ProviderFactory = (spec: string, model: string, env: Env) => Provider;

function requireEnv(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set. Export it in your shell (see .env.example).`);
  return v;
}

const mockFactory: ProviderFactory = (_spec, model) => {
  if (!MOCK_PERSONAS.includes(model as MockPersona)) throw new Error(`unknown mock persona "${model}" (${MOCK_PERSONAS.join(", ")})`);
  return new MockProvider(model as MockPersona);
};

const anthropicFactory: ProviderFactory = (spec, model, env) => new AnthropicProvider(spec, model, requireEnv(env, "ANTHROPIC_API_KEY"));

function openAICompatFactory(name: string): ProviderFactory {
  const preset = OPENAI_COMPAT_PRESETS[name];
  return (spec, model, env) => {
    if (name === "compat") {
      // Local servers (Ollama, vLLM, LM Studio) usually need no key.
      const baseUrl = env.DRAINBENCH_COMPAT_BASE_URL ?? preset.baseUrl;
      return new OpenAICompatProvider(spec, model, baseUrl, env[preset.keyEnv] ?? "none");
    }
    return new OpenAICompatProvider(spec, model, preset.baseUrl, requireEnv(env, preset.keyEnv));
  };
}

/** Provider name to factory. Mutate through registerProvider(). */
export const PROVIDERS: Record<string, ProviderFactory> = {
  mock: mockFactory,
  anthropic: anthropicFactory,
  ...Object.fromEntries(Object.keys(OPENAI_COMPAT_PRESETS).map((name) => [name, openAICompatFactory(name)])),
};

/** Register (or replace) a provider factory under `name`, e.g. from a script that imports drainbench as a library. */
export function registerProvider(name: string, factory: ProviderFactory): void {
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`provider name must match [a-z0-9_-]+, got "${name}"`);
  PROVIDERS[name] = factory;
}

/**
 * Build a provider from a model spec `<provider>:<model>`, for example
 * `mock:naive`, `groq:openai/gpt-oss-120b`, `openrouter:openai/gpt-4o-mini`,
 * `anthropic:claude-haiku-4-5`, `compat:llama3.1` (with DRAINBENCH_COMPAT_BASE_URL).
 * Keys come from `env` only; there is no config file.
 */
export function makeProvider(spec: string, env: Env = process.env): Provider {
  const i = spec.indexOf(":");
  if (i < 0) throw new Error(`model spec must be <provider>:<model>, got "${spec}"`);
  const name = spec.slice(0, i);
  const model = spec.slice(i + 1);
  if (!model) throw new Error(`model spec "${spec}" has an empty model name`);
  const factory = PROVIDERS[name];
  if (!factory) throw new Error(`unknown provider "${name}" (known: ${Object.keys(PROVIDERS).join(", ")})`);
  return factory(spec, model, env);
}
