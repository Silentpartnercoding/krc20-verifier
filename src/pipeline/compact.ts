/**
 * Compact per-transaction candidate records for the streaming NACHO pipeline.
 * A full replay has ~10.9M reveal txs; holding RawTx objects (with signature scripts) for all of them
 * does not fit in memory, so prep.ts parses each tx once (with its exact accepting DAA) and writes one
 * line per tx that carries only what the rule engine reads from a candidate:
 *   outputs[0] (list utxo, send price), outputs[1] (send to), outputs.length > 0 / > 1,
 *   inputs[inputIndex].prevTxId (send utxo), fee, spkFrom, from, params.
 * Line format: `<blueScore zero-padded 12>\t<txId>\t<json>` so `sort` yields replay order
 * (accepting blue score, then tx id; intra-block order is not recoverable, see blindSpot).
 */
import type { OpCandidate, RawTx, RawOutput, RawInput } from "../replay/types.js";
import { inputAt } from "../replay/extract.js";

export interface CompactTx {
  id: string; b: number; d: number; h: string; bt: number;
  fee: string | null; no: number; o: [string, string][]; // first two outputs: [amount, address]
  c: { i: number; pay: boolean; from: string; spk: string; p: Record<string, string>; prev: string }[];
}

export function toCompact(tx: RawTx, ops: OpCandidate[]): CompactTx {
  return {
    id: tx.txId, b: tx.accept.blueScore, d: tx.accept.daaScore, h: tx.accept.blockHash, bt: tx.blockTime,
    fee: ops[0]?.fee === null || ops[0]?.fee === undefined ? null : ops[0].fee.toString(),
    no: tx.outputs.length,
    o: tx.outputs.slice(0, 2).map((x) => [x.amount.toString(), x.address]),
    c: ops.map((op) => ({ i: op.inputIndex, pay: op.isPayload, from: op.from, spk: op.spkFrom, p: op.params, prev: inputAt(op.inputs, op.inputIndex)?.prevTxId ?? "" })),
  };
}

export function compactLine(c: CompactTx): string {
  return `${String(c.b).padStart(12, "0")}\t${c.id}\t${JSON.stringify(c)}`;
}

/** Rebuild engine candidates. outputs is truncated to the first two (all the engine reads; length checks are only > 0 / > 1). */
export function fromCompact(c: CompactTx): OpCandidate[] {
  const outputs: RawOutput[] = c.o.map(([amt, addr], index) => ({ index, amount: BigInt(amt), spk: "", address: addr }));
  const fee = c.fee === null ? null : BigInt(c.fee);
  return c.c.map((x) => {
    const inputs: RawInput[] = [];
    inputs[x.i] = { index: x.i, prevTxId: x.prev, prevIndex: 0, sig: "", prevAmount: null, prevSpk: null };
    return {
      txId: c.id, daaScore: c.d, blueScore: c.b, blockTime: c.bt, inputIndex: x.i, isPayload: x.pay,
      from: x.from, spkFrom: x.spk, params: { ...x.p }, fee, outputs, inputs,
    };
  });
}
