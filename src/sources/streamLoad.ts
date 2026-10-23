/**
 * Loads pgstream output (PostgreSQL COPY text rows from the db-dl.kaspa.org dump) into RawTx shells.
 * Column orders are taken from the dump's own COPY statements (see tools/pgstream, TOC):
 *   transactions_inputs:  transaction_id, index, previous_outpoint_hash, previous_outpoint_index, signature_script,
 *                         sig_op_count, block_time, previous_outpoint_script, previous_outpoint_amount
 *   transactions_outputs: transaction_id, index, amount, script_public_key, script_public_key_address, block_time
 *   transactions_acceptances: transaction_id, block_hash
 *   blocks: hash, accepted_id_merkle_root, merge_set_blues_hashes, merge_set_reds_hashes, selected_parent_hash, bits,
 *           blue_score, blue_work, daa_score, hash_merkle_root, nonce, pruning_point, timestamp, utxo_commitment, version
 * NOTE: the dump's transactions table (payload) is not captured; payload ops only exist from DAA 408,300,500 (2026Q1),
 * after the dump's 2025-12-18 cut-off.
 */
import { createReadStream, existsSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import type { RawTx } from "../replay/types.js";

/** COPY text unescape (\\N = NULL; backslash escapes per PostgreSQL COPY TEXT format). */
export function copyField(f: string): string | null {
  if (f === "\\N") return null;
  if (!f.includes("\\")) return f;
  return f.replace(/\\(.)/g, (_, c: string) => ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" } as Record<string, string>)[c] ?? c);
}
/** bytea hex output ("\x0123...") -> lowercase hex. */
export function bytea(f: string | null): string | null {
  if (f === null) return null;
  return f.startsWith("\\x") ? f.slice(2).toLowerCase() : f;
}

export async function* copyRows(path: string): AsyncGenerator<(string | null)[]> {
  if (!existsSync(path)) return;
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield line.split("\t").map(copyField);
}

/** Build tx shells (no acceptance yet) from inputs/outputs TSVs. */
export async function loadStreamTxs(dir: string, tick = "nacho"): Promise<Map<string, Omit<RawTx, "accept">>> {
  const txs = new Map<string, Omit<RawTx, "accept">>();
  for await (const r of copyRows(`${dir}/inputs_${tick}.tsv.gz`)) {
    const id = bytea(r[0])!;
    let t = txs.get(id);
    if (!t) { t = { txId: id, blockTime: Number(r[6] ?? 0), inputs: [], outputs: [], payload: null }; txs.set(id, t); }
    if (t.inputs.some((i) => i.index === Number(r[1]))) continue; // dedupe
    t.inputs.push({ index: Number(r[1]), prevTxId: bytea(r[2])!, prevIndex: Number(r[3]), sig: bytea(r[4]) ?? "", prevSpk: bytea(r[7]), prevAmount: r[8] === null ? null : BigInt(r[8]) });
  }
  for await (const r of copyRows(`${dir}/outputs_${tick}.tsv.gz`)) {
    const t = txs.get(bytea(r[0])!);
    if (!t || t.outputs.some((o) => o.index === Number(r[1]))) continue;
    t.outputs.push({ index: Number(r[1]), amount: BigInt(r[2]!), spk: bytea(r[3]) ?? "", address: r[4] ?? "" });
  }
  for (const t of txs.values()) { t.inputs.sort((a, b) => a.index - b.index); t.outputs.sort((a, b) => a.index - b.index); }
  return txs;
}
