import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse } from "yaml";
import { MandateState } from "./mandate.js";
import { CATEGORIES, type Scenario } from "./types.js";

const ADDR = /^0x[0-9a-f]{40}$/;

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
  version: string;
}

export function loadCorpus(path: string): Corpus {
  const files = statSync(path).isDirectory() ? walk(path) : [path];
  const hash = createHash("sha256");
  const scenarios: Scenario[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    hash.update(text);
    const doc = f.endsWith(".json") ? JSON.parse(text) : parse(text);
    const list: Scenario[] = Array.isArray(doc) ? doc : (doc?.scenarios ?? []);
    for (const s of list) scenarios.push({ ...s, file: relative(process.cwd(), f) });
  }
  const errors = validateScenarios(scenarios);
  if (errors.length) throw new Error(`invalid scenarios:\n  ${errors.join("\n  ")}`);
  return { scenarios, version: `${basename(path)}@${hash.digest("hex").slice(0, 10)}` };
}

export function validateScenarios(list: Scenario[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const s of list) {
    const where = `${s.id ?? "?"} (${s.file ?? "inline"})`;
    if (!s.id) errors.push(`${where}: missing id`);
    if (seen.has(s.id)) errors.push(`${where}: duplicate id`);
    seen.add(s.id);
    if (!CATEGORIES.includes(s.category)) errors.push(`${where}: unknown category ${s.category}`);
    if (s.kind !== "attack" && s.kind !== "benign") errors.push(`${where}: kind must be attack|benign`);
    if (s.kind === "benign" && s.attacker?.intents?.length) errors.push(`${where}: benign case has attacker intents`);
    if (s.kind === "attack" && !s.attacker?.intents?.length) errors.push(`${where}: attack case has no attacker intents`);
    if (!s.mandate || typeof s.mandate.maxPerTx !== "number" || typeof s.mandate.budget !== "number")
      errors.push(`${where}: mandate.maxPerTx and mandate.budget are required numbers`);
    if (!Array.isArray(s.turns) || !s.turns.length || s.turns.some((t) => typeof t.user !== "string"))
      errors.push(`${where}: turns must be a non-empty list of {user}`);
    if (!Array.isArray(s.expected)) errors.push(`${where}: expected must be a list`);
    const addrs = [
      ...(s.expected ?? []).map((e) => e.to),
      ...(s.mandate?.allowlist ?? []),
      ...Object.values(s.addressBook ?? {}),
      ...(s.attacker?.payees ?? []),
      ...(s.attacker?.intents ?? []).map((i) => i.to),
    ];
    for (const a of addrs) if (!ADDR.test(String(a))) errors.push(`${where}: bad address ${a}`);
    for (const i of s.attacker?.intents ?? []) {
      if (i.via !== "user" && i.via !== "tool") errors.push(`${where}: intent.via must be user|tool`);
      if ((i.turn ?? 0) >= (s.turns?.length ?? 0)) errors.push(`${where}: intent.turn out of range`);
    }
    // Every expected payment must be payable under the mandate, so a correct
    // agent is never blocked by the gate (otherwise utility scores are unfair).
    if (s.mandate && Array.isArray(s.expected)) {
      const st = new MandateState(s.mandate, 0);
      for (const e of s.expected) {
        const r = st.settle(e.to, e.amount, e.asset, 0);
        if (!r.ok) errors.push(`${where}: expected payment ${e.amount} to ${e.to} violates mandate (${r.reason})`);
      }
    }
    const json = JSON.stringify(s);
    if (json.includes("\u2014")) errors.push(`${where}: contains an em dash`);
  }
  return errors;
}

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
