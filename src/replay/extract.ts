/**
 * RawTx -> KRC-20 op candidates. Mirrors go-krc20d explorer/script.go parseOpData (lines 826-927)
 * and the pre-validation it does before the contract's init():
 *  - parser chosen by accepting-block DAA (legacy < 97,539,090 <= current; bound-P2SH check >= 408,300,500);
 *  - JSON object; non-string values dropped, but a non-string value for a "forced compatible" key ignores the op (script.go:25, 866-879);
 *  - from = address of the envelope's key / multisig script hash;
 *  - mainnet DAA <= 83,525,600: to = output[0] address (script.go:881-883);
 *  - p must be "KRC-20" (case-insensitive), op 1..16 ascii (lower-cased), to ascii if present;
 *  - tick normalized with validateTickTxId, ca with validateTxId (script.go:887-888);
 *  - only input 0 may carry an op unless the contract marks it isRecycle (send), enforced in the engine.
 * Payload ops (DAA >= 2026Q1, script.go:744-824) are handled by extractPayloadOp.
 */
import { parseForDaa, HF_DAA_2026Q1, HF_DAA_SCRIPT_PARSER_FIX, parseScriptInputScriptSig, parseScriptInputScriptSigLegacy } from "../script/parse.js";
import { spkToAddr } from "../script/address.js";
import type { OpCandidate, RawInput, RawTx } from "./types.js";

const FORCED = new Set(["from", "to", "tick", "max", "lim", "pre", "dec", "amt", "utxo", "price", "mod", "name", "ca"]);

function toStringMap(json: string): Record<string, string> | null {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
    else if (FORCED.has(k)) return null;
  }
  return out;
}

const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);
export function normTick(t: string | undefined): string | undefined {
  if (t === undefined) return undefined;
  if (t.length === 64) return /^[0-9a-fA-F]{64}$/.test(t) ? t.toLowerCase() : "";
  const u = t.toUpperCase();
  return /^[A-Z]{4,6}$/.test(u) ? u : "";
}

function prevalidate(d: Record<string, string>): boolean {
  if (d.p === undefined || d.p.toUpperCase() !== "KRC-20") return false;
  d.p = "KRC-20";
  if (d.op === undefined) return false;
  d.op = d.op.toLowerCase();
  if (d.op.length < 1 || d.op.length > 16 || !isAscii(d.op)) return false;
  if (d.to !== undefined && d.to !== "" && !isAscii(d.to)) return false;
  if (d.tick !== undefined) d.tick = normTick(d.tick)!;
  if (d.ca !== undefined) d.ca = /^[0-9a-fA-F]{64}$/.test(d.ca) ? d.ca.toLowerCase() : "";
  return true;
}

/** Input by its real index (arrays may be sparse extracts or position-shifted). */
export const inputAt = (inputs: RawInput[], index: number): RawInput | undefined =>
  inputs[index]?.index === index ? inputs[index] : inputs.find((x) => x && x.index === index);

export function txFee(tx: RawTx): bigint | null {
  let inSum = 0n;
  for (const i of tx.inputs) {
    if (i.prevAmount === null) return null;
    inSum += i.prevAmount;
  }
  const outSum = tx.outputs.reduce((a, o) => a + o.amount, 0n);
  return inSum > outSum ? inSum - outSum : 0n;
}

export function extractOps(tx: RawTx, testnet = false): OpCandidate[] {
  const ops: OpCandidate[] = [];
  const daa = tx.accept.daaScore;
  let spkFrom0 = "";
  // Use the input's real index, not its array position: sparse extracts (the dump keeps only inputs
  // whose script matches the filter) would otherwise shift an envelope at input k>0 to position 0.
  tx.inputs.forEach((input, pos) => {
    const i = Number.isInteger(input.index) ? input.index : pos;
    const env = parseForDaa(input.sig, daa, input.prevSpk);
    if (!env || env.from === "") return;
    const d = toStringMap(env.json);
    if (!d) return;
    d.from = env.from;
    if (!testnet && daa <= 83_525_600 && tx.outputs.length > 0) d.to = tx.outputs[0].address;
    if (!prevalidate(d)) return;
    if (i === 0) spkFrom0 = env.scriptSig;
    ops.push({
      txId: tx.txId, daaScore: daa, blueScore: tx.accept.blueScore, blockTime: tx.blockTime, inputIndex: i, isPayload: false,
      from: env.from, spkFrom: i === 0 ? env.scriptSig : "", params: d, fee: txFee(tx), outputs: tx.outputs, inputs: tx.inputs,
    });
  });
  for (const o of ops) if (o.inputIndex === 0) o.spkFrom = spkFrom0;
  const p = extractPayloadOp(tx);
  if (p) ops.push(p);
  return ops;
}

/** script.go:744-824 (non-coinbase payload ops only; op-rollup coinbase path is out of scope). */
export function extractPayloadOp(tx: RawTx): OpCandidate | null {
  const daa = tx.accept.daaScore;
  if (daa < HF_DAA_2026Q1 || !tx.payload || tx.inputs.length === 0) return null;
  let d: Record<string, string> | null;
  try {
    const parsed = JSON.parse(Buffer.from(tx.payload, "hex").toString("utf8"));
    // Go unmarshals into map[string]string: any non-string value makes Unmarshal fail.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((v) => typeof v !== "string")) return null;
    d = parsed as Record<string, string>;
  } catch { return null; }
  const in0 = tx.inputs.find((x) => x.index === 0);
  if (!in0) return null;
  if (!in0.prevSpk) return null; // needs the spent UTXO's script (resolve_previous_outpoints)
  let spkFrom = in0.prevSpk;
  if (in0.prevSpk.startsWith("aa20") && in0.prevSpk.length === 70) {
    const s = daa >= HF_DAA_SCRIPT_PARSER_FIX ? parseScriptInputScriptSig(in0.sig) : parseScriptInputScriptSigLegacy(in0.sig);
    spkFrom = s.scriptSig;
  }
  d.from = spkToAddr(in0.prevSpk);
  if (!prevalidate(d)) return null;
  return {
    txId: tx.txId, daaScore: daa, blueScore: tx.accept.blueScore, blockTime: tx.blockTime, inputIndex: 0, isPayload: true,
    from: d.from, spkFrom, params: d, fee: txFee(tx), outputs: tx.outputs, inputs: tx.inputs,
  };
}
