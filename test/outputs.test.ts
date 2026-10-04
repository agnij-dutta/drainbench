import { describe, expect, it } from "vitest";
import { runAll } from "../src/harness.js";
import { leaderboardHtml } from "../src/leaderboard.js";
import { MockProvider } from "../src/providers/mock.js";
import { markdownReport } from "../src/report.js";
import { scoreTranscript, summarize } from "../src/score.js";
import { DEFENSES, type RunResult } from "../src/types.js";
import { scenario } from "./fixtures.js";

async function mockRun(): Promise<RunResult> {
  const scenarios = [scenario(), scenario({ id: "b-01", kind: "benign", category: "benign", attacker: undefined })];
  const providers = [new MockProvider("naive"), new MockProvider("oracle")];
  const ts = await runAll({ providers, defenses: [...DEFENSES], scenarios });
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const scores = ts.map((t) => scoreTranscript(t, byId.get(t.scenarioId)!));
  const models = providers.map((p) => p.id);
  return {
    runId: "t",
    createdAt: "",
    harnessVersion: "x",
    corpusVersion: "c",
    scenarioCount: 2,
    models,
    defenses: [...DEFENSES],
    synthetic: true,
    results: summarize(scores, scenarios, models, [...DEFENSES]),
    scores,
  };
}

describe("outputs", () => {
  it("summarize yields one row per model x defense", async () => {
    const r = await mockRun();
    expect(r.results).toHaveLength(8);
    const naiveNone = r.results.find((x) => x.model === "mock:naive" && x.defense === "none")!;
    const naiveEnf = r.results.find((x) => x.model === "mock:naive" && x.defense === "enforced")!;
    expect(naiveNone.metrics.fundsLostRate).toBe(1);
    expect(naiveEnf.metrics.fundsLostRate).toBe(0);
    expect(naiveEnf.metrics.attackSuccessRate).toBe(1);
  });
  it("markdown report and leaderboard render without em dashes and flag synthetic runs", async () => {
    const r = await mockRun();
    const md = markdownReport(r);
    const html = leaderboardHtml([r]);
    for (const s of [md, html]) expect(s).not.toContain("\u2014");
    expect(md).toContain("MOCK RESULTS");
    expect(md).toContain("mock:naive (MOCK)");
    expect(html).toContain("MOCK RESULTS");
    expect(html).toContain('<span class="tag">MOCK</span>');
    expect(html).toContain("mock:naive");
    expect(html).toContain("Enforced cap (Capline)");
  });
  it("labels mock rows even when merged with a real run, and keeps them out of the headline", async () => {
    const mock = await mockRun();
    const rename = (m: string) => (m === "mock:oracle" ? "acme:real-model" : m);
    const real: RunResult = {
      ...mock,
      runId: "real",
      synthetic: false,
      models: ["acme:real-model"],
      results: mock.results.filter((x) => x.model === "mock:oracle").map((x) => ({ ...x, model: rename(x.model) })),
    };
    const html = leaderboardHtml([mock, real]);
    expect(html).toContain("MOCK RESULTS");
    expect(html).toMatch(/mock:naive <span class="tag">MOCK<\/span>/);
    expect(html).not.toMatch(/acme:real-model <span class="tag">/);
    // the oracle-like real row lost nothing; the naive mock row must not leak into "worst model"
    const hero = html.slice(html.indexOf('<section class="hero">'), html.indexOf("</section>"));
    expect(hero).toContain("acme:real-model");
    expect(hero).not.toContain("mock:naive");
  });
});
