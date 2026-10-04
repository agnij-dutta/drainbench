// Corpus loading, validation and selection. A corpus is a directory of YAML
// (or JSON) files, each holding a `scenarios:` list or a bare list.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse } from "yaml";
import { isAddress, MandateState, normAddr, normAsset } from "./mandate.js";
import { CATEGORIES, type Scenario } from "./types.js";

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(ya?ml|json)$/.test(f) ? [p] : [];
    });
}

export interface Corpus {
  scenarios: Scenario[];
  /** `<dir>@<sha256 prefix over file contents>`: any edit to the corpus changes it. */
  version: string;
}

/** Load and validate every scenario under `path` (a directory or a single file). Throws listing every problem. */
export function loadCorpus(path: string): Corpus {
  const files = statSync(path).isDirectory() ? walk(path) : [path];
  const hash = createHash("sha256");
  const scenarios: Scenario[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    hash.update(text);
    let doc: unknown;
    try {
      doc = f.endsWith(".json") ? JSON.parse(text) : parse(text);
    } catch (e) {
      throw new Error(`cannot parse ${f}: ${e instanceof Error ? e.message : e}`);
    }
    const list = Array.isArray(doc) ? doc : (doc as { scenarios?: unknown })?.scenarios;
    if (!Array.isArray(list)) throw new Error(`${f}: expected a top-level "scenarios:" list or a bare list`);
    for (const s of list) scenarios.push({ ...s, file: relative(process.cwd(), f) });
  }
  const errors = validateScenarios(scenarios);
  if (errors.length) throw new Error(`invalid scenarios:\n  ${errors.join("\n  ")}`);
  return { scenarios, version: `${basename(path)}@${hash.digest("hex").slice(0, 10)}` };
}

const SCENARIO_KEYS = new Set([
  "id",
  "category",
  "kind",
  "title",
  "pattern",
  "mandate",
  "wallet",
  "addressBook",
  "turns",
  "fixtures",
  "expected",
  "attacker",
  "file",
]);
const MANDATE_KEYS = new Set(["maxPerTx", "budget", "allowlist", "expiresInSec", "asset", "revoked"]);
const FIXTURE_KEYS = new Set(["pages", "emails", "invoices"]);

const unknownKeys = (obj: unknown, allowed: Set<string>) =>
  obj && typeof obj === "object" ? Object.keys(obj).filter((k) => !allowed.has(k)) : [];
const positive = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * Validate a list of scenarios. Returns human-readable errors, empty when
 * valid. Checks schema shape, rejects unknown keys (a typo like
 * `fixtures.page` would otherwise silently serve a 404), and checks that the
 * case is fair: every expected payment fits the mandate, and no attack intent
 * is identical to an expected payment (it would be scored as authorized).
 */
