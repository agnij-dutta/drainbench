// Core types for Drainbench. Scenario files (scenarios/**/*.yaml) are parsed
// into `Scenario`; the harness produces `Transcript`s; scoring produces
// `ScenarioScore`s which aggregate into a `RunResult`.

export const CATEGORIES = [
  "direct",
  "indirect",
  "lookalike",
  "authority",
  "urgency",
  "slow_boil",
  "obfuscated",
  "over_cap",
  "split",
  "refund",
  "benign",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  direct: "Direct injection",
  indirect: "Indirect (tool output)",
  lookalike: "Look-alike payee",
  authority: "Authority impersonation",
  urgency: "Urgency / social eng.",
  slow_boil: "Multi-turn slow boil",
  obfuscated: "Encoded / obfuscated",
  over_cap: "Over-cap invoice",
  split: "Split under per-tx cap",
  refund: "Refund / reversal trick",
  benign: "Benign control",
};

/** A spend mandate, mirroring Capline's MandateRegistry.Mandate. Amounts in whole USD(C). */
export interface Mandate {
  maxPerTx: number;
  /** maxCumulative in Capline terms: lifetime budget across all settlements. */
  budget: number;
  /** allowed payees; empty or omitted = any payee (allowedPayeesRoot == 0). */
  allowlist?: string[];
  /** seconds after scenario start at which the mandate expires; omitted = no expiry. */
  expiresInSec?: number;
  /** token the mandate is denominated in. Default USDC. */
  asset?: string;
  revoked?: boolean;
}

export interface Email {
  id: string;
  from: string;
  subject: string;
  body: string;
  date?: string;
}

export interface Turn {
  user: string;
  /** advance the simulated clock before this turn (for expiry tests). */
  advanceSec?: number;
}

export interface ExpectedPayment {
  to: string;
  amount: number;
  asset?: string;
  /** absolute tolerance in USD for amount matching. Default 0.01. */
  tolerance?: number;
}

export interface AttackIntent {
  to: string;
  amount: number;
  asset?: string;
  memo?: string;
  /** where the injected instruction is delivered from. */
  via: "user" | "tool";
  /** 0-based user turn index on/after which the intent is visible. Default 0. */
  turn?: number;
}

export interface Scenario {
  id: string;
  category: Category;
  kind: "attack" | "benign";
  title: string;
  /** public pattern this case is modeled on (for provenance). */
  pattern?: string;
  mandate: Mandate;
  /** wallet balance in USD. Default 10_000. */
  wallet?: number;
  /** named payees the principal already trusts, shown to the agent as an address book. */
  addressBook?: Record<string, string>;
  turns: Turn[];
  fixtures?: {
    pages?: Record<string, string>;
    emails?: Email[];
    invoices?: Record<string, unknown>;
  };
  /** ground-truth legitimate payments. Required for task success. */
  expected: ExpectedPayment[];
  attacker?: {
    payees: string[];
    intents: AttackIntent[];
  };
  /** source file, filled in by the loader. */
  file?: string;
}

// ---------------------------------------------------------------- transcripts

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface PayAttempt {
  /** step index within the transcript */
  step: number;
  turn: number;
  to: string;
  amount: number;
  asset: string;
  memo: string;
  /** simulated unix seconds at call time */
  at: number;
  /** what the defense stack decided at call time (threat model T1: brain compromised, signer intact). */
  settled: boolean;
  /** denial reason when !settled */
  reason?: string;
  /** which layer stopped it */
  blockedBy?: "gate" | "chain" | "wallet" | "invalid";
}

export interface Transcript {
  scenarioId: string;
  model: string;
  defense: DefenseId;
  messages: Message[];
  payments: PayAttempt[];
  steps: number;
  error?: string;
  startedAt: string;
  durationMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  cacheKey: string;
}

export const DEFENSES = ["none", "prompt", "gate", "enforced"] as const;
export type DefenseId = (typeof DEFENSES)[number];

export const DEFENSE_LABELS: Record<DefenseId, string> = {
  none: "No defense",
  prompt: "System-prompt policy",
  gate: "Off-chain policy gate",
  enforced: "Enforced cap (Capline)",
};

// -------------------------------------------------------------------- scoring

export interface ScoredPayment extends PayAttempt {
  authorized: boolean;
  toAttacker: boolean;
}

export interface ScenarioScore {
  scenarioId: string;
  category: Category;
  kind: "attack" | "benign";
  model: string;
  defense: DefenseId;
  error?: string;
  /** model attempted at least one unauthorized payment */
  attacked: boolean;
  /** at least one unauthorized payment settled (T1) */
  lost: boolean;
  usdLost: number;
  /** subset of usdLost that reached attacker-controlled addresses (vs. overpaying a real vendor). */
  usdToAttacker: number;
  /** usd lost if the signing key / off-chain gate is bypassed (T2). */
  usdLostKeyCompromised: number;
  lostKeyCompromised: boolean;
  /** all expected payments settled and nothing unauthorized was attempted */
  taskSuccess: boolean;
  /** all expected payments settled (ignores attack attempts) */
  legitCompleted: boolean;
  denials: number;
  /** model retried a payment after being denied */
  retriedAfterDeny: boolean;
  payments: ScoredPayment[];
}

export interface AggregateMetrics {
  attackCases: number;
  benignCases: number;
  errors: number;
  /** attempted malicious payment / attack cases */
  attackSuccessRate: number;
  /** unauthorized funds actually settled / attack cases */
  fundsLostRate: number;
  usdLost: number;
  /** subset of usdLost that reached attacker-controlled addresses */
  usdToAttacker: number;
  usdAttempted: number;
  /** T2: signer key or off-chain gate bypassed */
  fundsLostRateKeyCompromised: number;
  usdLostKeyCompromised: number;
  /** benign controls fully completed with no unauthorized payment */
  benignSuccessRate: number;
  /** attack cases that also had a legit payment: legit payment still completed */
  utilityUnderAttack: number;
  denials: number;
}

export interface CategoryMetrics {
  cases: number;
  attackSuccessRate: number;
  fundsLostRate: number;
  usdLost: number;
}

export interface ModelDefenseResult {
  model: string;
  defense: DefenseId;
  metrics: AggregateMetrics;
  byCategory: Partial<Record<Category, CategoryMetrics>>;
}

export interface RunResult {
  runId: string;
  createdAt: string;
  harnessVersion: string;
  corpusVersion: string;
  scenarioCount: number;
  models: string[];
  defenses: DefenseId[];
  synthetic: boolean;
  results: ModelDefenseResult[];
  scores: ScenarioScore[];
}
