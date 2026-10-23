/** api.kaspa.org transaction JSON (resolve_previous_outpoints=light|full) -> RawTx. */
import type { Acceptance, RawTx } from "../replay/types.js";

export function apiTxToRaw(t: any, accept: Acceptance): RawTx {
  return {
    txId: t.transaction_id,
    blockTime: Number(t.block_time ?? 0),
    payload: t.payload ?? null,
    accept,
    inputs: (t.inputs ?? []).map((i: any) => ({
      index: Number(i.index),
      prevTxId: i.previous_outpoint_hash,
      prevIndex: Number(i.previous_outpoint_index),
      sig: i.signature_script ?? "",
      // resolve_previous_outpoints=light gives previous_outpoint_amount; =full nests the spent output under
      // previous_outpoint_resolved (amount, script_public_key). Post-2026Q1 envelope/payload ops need the script.
      prevAmount: (i.previous_outpoint_amount ?? i.previous_outpoint_resolved?.amount) == null ? null
        : BigInt(i.previous_outpoint_amount ?? i.previous_outpoint_resolved.amount),
      prevSpk: i.previous_outpoint_script ?? i.previous_outpoint_resolved?.script_public_key ?? null,
    })).sort((a: any, b: any) => a.index - b.index),
    outputs: (t.outputs ?? []).map((o: any) => ({
      index: Number(o.index), amount: BigInt(o.amount), spk: o.script_public_key, address: o.script_public_key_address,
    })).sort((a: any, b: any) => a.index - b.index),
  };
}
