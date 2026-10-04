import { describe, expect, it } from "vitest";
import { runAll } from "../src/harness.js";
import { MockProvider } from "../src/providers/mock.js";
import { loadCorpus, stratifiedSample } from "../src/scenarios.js";
import { scoreTranscript, summarize } from "../src/score.js";
import { CATEGORIES, DEFENSES } from "../src/types.js";

const corpus = loadCorpus("scenarios/v1");

describe("scenario corpus v1", () => {
  it("has 60 attack cases over 10 categories and 15 benign controls", () => {
    const atk = corpus.scenarios.filter((s) => s.kind === "attack");
    expect(atk).toHaveLength(60);
    expect(corpus.scenarios.filter((s) => s.kind === "benign")).toHaveLength(15);
    for (const c of CATEGORIES.filter((c) => c !== "benign")) expect(atk.filter((s) => s.category === c).length).toBe(6);
  });

  it("stratified sampling covers every category", () => {
    const s = stratifiedSample(corpus.scenarios, 11);
    expect(new Set(s.map((x) => x.category)).size).toBe(11);
  });

  it("is internally consistent: the oracle completes every task under every defense and never loses money", async () => {
    const ts = await runAll({
      providers: [new MockProvider("oracle"), new MockProvider("naive")],
      defenses: [...DEFENSES],
      scenarios: corpus.scenarios,
      concurrency: 8,
    });
    const byId = new Map(corpus.scenarios.map((s) => [s.id, s]));
    const scores = ts.map((t) => scoreTranscript(t, byId.get(t.scenarioId)!));
    const res = summarize(scores, corpus.scenarios, ["mock:oracle", "mock:naive"], [...DEFENSES]);
    for (const r of res.filter((x) => x.model === "mock:oracle")) {
      expect(r.metrics.benignSuccessRate).toBe(1);
      expect(r.metrics.utilityUnderAttack).toBe(1);
      expect(r.metrics.usdLost).toBe(0);
    }
    // every attack, followed blindly, actually moves money when nothing stops it
    const naiveNone = res.find((x) => x.model === "mock:naive" && x.defense === "none")!;
    expect(naiveNone.metrics.fundsLostRate).toBe(1);
    // the enforced cap never does worse than the gate, and is immune to key compromise beyond its rules
    const gate = res.find((x) => x.model === "mock:naive" && x.defense === "gate")!.metrics;
    const enf = res.find((x) => x.model === "mock:naive" && x.defense === "enforced")!.metrics;
    expect(enf.usdLost).toBeLessThanOrEqual(gate.usdLost);
    expect(enf.usdLostKeyCompromised).toBe(enf.usdLost);
    expect(gate.usdLostKeyCompromised).toBeGreaterThan(gate.usdLost);
    // loss under the enforced cap never exceeds any scenario's budget
    for (const s of scores.filter((x) => x.defense === "enforced"))
      expect(s.usdLost).toBeLessThanOrEqual(byId.get(s.scenarioId)!.mandate.budget);
  });
});
