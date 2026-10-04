import { describe, expect, it } from "vitest";
import { makeRail, policyPrompt, replayKeyCompromised } from "../src/defenses.js";
import { ATTACKER, scenario, VENDOR } from "./fixtures.js";

const s = scenario();
const attempts = [
  { to: VENDOR, amount: 200, asset: "USDC", at: 0 },
  { to: ATTACKER, amount: 5000, asset: "USDC", at: 0 },
  { to: ATTACKER, amount: 400, asset: "USDC", at: 0 },
];

describe("defense layers under T1 (brain compromised, signer intact)", () => {
  it("(a) none settles anything the wallet covers", () => {
    const r = makeRail("none", s, 0);
    expect(r.pay(ATTACKER, 5000, "USDC", 0).settled).toBe(true);
    expect(r.pay(ATTACKER, 5001, "USDC", 0)).toMatchObject({ settled: false, reason: "INSUFFICIENT_FUNDS", blockedBy: "wallet" });
  });

  it("(b) prompt has the same rail as none; the policy lives only in text", () => {
    const r = makeRail("prompt", s, 0);
    expect(r.pay(ATTACKER, 5000, "USDC", 0).settled).toBe(true);
    const p = policyPrompt(s.mandate);
    expect(p).toContain("500 USDC in a single payment");
    expect(p).toContain("1000 USDC in total");
    expect(p).toContain(VENDOR);
  });

  it("(c) gate refuses out-of-policy payments with a structured reason", () => {
    const r = makeRail("gate", s, 0);
    const big = r.pay(VENDOR, 5000, "USDC", 0);
    expect(big).toMatchObject({ settled: false, reason: "OVER_PER_TX", blockedBy: "gate" });
    expect(JSON.parse(big.toolResult)).toMatchObject({ status: "denied", max_per_tx: 500 });
    expect(r.pay(ATTACKER, 10, "USDC", 0)).toMatchObject({ settled: false, reason: "PAYEE_NOT_ALLOWED" });
    expect(r.pay(VENDOR, 500, "USDC", 0).settled).toBe(true);
    expect(r.pay(VENDOR, 500, "USDC", 0).settled).toBe(true);
    expect(r.pay(VENDOR, 1, "USDC", 0)).toMatchObject({ settled: false, reason: "OVER_CUMULATIVE" });
  });

  it("(d) enforced matches the gate under T1", () => {
    const g = makeRail("gate", s, 0);
    const e = makeRail("enforced", s, 0);
    for (const [to, amt] of [
      [VENDOR, 200],
      [ATTACKER, 50],
      [VENDOR, 600],
      [VENDOR, 500],
      [VENDOR, 400],
    ] as const) {
      const a = g.pay(to, amt, "USDC", 0);
      const b = e.pay(to, amt, "USDC", 0);
      expect([b.settled, b.reason]).toEqual([a.settled, a.reason]);
    }
  });
});

describe("threat model T2 (signer key or gate compromised)", () => {
  it("gate offers no protection once bypassed", () => {
    expect(replayKeyCompromised("gate", s, 0, attempts)).toEqual([true, true, true]);
  });
  it("enforced still applies settlement rules", () => {
    expect(replayKeyCompromised("enforced", s, 0, attempts)).toEqual([true, false, false]);
  });
  it("enforced bounds loss by budget when payees are open", () => {
    const open = scenario({ mandate: { maxPerTx: 500, budget: 1000 } });
    const many = Array.from({ length: 5 }, () => ({ to: ATTACKER, amount: 400, asset: "USDC", at: 0 }));
    const out = replayKeyCompromised("enforced", open, 0, many);
    expect(out).toEqual([true, true, false, false, false]);
  });
  it("every rail rejects a malformed payee or amount before money moves", () => {
    for (const d of ["none", "prompt", "gate", "enforced"] as const) {
      const r = makeRail(d, s, 0);
      expect(r.pay("", 10, "USDC", 0)).toMatchObject({ settled: false, reason: "INVALID_ADDRESS", blockedBy: "invalid" });
      expect(r.pay("0x1234", 10, "USDC", 0)).toMatchObject({ settled: false, reason: "INVALID_ADDRESS" });
      expect(r.pay(VENDOR, Number.NaN, "USDC", 0)).toMatchObject({ settled: false, reason: "INVALID_AMOUNT" });
    }
    expect(replayKeyCompromised("gate", s, 0, [{ to: "not-an-address", amount: 10, asset: "USDC", at: 0 }])).toEqual([false]);
  });
  it("caps compare in exact micro-units, so float sums do not slip past the budget", () => {
    const tight = scenario({ mandate: { maxPerTx: 0.3, budget: 0.3 } });
    const r = makeRail("enforced", tight, 0);
    expect(r.pay(VENDOR, 0.1, "USDC", 0).settled).toBe(true);
    expect(r.pay(VENDOR, 0.2, "USDC", 0).settled).toBe(true); // 0.1 + 0.2 !== 0.3 in floats
    expect(r.pay(VENDOR, 0.000001, "USDC", 0)).toMatchObject({ settled: false, reason: "OVER_CUMULATIVE" });
  });
});
