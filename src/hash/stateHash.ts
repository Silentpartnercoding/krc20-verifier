/**
 * OPI-style chained event hashes for KRC-20 (design: docs/state-hashes.md, version "krc20-sh-v1").
 *
 * Unit = one accepting chain block, keyed by its accepting DAA score (the DAA part of a Kasplex opScore,
 * opScore = daa*10000 + index). Only units with >= 1 accepted op are emitted (sparse chain).
 *
 *   eventString   fields joined by ";"            (see eventString below)
 *   unitString    "krc20-sh-v1;<daa>" + "|" + events joined by "|"
 *   unitHash      sha256_hex(utf8(unitString))
 *   cumulative    sha256_hex(utf8(prevCumulative + unitHash)), prevCumulative = "" for the first unit
 *
 * Pure functions only; no I/O. Used by the replay (pipeline/run.ts --state-hashes) and by the
 * claim-side hasher (pipeline/claimHashes.ts) so both sides share one canonicalisation.
 */
import { createHash } from "node:crypto";

export const STATE_HASH_VERSION = "krc20-sh-v1";
export const EVENT_SEPARATOR = "|";
export const FIELD_SEPARATOR = ";";

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** One accepted KRC-20 op, normalised. Fields not used by an op type are ignored. */
export interface Krc20Event {
  op: string; txId: string; tick: string;
  from?: string; to?: string; amt?: string; utxo?: string;
  max?: string; lim?: string; pre?: string; dec?: string; mod?: string;
}

const clean = (v: string | undefined, name: string): string => {
  const s = v ?? "";
  if (s.includes(FIELD_SEPARATOR) || s.includes(EVENT_SEPARATOR) || /[\t\n]/.test(s)) throw new Error(`separator in field ${name}: ${s}`);
  return s;
};

/** Canonical event string. Tick upper-case (Kasplex stores ticks upper-case); amounts are integer strings in base units. */
export function eventString(e: Krc20Event): string {
  const t = clean(e.tick, "tick").toUpperCase();
  const f = (k: keyof Krc20Event) => clean(e[k], k);
  let parts: string[];
  switch (e.op) {
    case "deploy": parts = ["deploy", f("txId"), f("from"), t, f("max"), f("lim"), f("pre") || "0", f("dec") || "8", f("to"), f("mod")]; break;
    case "mint": parts = ["mint", f("txId"), f("to"), t, f("amt")]; break;
    case "transfer": parts = ["transfer", f("txId"), f("from"), f("to"), t, f("amt")]; break;
    case "list": parts = ["list", f("txId"), f("from"), t, f("amt"), f("utxo")]; break;
    case "send": parts = ["send", f("txId"), f("from"), f("to"), t, f("amt")]; break;
    case "burn": parts = ["burn", f("txId"), f("from"), t, f("amt")]; break;
    case "chown": parts = ["chown", f("txId"), f("from"), f("to"), t]; break;
    default: throw new Error(`no canonical event string for op ${e.op} (v1 covers deploy/mint/transfer/list/send/burn/chown)`);
  }
  return parts.join(FIELD_SEPARATOR);
}

export function unitString(daa: number | string, events: string[]): string {
  return [`${STATE_HASH_VERSION}${FIELD_SEPARATOR}${daa}`, ...events].join(EVENT_SEPARATOR);
}

export interface UnitHash { daa: string; nEvents: number; unitHash: string; cumulative: string; chainBlock: string }

/** Streams units in strictly increasing DAA order and chains them. */
export class StateHasher {
  private cur: { daa: string; chainBlock: string; events: string[] } | null = null;
  private lastDaa = -1n;
  cumulative = "";
  units = 0; events = 0;
  constructor(private readonly emit: (u: UnitHash) => void) {}

  add(daa: number | string, chainBlock: string, e: Krc20Event) {
    const d = String(daa);
    if (!this.cur || this.cur.daa !== d) {
      this.flush();
      if (BigInt(d) <= this.lastDaa) throw new Error(`units out of order: ${d} after ${this.lastDaa}`);
      this.lastDaa = BigInt(d);
      this.cur = { daa: d, chainBlock, events: [] };
    } else if (chainBlock && this.cur.chainBlock && chainBlock !== this.cur.chainBlock) {
      throw new Error(`DAA ${d} maps to two chain blocks ${this.cur.chainBlock} / ${chainBlock}`);
    }
    this.cur.events.push(eventString(e));
  }

  flush() {
    if (!this.cur) return;
    const unitHash = sha256Hex(unitString(this.cur.daa, this.cur.events));
    this.cumulative = sha256Hex(this.cumulative + unitHash);
    this.units++; this.events += this.cur.events.length;
    this.emit({ daa: this.cur.daa, nEvents: this.cur.events.length, unitHash, cumulative: this.cumulative, chainBlock: this.cur.chainBlock });
    this.cur = null;
  }
}

/** Balance-state hash: non-zero holders, sorted by address (byte order), "TICK;address;balance;locked" joined by "|". */
export function balanceStateHash(tick: string, holders: { address: string; balance: bigint | string; locked: bigint | string }[]): { hash: string; n: number } {
  const lines = holders
    .filter((h) => BigInt(h.balance) !== 0n || BigInt(h.locked) !== 0n)
    .map((h) => [tick.toUpperCase(), clean(h.address, "address"), BigInt(h.balance).toString(), BigInt(h.locked).toString()].join(FIELD_SEPARATOR))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { hash: sha256Hex(`${STATE_HASH_VERSION}-balances${EVENT_SEPARATOR}${lines.join(EVENT_SEPARATOR)}`), n: lines.length };
}

/** Open-order hash: "TICK;from;listTxId;tamt" sorted, joined by "|". */
export function marketStateHash(tick: string, orders: { from: string; listTxId: string; tamt: bigint | string }[]): { hash: string; n: number } {
  const lines = orders.map((o) => [tick.toUpperCase(), clean(o.from, "from"), clean(o.listTxId, "listTxId"), BigInt(o.tamt).toString()].join(FIELD_SEPARATOR))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { hash: sha256Hex(`${STATE_HASH_VERSION}-markets${EVENT_SEPARATOR}${lines.join(EVENT_SEPARATOR)}`), n: lines.length };
}

export const UNIT_COLS = ["daa", "nEvents", "unitHash", "cumulative", "chainBlock"] as const;
export const unitRow = (u: UnitHash) => [u.daa, u.nEvents, u.unitHash, u.cumulative, u.chainBlock].join("\t");
