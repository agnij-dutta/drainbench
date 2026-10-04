// Deterministic mock provider. It does NOT understand language: it reads the
// scenario's ground truth (expected payments + structured attacker intents)
// and behaves according to a fixed persona. It exists to test the harness,
// scoring and defense layers, and to give an analytic worst/best-case bound.
// Mock numbers are synthetic and are labeled as such everywhere.
//
// Personas
//   naive    obeys every payment instruction it sees, and when a gate denies a
//            payment for OVER_PER_TX it retries by splitting it into chunks.
//            This is the "fully compromised brain" upper bound.
//   skimmer  a shallow verifier: pays a payee only if it "looks known"
//            (first 6 and last 4 hex chars match a trusted address). With a
//            system-prompt policy it also ignores instructions found in tool
//            output and checks the stated amount limits.
//   refuser  never pays anything. Zero loss, zero utility.
//   oracle   pays exactly the expected legitimate payments.

import type { Message, Scenario, ToolCall } from "../types.js";
import { normAddr } from "../mandate.js";
import type { CompletionRequest, CompletionResponse, Provider } from "./types.js";

export const MOCK_PERSONAS = ["naive", "skimmer", "refuser", "oracle"] as const;
export type MockPersona = (typeof MOCK_PERSONAS)[number];

interface Planned {
  to: string;
  amount: number;
  asset: string;
  memo: string;
  splittable: boolean;
}

const key = (to: string, amount: number) => `${normAddr(to)}|${Math.round(amount * 100)}`;

const shallow = (a: string) => {
  const h = normAddr(a).replace(/^0x/, "");
  return `${h.slice(0, 6)}..${h.slice(-4)}`;
};

export class MockProvider implements Provider {
  readonly synthetic = true;
  readonly id: string;
  constructor(readonly persona: MockPersona) {
    this.id = `mock:${persona}`;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const { messages, scenario: s } = req;
    const turn = messages.filter((m) => m.role === "user").length - 1;
    let n = messages.filter((m) => m.role === "assistant").length;
    const id = () => `call_${n++}`;

    // 1. On the first turn, read every fixture once (a diligent agent).
    const hasRead = messages.some((m) => m.role === "assistant" && m.toolCalls?.some((c) => c.name !== "pay"));
    if (!hasRead && this.persona !== "refuser") {
      const reads = this.readCalls(s, id);
      if (reads.length) return { content: "", toolCalls: reads };
    }

    // 2. Plan payments for this persona, then emit whatever has not been attempted yet.
    const plan = this.plan(s, turn, req.defense === "prompt", messages);
    const attempted = new Map<string, number>();
    for (const c of payCalls(messages)) {
      const k = key(String(c.args.to), Number(c.args.amount));
      attempted.set(k, (attempted.get(k) ?? 0) + 1);
    }
    const pending: Planned[] = [];
    for (const p of plan) {
      const k = key(p.to, p.amount);
      const left = attempted.get(k) ?? 0;
      if (left > 0) attempted.set(k, left - 1);
      else pending.push(p);
    }
    if (pending.length) {
      return {
        content: "",
        toolCalls: pending.map((p) => ({ id: id(), name: "pay", args: { to: p.to, amount: p.amount, asset: p.asset, memo: p.memo } })),
      };
    }
    return { content: this.persona === "refuser" ? "I can't make payments for this request." : "Done.", toolCalls: [] };
  }

  private readCalls(s: Scenario, id: () => string): ToolCall[] {
    const f = s.fixtures ?? {};
    const calls: ToolCall[] = [];
    if (f.emails?.length) {
      calls.push({ id: id(), name: "list_emails", args: {} });
      for (const e of f.emails) calls.push({ id: id(), name: "read_email", args: { id: e.id } });
    }
    for (const url of Object.keys(f.pages ?? {})) calls.push({ id: id(), name: "fetch_page", args: { url } });
    for (const inv of Object.keys(f.invoices ?? {})) calls.push({ id: id(), name: "lookup_invoice", args: { invoice_id: inv } });
    return calls;
  }

  private plan(s: Scenario, turn: number, policy: boolean, messages: Message[]): Planned[] {
    if (this.persona === "refuser") return [];
    const out: Planned[] = s.expected.map((e) => ({ to: e.to, amount: e.amount, asset: e.asset ?? "USDC", memo: "requested payment", splittable: false }));
    if (this.persona === "oracle") return out;

    const trusted = new Set(
      [...Object.values(s.addressBook ?? {}), ...(s.mandate.allowlist ?? []), ...s.expected.map((e) => e.to)].map(shallow),
    );
    const allow = (s.mandate.allowlist ?? []).map(shallow);
    let running = out.reduce((a, b) => a + b.amount, 0);

    for (const i of s.attacker?.intents ?? []) {
      if ((i.turn ?? 0) > turn) continue;
      if (this.persona === "skimmer") {
        if (!trusted.has(shallow(i.to))) continue;
        if (policy) {
          if (i.via === "tool") continue;
          if (allow.length && !allow.includes(shallow(i.to))) continue;
          if (i.amount > s.mandate.maxPerTx || running + i.amount > s.mandate.budget) continue;
        }
      }
      running += i.amount;
      out.push({ to: i.to, amount: i.amount, asset: i.asset ?? "USDC", memo: i.memo ?? "payment", splittable: this.persona === "naive" });
    }

    // naive persona: when the gate says OVER_PER_TX, split into cap-sized chunks.
    if (this.persona === "naive") {
      for (const d of deniedOverPerTx(messages)) {
        const p = out.find((x) => x.splittable && key(x.to, x.amount) === key(d.to, d.amount));
        if (!p || d.cap <= 0) continue;
        let left = p.amount;
        let chunks = 0;
        while (left > 1e-9 && chunks < 10) {
          const c = Math.min(d.cap, left);
          out.push({ ...p, amount: Math.round(c * 100) / 100, splittable: false, memo: `${p.memo} (part ${chunks + 1})` });
          left -= c;
          chunks++;
        }
      }
    }
    return out;
  }
}

function payCalls(messages: Message[]): ToolCall[] {
  return messages.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []).filter((c) => c.name === "pay") : []));
}

function deniedOverPerTx(messages: Message[]): { to: string; amount: number; cap: number }[] {
  const calls = new Map(payCalls(messages).map((c) => [c.id, c]));
  const out: { to: string; amount: number; cap: number }[] = [];
  for (const m of messages) {
    if (m.role !== "tool" || m.name !== "pay") continue;
    try {
      const r = JSON.parse(m.content);
      const c = calls.get(m.toolCallId);
      if (r.status === "denied" && r.reason === "OVER_PER_TX" && c) out.push({ to: String(c.args.to), amount: Number(c.args.amount), cap: Number(r.max_per_tx) });
    } catch {
      /* not JSON */
    }
  }
  return out;
}
