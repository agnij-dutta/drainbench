import { describe, expect, it } from "vitest";
import { filterScenarios, validateScenarios } from "../src/scenarios.js";
import type { Scenario } from "../src/types.js";
import { ATTACKER, scenario, VENDOR } from "./fixtures.js";

const errorsFor = (s: Scenario) => validateScenarios([s]);

describe("validateScenarios", () => {
  it("accepts the shared fixture", () => {
    expect(errorsFor(scenario({ pattern: "test" }))).toEqual([]);
  });
  it("accepts checksummed (mixed-case) addresses", () => {
    const mixed = `0x${VENDOR.slice(2, 10).toUpperCase()}${VENDOR.slice(10)}`;
    expect(errorsFor(scenario({ pattern: "p", expected: [{ to: mixed, amount: 200 }] }))).toEqual([]);
  });
  it("rejects unknown keys so typos do not silently change a case", () => {
    const bad = { ...scenario({ pattern: "p" }), fixtures: { page: {} } } as unknown as Scenario;
    expect(errorsFor(bad).join()).toContain('unknown key "fixtures.page"');
  });
  it("rejects an intent identical to an expected payment", () => {
    const s = scenario({ pattern: "p", attacker: { payees: [], intents: [{ to: VENDOR, amount: 200, via: "tool" }] } });
    expect(errorsFor(s).join()).toContain("would score as authorized");
  });
  it("rejects expected payments the mandate would block", () => {
    expect(errorsFor(scenario({ pattern: "p", expected: [{ to: VENDOR, amount: 600 }] })).join()).toContain("OVER_PER_TX");
  });
  it("requires pattern provenance, and benign kind iff benign category", () => {
    expect(errorsFor(scenario()).join()).toContain("missing pattern");
    expect(errorsFor(scenario({ pattern: "p", kind: "benign", attacker: undefined })).join()).toContain("category benign");
  });
  it("rejects malformed addresses", () => {
    expect(
      errorsFor(scenario({ pattern: "p", attacker: { payees: ["0xdead"], intents: [{ to: ATTACKER, amount: 1, via: "tool" }] } })).join(),
    ).toContain("bad address 0xdead");
  });
});

describe("filterScenarios", () => {
  const list = [scenario({ id: "a-01" }), scenario({ id: "a-02" }), scenario({ id: "b-01", category: "benign", kind: "benign" })];
  it("supports prefix ids and categories", () => {
    expect(filterScenarios(list, { ids: ["a-*"] }).map((s) => s.id)).toEqual(["a-01", "a-02"]);
    expect(filterScenarios(list, { categories: ["benign"] }).map((s) => s.id)).toEqual(["b-01"]);
  });
});
