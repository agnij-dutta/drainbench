// An in-process simulation of Capline's spend-mandate rules.
//
// Capline (https://github.com/agnij-dutta/capline) enforces a mandate in two
// layers:
//   Layer A, the Constrained Signer: an off-chain process holding the key. It
//     only signs when checkAllowance() passes and the payee is allowed.
//   Layer B, MandateRegistry.settle(): the on-chain backstop. It re-checks
//     every rule and reverts before USDC moves, even when the key is stolen.
//
// Rule order follows MandateRegistry.settle() (checked against Capline commit
// f5f3e7c, contracts/src/MandateRegistry.sol):
//   revoked -> expired -> per-tx -> cumulative -> payee
// Drainbench adds three checks that the contract gets for free from its types
// and wiring, so a simulated payment can never be "more valid" than a real one:
//   - INVALID_AMOUNT: settle() takes a uint256, so zero, negative or NaN
//     amounts cannot be encoded. Checked first.
//   - INVALID_ADDRESS: settle() takes an `address`, so a payee that is not
//     0x + 40 hex cannot be encoded. Checked first.
//   - ASSET_NOT_ALLOWED: the registry is bound to one USDC contract
//     (`usdc` is immutable), so a payment in any other asset cannot route
//     through settle(). Checked after expiry, before the caps.
// Capline reverts with one CapExceeded error for both caps; checkAllowance()
// distinguishes OVER_PER_TX and OVER_CUMULATIVE, and so do we.
//
// Amounts are tracked as integer micro-units (6 decimals, like USDC's uint256)
// so cap comparisons are exact, as they are on-chain.

import type { Mandate } from "./types.js";

export type DenyReason =
  | "REVOKED"
  | "EXPIRED"
  | "ASSET_NOT_ALLOWED"
  | "OVER_PER_TX"
  | "OVER_CUMULATIVE"
  | "PAYEE_NOT_ALLOWED"
  | "INVALID_AMOUNT"
  | "INVALID_ADDRESS"
  | "INSUFFICIENT_FUNDS";

export type CheckResult = { ok: true } | { ok: false; reason: DenyReason };

/** Lowercased, trimmed address for comparisons. EVM addresses are case-insensitive. */
export const normAddr = (a: string) =>
  String(a ?? "")
    .trim()
    .toLowerCase();

/** Uppercased asset symbol. Omitted means USDC. */
export const normAsset = (a: string | undefined) =>
  String(a ?? "USDC")
    .trim()
    .toUpperCase();

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** True for a well-formed EVM address (0x + 40 hex, any case). */
export const isAddress = (a: string) => ADDRESS_RE.test(normAddr(a));

/** USD amount to integer micro-units (6 decimals). */
export const toMicro = (usd: number) => Math.round(usd * 1e6);
const fromMicro = (micro: number) => micro / 1e6;

/** Rejections every rail shares, mandate or not: unencodable amount or payee. */
export function checkEncodable(to: string, amount: number): CheckResult {
  if (!Number.isFinite(amount) || toMicro(amount) <= 0) return { ok: false, reason: "INVALID_AMOUNT" };
  if (!isAddress(to)) return { ok: false, reason: "INVALID_ADDRESS" };
  return { ok: true };
}

/**
 * Mutable mandate state: the mandate plus cumulative spend, the equivalent of
 * `mandates[id]` and `spent[id]` in MandateRegistry.
 */
export class MandateState {
  private spentMicro = 0;

  constructor(
    readonly mandate: Mandate,
    /** absolute unix seconds when the scenario started (mandate creation). */
    readonly startedAt: number,
  ) {}

  /** Cumulative settled spend in USD. */
  get spent(): number {
    return fromMicro(this.spentMicro);
  }

  /** Absolute expiry in unix seconds, or 0 for no expiry (as on-chain). */
  get expiry(): number {
    return this.mandate.expiresInSec === undefined ? 0 : this.startedAt + this.mandate.expiresInSec;
  }

  /** Budget left before OVER_CUMULATIVE, in USD. */
  get remaining(): number {
    return fromMicro(Math.max(0, toMicro(this.mandate.budget) - this.spentMicro));
  }

  /**
   * Pure check, no state change. Mirrors checkAllowance() plus the payee guard
   * in settle(). `now` is unix seconds; expiry is inclusive (`now > expiry`
   * fails), matching `block.timestamp > m.expiry`.
   */
  check(to: string, amount: number, asset: string | undefined, now: number): CheckResult {
    const enc = checkEncodable(to, amount);
    if (!enc.ok) return enc;
    const m = this.mandate;
    const micro = toMicro(amount);
    if (m.revoked) return { ok: false, reason: "REVOKED" };
    if (this.expiry !== 0 && now > this.expiry) return { ok: false, reason: "EXPIRED" };
    if (normAsset(asset) !== normAsset(m.asset)) return { ok: false, reason: "ASSET_NOT_ALLOWED" };
    if (micro > toMicro(m.maxPerTx)) return { ok: false, reason: "OVER_PER_TX" };
    if (this.spentMicro + micro > toMicro(m.budget)) return { ok: false, reason: "OVER_CUMULATIVE" };
    const allow = (m.allowlist ?? []).map(normAddr);
    if (allow.length > 0 && !allow.includes(normAddr(to))) return { ok: false, reason: "PAYEE_NOT_ALLOWED" };
    return { ok: true };
  }

  /** Record spend without re-checking. Use only after a passing check(). */
  commit(amount: number): void {
    this.spentMicro += toMicro(amount);
  }

  /** check() and commit() atomically, like settle(): effects only on success. */
  settle(to: string, amount: number, asset: string | undefined, now: number): CheckResult {
    const r = this.check(to, amount, asset, now);
    if (r.ok) this.commit(amount);
    return r;
  }
}

/** A wallet with a balance in USD. Every layer, including "none", is bounded by it. */
export class Wallet {
  private micro: number;

  constructor(balance: number) {
    this.micro = toMicro(balance);
  }

  get balance(): number {
    return fromMicro(this.micro);
  }

  /** True when the wallet can cover `amount`. */
  covers(amount: number): boolean {
    return toMicro(amount) <= this.micro;
  }

  /** Debit `amount` if covered. Returns false and changes nothing otherwise. */
  debit(amount: number): boolean {
    if (!this.covers(amount)) return false;
    this.micro -= toMicro(amount);
    return true;
  }
}
