#!/usr/bin/env node
// The drainbench CLI. Run `drainbench help` for usage; README "Usage" documents every flag.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { HARNESS_VERSION, runAll } from "./harness.js";
import { leaderboardHtml } from "./leaderboard.js";
import { makeProvider, PROVIDERS } from "./providers/index.js";
import { markdownReport, modelLabel, pct, usd } from "./report.js";
import { filterScenarios, loadCorpus } from "./scenarios.js";
import { scoreTranscript, summarize } from "./score.js";
import { CATEGORY_LABELS, DEFENSE_LABELS, DEFENSES, type DefenseId, type RunResult } from "./types.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CORPUS = existsSync("scenarios/v1") ? "scenarios/v1" : join(PKG_ROOT, "scenarios/v1");

const HELP = `drainbench: prompt-injection benchmark for LLM agents with a payment tool

Usage:
  drainbench run [options]                 run models x defenses x scenarios
  drainbench report <results.json>         print a markdown report
  drainbench leaderboard <results.json...> [-o site/index.html]
  drainbench validate [--scenarios dir]    validate the scenario corpus
  drainbench list [--scenarios dir]        list scenarios

run options:
  --models     comma list of <provider>:<model>   (default: mock:naive,mock:skimmer,mock:refuser,mock:oracle)
               providers: ${Object.keys(PROVIDERS).join(", ")}
  --defenses   comma list of ${DEFENSES.join(",")} (default: all)
  --scenarios  corpus dir or file (default: scenarios/v1)
  --category   comma list of categories to include
  --ids        comma list of scenario ids (suffix * for prefix match)
  --limit      stratified sample of N scenarios across categories
  --concurrency N parallel episodes (default 4)
  --max-steps  max model calls per user turn (default 8)
  --temperature sampling temperature (default 0)
  --max-tokens max output tokens per model call (default 1024)
  --run-id     id for runs/<run-id>/ and results/<run-id>.* (reruns reuse cached transcripts)
  --out        results dir (default results)
  --note       free-text provenance stored in the results file (machine, date, settings)
  --quiet      no per-episode progress lines

leaderboard options:
  -o           output file (default site/index.html)
  --title      page title (default Drainbench)

Model keys are read from the environment only (see .env.example).
`;

/** Parse a numeric flag, failing loudly instead of silently falling back. */
function num(name: string, v: string | undefined, opts: { min: number; int?: boolean }): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < opts.min || (opts.int && !Number.isInteger(n)))
    throw new Error(`--${name} must be ${opts.int ? "an integer" : "a number"} >= ${opts.min}, got "${v}"`);
  return n;
}

function list(v: string | undefined): string[] | undefined {
  return v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
}

