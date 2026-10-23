/**
 * Fetch full input sets (count, sum of spent amounts) from api.kaspa.org for txs whose dump-only fee is a lower bound.
 *   tsx src/pipeline/feeInputs.ts --ids ids.txt --out fee_inputs.tsv [--offline]
 * Output: `txId\tnInputs\tinputSum|null\toutputSum\tisAccepted` (null when any spent amount is unresolved).
 * Responses are cached on disk by KaspaApi, so a rerun resumes without refetching.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { KaspaApi } from "../sources/kaspaApi.js";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const log = (s: string) => console.error(`${new Date().toISOString()} ${s}`);

export function feeRow(t: any): string {
  let sum: bigint | null = 0n;
  for (const i of t.inputs ?? []) {
    const a = i.previous_outpoint_amount ?? i.previous_outpoint_resolved?.amount;
    if (a == null) { sum = null; break; }
    sum! += BigInt(a);
  }
  const outSum = (t.outputs ?? []).reduce((a: bigint, o: any) => a + BigInt(o.amount), 0n);
  return [t.transaction_id, (t.inputs ?? []).length, sum === null ? "null" : sum.toString(), outSum.toString(), t.is_accepted ? 1 : 0].join("\t");
}

if (process.argv[1]?.endsWith("feeInputs.ts")) {
  const api = new KaspaApi({ offline: process.argv.includes("--offline") });
  const ids = [...new Set(readFileSync(arg("ids")!, "utf8").split("\n").map((x) => x.trim()).filter((x) => /^[0-9a-f]{64}$/.test(x)))].sort();
  const out = arg("out")!;
  writeFileSync(out, "");
  const st = { ids: ids.length, found: 0, nullSum: 0 };
  for (let i = 0; i < ids.length; i += 1000) {
    const got = await api.searchTransactions(ids.slice(i, i + 1000), { resolve: "light" });
    const rows = got.map(feeRow);
    st.found += rows.length; st.nullSum += rows.filter((r) => r.split("\t")[2] === "null").length;
    appendFileSync(out, rows.join("\n") + (rows.length ? "\n" : ""));
    log(`feeInputs ${Math.min(i + 1000, ids.length)}/${ids.length} found ${st.found} nullSum ${st.nullSum} calls ${api.networkCalls}`);
  }
  log(JSON.stringify(st));
}