export function validateScenarios(list: Scenario[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const where = `${s.id ?? "?"} (${s.file ?? "inline"})`;
    const err = (msg: string) => errors.push(`${where}: ${msg}`);
    if (!s.id) err("missing id");
    if (seen.has(s.id)) err("duplicate id");
    seen.add(s.id);
    for (const k of unknownKeys(s, SCENARIO_KEYS)) err(`unknown key "${k}"`);
    for (const k of unknownKeys(s.mandate, MANDATE_KEYS)) err(`unknown key "mandate.${k}"`);
    for (const k of unknownKeys(s.fixtures, FIXTURE_KEYS)) err(`unknown key "fixtures.${k}"`);
    if (!CATEGORIES.includes(s.category)) err(`unknown category "${s.category}" (known: ${CATEGORIES.join(", ")})`);
    if (s.kind !== "attack" && s.kind !== "benign") err("kind must be attack|benign");
    if ((s.category === "benign") !== (s.kind === "benign")) err("benign controls use category benign, and only they do");
    if (!s.title) err("missing title");
    if (!s.pattern) err("missing pattern (cite the public pattern this case follows)");
    if (s.kind === "benign" && s.attacker?.intents?.length) err("benign case has attacker intents");
    if (s.kind === "attack" && !s.attacker?.intents?.length) err("attack case has no attacker intents");
    if (!s.mandate || !positive(s.mandate.maxPerTx) || !positive(s.mandate.budget))
      err("mandate.maxPerTx and mandate.budget are required positive numbers");
    if (s.wallet !== undefined && !positive(s.wallet)) err("wallet must be a positive number");
    if (!Array.isArray(s.turns) || !s.turns.length || s.turns.some((t) => typeof t.user !== "string"))
      err("turns must be a non-empty list of {user}");
    if (!Array.isArray(s.expected)) err("expected must be a list (use [] when no payment is legitimate)");
    for (const e of s.expected ?? []) if (!positive(e.amount)) err(`expected amount must be positive, got ${e.amount}`);
    for (const i of s.attacker?.intents ?? []) if (!positive(i.amount)) err(`intent amount must be positive, got ${i.amount}`);
    const addrs = [
      ...(s.expected ?? []).map((e) => e.to),
      ...(s.mandate?.allowlist ?? []),
      ...Object.values(s.addressBook ?? {}),
      ...(s.attacker?.payees ?? []),
      ...(s.attacker?.intents ?? []).map((i) => i.to),
    ];
    for (const a of addrs) if (!isAddress(String(a))) err(`bad address ${a} (want 0x + 40 hex)`);
    for (const i of s.attacker?.intents ?? []) {
      if (i.via !== "user" && i.via !== "tool") err("intent.via must be user|tool");
      if ((i.turn ?? 0) >= (s.turns?.length ?? 0)) err("intent.turn out of range");
      const same = (s.expected ?? []).some(
        (e) =>
          normAddr(e.to) === normAddr(i.to) &&
          normAsset(e.asset) === normAsset(i.asset) &&
          Math.abs(e.amount - i.amount) <= (e.tolerance ?? 0.01),
      );
      if (same) err(`intent ${i.amount} to ${i.to} equals an expected payment, so following it would score as authorized`);
    }
    // Every expected payment must be payable under the mandate, so a correct
    // agent is never blocked by the gate (otherwise utility scores are unfair).
    // Expiry is not checked here because expected payments carry no turn; the
    // corpus test runs the oracle persona under every defense to cover it.
    if (s.mandate && Array.isArray(s.expected)) {
      const st = new MandateState(s.mandate, 0);
      for (const e of s.expected) {
        const r = st.settle(e.to, e.amount, e.asset, 0);
        if (!r.ok) err(`expected payment ${e.amount} to ${e.to} violates mandate (${r.reason})`);
      }
    }
    if (JSON.stringify(s).includes("\u2014")) err("contains an em dash (use a comma, colon or period)");
  }
  return errors;
}

/** Select scenarios by category, id (with trailing * as prefix match), kind, then a stratified limit. */
export function filterScenarios(
  list: Scenario[],
  opts: { categories?: string[]; ids?: string[]; limit?: number; kind?: "attack" | "benign" },
): Scenario[] {
  let out = list;
  const { categories, ids } = opts;
  if (categories?.length) out = out.filter((s) => categories.includes(s.category));
  if (ids?.length) out = out.filter((s) => ids.some((p) => (p.endsWith("*") ? s.id.startsWith(p.slice(0, -1)) : s.id === p)));
  if (opts.kind) out = out.filter((s) => s.kind === opts.kind);
  if (opts.limit && opts.limit < out.length) out = stratifiedSample(out, opts.limit);
  return out;
}

/** Deterministic stratified sample: round-robin across categories so small runs still cover everything. */
export function stratifiedSample(list: Scenario[], n: number): Scenario[] {
  const byCat = new Map<string, Scenario[]>();
  for (const s of list) byCat.set(s.category, [...(byCat.get(s.category) ?? []), s]);
  const queues = [...byCat.values()];
  const out: Scenario[] = [];
  for (let i = 0; out.length < n; i++) {
    let added = false;
    for (const q of queues) {
      if (out.length >= n) break;
      if (q[i]) {
        out.push(q[i]);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}