async function cmdRun(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      models: { type: "string" },
      defenses: { type: "string" },
      scenarios: { type: "string" },
      category: { type: "string" },
      ids: { type: "string" },
      limit: { type: "string" },
      concurrency: { type: "string" },
      "max-steps": { type: "string" },
      temperature: { type: "string" },
      "max-tokens": { type: "string" },
      "run-id": { type: "string" },
      out: { type: "string" },
      note: { type: "string" },
      quiet: { type: "boolean" },
    },
  });
  const corpus = loadCorpus(values.scenarios ?? DEFAULT_CORPUS);
  const scenarios = filterScenarios(corpus.scenarios, {
    categories: list(values.category),
    ids: list(values.ids),
    limit: num("limit", values.limit, { min: 1, int: true }),
  });
  if (!scenarios.length) throw new Error("no scenarios selected");
  const providers = (list(values.models) ?? ["mock:naive", "mock:skimmer", "mock:refuser", "mock:oracle"]).map((m) => makeProvider(m));
  const defenses = (list(values.defenses) ?? [...DEFENSES]) as DefenseId[];
  for (const d of defenses) if (!DEFENSES.includes(d)) throw new Error(`unknown defense ${d}`);
  const concurrency = num("concurrency", values.concurrency, { min: 1, int: true }) ?? 4;
  const maxStepsPerTurn = num("max-steps", values["max-steps"], { min: 1, int: true }) ?? 8;
  const temperature = num("temperature", values.temperature, { min: 0 });
  const maxTokens = num("max-tokens", values["max-tokens"], { min: 1, int: true });
  const runId = values["run-id"] ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`--run-id may only contain letters, digits, . _ -, got "${runId}"`);
  const runDir = join("runs", runId);
  const outDir = values.out ?? "results";
  mkdirSync(runDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const total = providers.length * defenses.length * scenarios.length;
  process.stderr.write(
    `drainbench ${HARNESS_VERSION} · run ${runId} · ${providers.length} models x ${defenses.length} defenses x ${scenarios.length} scenarios = ${total} episodes\n`,
  );
  let cachedN = 0;
  const transcripts = await runAll({
    providers,
    defenses,
    scenarios,
    concurrency,
    maxStepsPerTurn,
    temperature,
    maxTokens,
    runDir,
    onProgress: (done, n, t, cached) => {
      if (cached) cachedN++;
      if (!values.quiet) {
        const tag = t.error ? `ERROR ${t.error.slice(0, 80)}` : `${t.payments.length} pay call(s)`;
        process.stderr.write(
          `[${String(done).padStart(String(n).length)}/${n}] ${t.model} · ${t.defense} · ${t.scenarioId} · ${tag}${cached ? " (cached)" : ""}\n`,
        );
      }
    },
  });

  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const scores = transcripts.map((t) => {
    const s = byId.get(t.scenarioId);
    if (!s) throw new Error(`internal: transcript for unknown scenario ${t.scenarioId}`);
    return scoreTranscript(t, s);
  });
  const models = providers.map((p) => p.id);
  const result: RunResult = {
    runId,
    createdAt: new Date().toISOString(),
    harnessVersion: HARNESS_VERSION,
    corpusVersion: corpus.version,
    scenarioCount: scenarios.length,
    models,
    defenses,
    synthetic: providers.every((p) => p.synthetic),
    environment: { node: process.versions.node, platform: process.platform, arch: process.arch },
    ...(values.note ? { note: values.note } : {}),
    results: summarize(scores, scenarios, models, defenses),
    scores,
  };
  const jsonPath = join(outDir, `${runId}.json`);
  const mdPath = join(outDir, `${runId}.md`);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  writeFileSync(mdPath, markdownReport(result));
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({ runId, corpus: corpus.version, models, defenses, scenarios: scenarios.map((s) => s.id) }, null, 2),
  );

  console.log(
    `\n${"model".padEnd(36)} ${"defense".padEnd(24)} ${"attempted".padStart(9)} ${"lost".padStart(6)} ${"$ lost".padStart(9)} ${"$ key-comp".padStart(10)} ${"benign".padStart(7)} err`,
  );
  for (const x of result.results) {
    const m = x.metrics;
    console.log(
      `${modelLabel(x.model).padEnd(36)} ${DEFENSE_LABELS[x.defense].padEnd(24)} ${pct(m.attackSuccessRate).padStart(9)} ${pct(m.fundsLostRate).padStart(6)} ${usd(m.usdLost).padStart(9)} ${usd(m.usdLostKeyCompromised).padStart(10)} ${pct(m.benignSuccessRate).padStart(7)} ${m.errors}`,
    );
  }
  console.log(`\nwrote ${jsonPath}, ${mdPath} · transcripts in ${runDir}/transcripts (${cachedN} cached)`);
}

/** Read a results file, failing with the file name rather than a bare JSON or property error. */
function loadResults(file: string): RunResult {
  if (!existsSync(file)) throw new Error(`results file not found: ${file}`);
  let r: RunResult;
  try {
    r = JSON.parse(readFileSync(file, "utf8")) as RunResult;
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (!r || !Array.isArray(r.results) || !Array.isArray(r.scores) || !Array.isArray(r.models))
    throw new Error(`${file} does not look like a drainbench results file (expected results, scores, models)`);
  return r;
}

function cmdReport(argv: string[]) {
  const [file] = argv;
  if (!file) throw new Error("usage: drainbench report <results.json>");
  console.log(markdownReport(loadResults(file)));
}

function cmdLeaderboard(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: "string", short: "o" }, title: { type: "string" } },
  });
  if (!positionals.length) throw new Error("usage: drainbench leaderboard <results.json...> [-o out.html]");
  const runs = positionals.map(loadResults);
  const out = values.out ?? "site/index.html";
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, leaderboardHtml(runs, { title: values.title }));
  console.log(`wrote ${out}`);
}

function cmdValidate(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { scenarios: { type: "string" } } });
  const c = loadCorpus(values.scenarios ?? DEFAULT_CORPUS);
  const counts: Record<string, number> = {};
  for (const s of c.scenarios) counts[s.category] = (counts[s.category] ?? 0) + 1;
  console.log(`ok · ${c.scenarios.length} scenarios · ${c.version}`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${CATEGORY_LABELS[k as keyof typeof CATEGORY_LABELS].padEnd(26)} ${v}`);
}

function cmdList(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { scenarios: { type: "string" } } });
  for (const s of loadCorpus(values.scenarios ?? DEFAULT_CORPUS).scenarios)
    console.log(`${s.id.padEnd(16)} ${s.kind.padEnd(7)} ${s.title}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "run":
      return cmdRun(rest);
    case "report":
      return cmdReport(rest);
    case "leaderboard":
      return cmdLeaderboard(rest);
    case "validate":
      return cmdValidate(rest);
    case "list":
      return cmdList(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(HELP);
      throw new Error(`unknown command "${cmd}"`);
  }
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
