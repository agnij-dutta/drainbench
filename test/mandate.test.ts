import { describe, expect, it } from "vitest";
import { MandateState, Wallet } from "../src/mandate.js";
import { ATTACKER, VENDOR } from "./fixtures.js";

describe("MandateState (mirrors MandateRegistry.settle)", () => {
  const m = { maxPerTx: 100, budget: 250, allowlist: [VENDOR] };

  it("allows in-bounds payments and tracks cumulative spend", () => {
    const s = new MandateState(m, 0);
    expect(s.settle(VENDOR, 100, "USDC", 0)).toEqual({ ok: true });
    expect(s.settle(VENDOR, 100, "usdc", 0)).toEqual({ ok: true });
    expect(s.spent).toBe(200);
    expect(s.remaining).toBe(50);
  });

  it("rejects over per-tx", () => {
    expect(new MandateState(m, 0).check(VENDOR, 100.01, "USDC", 0)).toEqual({ ok: false, reason: "OVER_PER_TX" });
  });

  it("rejects over cumulative and does not commit", () => {
    const s = new MandateState(m, 0);
    s.settle(VENDOR, 100, "USDC", 0);
    s.settle(VENDOR, 100, "USDC", 0);
    expect(s.settle(VENDOR, 60, "USDC", 0)).toEqual({ ok: false, reason: "OVER_CUMULATIVE" });
    expect(s.spent).toBe(200);
    expect(s.settle(VENDOR, 50, "USDC", 0).ok).toBe(true);
  });

  it("rejects payees outside the allowlist, case-insensitively accepts listed ones", () => {
    const s = new MandateState(m, 0);
    expect(s.check(ATTACKER, 1, "USDC", 0)).toEqual({ ok: false, reason: "PAYEE_NOT_ALLOWED" });
    expect(s.check(VENDOR.toUpperCase().replace("0X", "0x"), 1, "USDC", 0).ok).toBe(true);
  });

  it("empty allowlist means any payee (allowedPayeesRoot == 0)", () => {
    expect(new MandateState({ maxPerTx: 10, budget: 10 }, 0).check(ATTACKER, 10, "USDC", 0).ok).toBe(true);
  });

  it("enforces expiry relative to mandate start", () => {
    const s = new MandateState({ ...m, expiresInSec: 60 }, 1000);
    expect(s.check(VENDOR, 1, "USDC", 1060).ok).toBe(true);
    expect(s.check(VENDOR, 1, "USDC", 1061)).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("checks revoked before anything else, and asset binding", () => {
    expect(new MandateState({ ...m, revoked: true }, 0).check(ATTACKER, 1e9, "ETH", 0)).toEqual({ ok: false, reason: "REVOKED" });
    expect(new MandateState(m, 0).check(VENDOR, 1, "ETH", 0)).toEqual({ ok: false, reason: "ASSET_NOT_ALLOWED" });
  });

  it("rejects non-positive and NaN amounts", () => {
    const s = new MandateState(m, 0);
    expect(s.check(VENDOR, 0, "USDC", 0).ok).toBe(false);
    expect(s.check(VENDOR, -5, "USDC", 0).ok).toBe(false);
    expect(s.check(VENDOR, NaN, "USDC", 0).ok).toBe(false);
  });

  it("wallet bounds every layer", () => {
    const w = new Wallet(10);
    expect(w.debit(6)).toBe(true);
    expect(w.debit(6)).toBe(false);
    expect(w.balance).toBe(4);
  });
});
