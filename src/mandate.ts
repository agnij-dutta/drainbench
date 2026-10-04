// A faithful in-process simulation of Capline's enforcement rules.
//
// Capline (github.com/agnij-dutta/capline) enforces a spend mandate in two
// layers:
//   Layer A, the Constrained Signer: an off-chain process holding the key that
//     only signs when checkAllowance() passes and the payee is allowed.
//   Layer B, MandateRegistry.settle(): the on-chain backstop that re-checks
//     every rule and reverts before USDC moves, even with a stolen key.
//
// Both layers share the same rule set, reproduced here in the same order as
// MandateRegistry.sol: revoked -> expired -> per-tx -> cumulative -> payee.
// Asset is checked first because a mandate is bound to one token contract.

import type { Mandate } from "./types.js";

export type DenyReason =
  | "REVOKED"
  | "EXPIRED"
  | "ASSET_NOT_ALLOWED"
  | "OVER_PER_TX"
  | "OVER_CUMULATIVE"
  | "PAYEE_NOT_ALLOWED"
  | "INVALID_AMOUNT"
  | "INSUFFICIENT_FUNDS";

export type CheckResult = { ok: true } | { ok: false; reason: DenyReason };

export const normAddr = (a: string) => String(a ?? "").trim().toLowerCase();
export const normAsset = (a: string | undefined) => String(a ?? "USDC").trim().toUpperCase();

/** Mutable mandate state: cumulative spend, as `spent[mandateId]` on-chain. */
export class MandateState {
  spent = 0;
  constructor(
    readonly mandate: Mandate,
    /** absolute unix seconds when the scenario started (mandate creation). */
    readonly startedAt: number,
  ) {}

  get expiry(): number {
    return this.mandate.expiresInSec === undefined ? 0 : this.startedAt + this.mandate.expiresInSec;
  }

  get remaining(): number {
    return Math.max(0, this.mandate.budget - this.spent);
  }

  /** Pure check, no state change. Mirrors checkAllowance + the payee guard in settle(). */
  check(to: string, amount: number, asset: string | undefined, now: number): CheckResult {
    const m = this.mandate;
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "INVALID_AMOUNT" };
    if (m.revoked) return { ok: false, reason: "REVOKED" };
    if (this.expiry !== 0 && now > this.expiry) return { ok: false, reason: "EXPIRED" };
    if (normAsset(asset) !== normAsset(m.asset)) return { ok: false, reason: "ASSET_NOT_ALLOWED" };
    if (amount > m.maxPerTx) return { ok: false, reason: "OVER_PER_TX" };
    if (this.spent + amount > m.budget + 1e-9) return { ok: false, reason: "OVER_CUMULATIVE" };
    const allow = (m.allowlist ?? []).map(normAddr);
    if (allow.length > 0 && !allow.includes(normAddr(to))) return { ok: false, reason: "PAYEE_NOT_ALLOWED" };
    return { ok: true };
  }

  /** check + commit, atomically, like settle(). */
  settle(to: string, amount: number, asset: string | undefined, now: number): CheckResult {
    const r = this.check(to, amount, asset, now);
    if (r.ok) this.spent += amount;
    return r;
  }
}

/** A wallet with a balance. Every layer, including "none", is bounded by it. */
export class Wallet {
  constructor(public balance: number) {}
  debit(amount: number): boolean {
    if (amount > this.balance + 1e-9) return false;
    this.balance -= amount;
    return true;
  }
}
