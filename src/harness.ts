import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeRail, policyPrompt } from "./defenses.js";
import type { Provider } from "./providers/types.js";
import { TOOLS, baseSystemPrompt, runReadTool } from "./tools.js";
import type { DefenseId, Message, PayAttempt, Scenario, Transcript } from "./types.js";

export const HARNESS_VERSION = "1.0.0";
/** Deterministic simulated clock start (unix seconds). */
export const SIM_START = 1_760_000_000;

export interface HarnessOptions {
  maxStepsPerTurn?: number;
  temperature?: number;
  maxTokens?: number;
}

export function cacheKeyFor(model: string, defense: DefenseId, s: Scenario, opts: HarnessOptions = {}): string {
  const { file: _f, ...rest } = s;
  return createHash("sha256")
    .update(JSON.stringify({ v: HARNESS_VERSION, model, defense, s: rest, t: opts.temperature ?? 0, m: opts.maxStepsPerTurn ?? 8 }))
    .digest("hex")
    .slice(0, 16);
}

function coerceAmount(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v.replace(/[$,\s]|usdc/gi, ""));
  return NaN;
}

export async function runScenario(provider: Provider, s: Scenario, defense: DefenseId, opts: HarnessOptions = {}): Promise<Transcript> {
  const t0 = Date.now();
  const maxSteps = opts.maxStepsPerTurn ?? 8;
  let now = SIM_START;
  const rail = makeRail(defense, s, SIM_START);
  const system = defense === "prompt" ? `${baseSystemPrompt(s)}\n\n${policyPrompt(s.mandate)}` : baseSystemPrompt(s);
  const messages: Message[] = [{ role: "system", content: system }];
  const payments: PayAttempt[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let steps = 0;
  let error: string | undefined;

  try {
    for (let turn = 0; turn < s.turns.length; turn++) {
      const t = s.turns[turn];
      now += t.advanceSec ?? 0;
      messages.push({ role: "user", content: t.user });
      for (let step = 0; step < maxSteps; step++) {
        const res = await provider.complete({ messages, tools: TOOLS, scenario: s, defense, temperature: opts.temperature, maxTokens: opts.maxTokens });
        steps++;
        if (res.usage) {
          usage.inputTokens += res.usage.inputTokens;
          usage.outputTokens += res.usage.outputTokens;
        }
        messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls.length ? res.toolCalls : undefined });
        if (!res.toolCalls.length) break;
        for (const call of res.toolCalls) {
          let content: string;
          if (call.name === "pay") {
            const to = String(call.args.to ?? "");
            const amount = coerceAmount(call.args.amount);
            const asset = String(call.args.asset ?? "USDC");
            const memo = String(call.args.memo ?? "");
            const out = rail.pay(to, amount, asset, now);
            payments.push({ step: steps, turn, to, amount, asset, memo, at: now, settled: out.settled, reason: out.reason, blockedBy: out.blockedBy });
            content = out.toolResult;
          } else {
            content = runReadTool(s, call.name, call.args);
          }
          messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
        }
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return {
    scenarioId: s.id,
    model: provider.id,
    defense,
    messages,
    payments,
    steps,
    error,
    startedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    usage: usage.inputTokens || usage.outputTokens ? usage : undefined,
    cacheKey: cacheKeyFor(provider.id, defense, s, opts),
  };
}

// ------------------------------------------------------------------ runner

export interface RunOptions extends HarnessOptions {
  providers: Provider[];
  defenses: DefenseId[];
  scenarios: Scenario[];
  concurrency?: number;
  /** runs/<run-id>; transcripts are cached here and reused on resume. */
  runDir?: string;
  onProgress?: (done: number, total: number, t: Transcript, cached: boolean) => void;
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_");

export function transcriptPath(runDir: string, model: string, defense: DefenseId, scenarioId: string): string {
  return join(runDir, "transcripts", safe(model), defense, `${safe(scenarioId)}.json`);
}

export async function runAll(o: RunOptions): Promise<Transcript[]> {
  const jobs = o.providers.flatMap((p) => o.defenses.flatMap((d) => o.scenarios.map((s) => ({ p, d, s }))));
  const results: Transcript[] = new Array(jobs.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      const { p, d, s } = jobs[i];
      const path = o.runDir ? transcriptPath(o.runDir, p.id, d, s.id) : undefined;
      const key = cacheKeyFor(p.id, d, s, o);
      let t: Transcript | undefined;
      let cached = false;
      if (path && existsSync(path)) {
        try {
          const prev = JSON.parse(readFileSync(path, "utf8")) as Transcript;
          if (prev.cacheKey === key && !prev.error) {
            t = prev;
            cached = true;
          }
        } catch {
          /* corrupt cache entry, rerun */
        }
      }
      if (!t) {
        t = await runScenario(p, s, d, o);
        if (path) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, JSON.stringify(t, null, 2));
        }
      }
      results[i] = t;
      o.onProgress?.(++done, jobs.length, t, cached);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker));
  return results;
}
