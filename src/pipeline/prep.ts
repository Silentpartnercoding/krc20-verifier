/**
 * Streaming prep: merge-join the sorted dump extracts into compact per-tx candidate lines.
 *   tsx src/pipeline/prep.ts --inputs inputs_sorted.tsv.gz --outputs outputs_sorted.tsv.gz --acc acc_by_tx.tsv.gz --out DIR
 * inputs/outputs: pgstream COPY rows sorted by (transaction_id, index) in C locale.
 * acc: `txId\tacceptingBlockHash\tblueScore\tdaaScore` (plain hex) sorted by txId; built from pgstream pass 2
 *      (transactions_acceptances) joined with pass 3 (blocks). L1 data only; no Kasplex input.
 * --fee-inputs F (optional): `txId\tnInputs\tinputSum` from api.kaspa.org (feeInputs.ts). The dump extract keeps only
 *      the inputs whose signature script matched the Kasplex filter, so a tx's other inputs (and their amounts) are
 *      missing and the dump-only fee is a lower bound. Rows in F replace the input sum for that tx's fee.
 * Output rows whose script_public_key_address is NULL in the dump get the address derived from the script.
 * Writes DIR/candidates.unsorted.tsv.gz (compact lines), DIR/unaccepted_txids.txt.gz, DIR/prep_stats.json.
 */
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { bytea, copyField } from "../sources/streamLoad.js";
import { extractOps } from "../replay/extract.js";
import { LineReader } from "./sortedJoin.js";
import { compactLine, toCompact } from "./compact.js";
import type { RawTx } from "../replay/types.js";
import { spkToAddr } from "../script/address.js";
import { readFileSync } from "node:fs";

export function loadFeeInputs(path?: string): Map<string, { n: number; inSum: bigint }> {
  const m = new Map<string, { n: number; inSum: bigint }>();
  if (!path) return m;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const [id, n, sum] = line.split("\t");
    if (!id || !sum || sum === "null") continue;
    m.set(id, { n: Number(n), inSum: BigInt(sum) });
  }
  return m;
}

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const log = (s: string) => console.error(`${new Date().toISOString()} ${s}`);

type GzOut = ReturnType<typeof createGzip> & { file: ReturnType<typeof createWriteStream> };
function gzOut(path: string): GzOut { const gz = createGzip({ level: 1 }) as GzOut; gz.file = createWriteStream(path); gz.pipe(gz.file); return gz; }
async function write(gz: GzOut, s: string) { if (!gz.write(s)) await new Promise((r) => gz.once("drain", r)); }
/** Resolve only once the underlying file is closed (gzip 'finish' alone can leave the tail unflushed). */
async function close(gz: GzOut) { await new Promise<void>((r) => { gz.file.once("close", () => r()); gz.end(); }); }

export async function prep(inputsPath: string, outputsPath: string, accPath: string, outDir: string, feeInputsPath?: string) {
  const feeIn = loadFeeInputs(feeInputsPath);
  mkdirSync(outDir, { recursive: true });
  const ins = new LineReader(inputsPath), outs = new LineReader(outputsPath), acc = new LineReader(accPath);
  const cand = gzOut(`${outDir}/candidates.unsorted.tsv.gz`);
  const unacc = gzOut(`${outDir}/unaccepted_txids.txt.gz`);
  const st = { txs: 0, accepted: 0, unaccepted: 0, withOps: 0, opsByOp: {} as Record<string, number>, opsByTick: {} as Record<string, number>,
    feeNull: 0, feeZero: 0, outputAddrDerived: 0, outputAddrUnresolved: 0, feeFromApi: 0, txsWithInputsMissingInDump: 0, feeInputsLoaded: feeIn.size, txsWithoutOutputs: 0, orphanOutputRows: 0, accRowsSkipped: 0, duplicateAccRows: 0, maxDaa: 0, maxBlue: 0, minDaa: Number.MAX_SAFE_INTEGER };
  const key = (r: string[]) => bytea(copyField(r[0]))!;
  const spkAddr = (f: string | null) => {
    const a = spkToAddr(bytea(f) ?? "");
    if (a) st.outputAddrDerived++; else st.outputAddrUnresolved++;
    return a;
  };
  const accKey = (r: string[]) => r[0];
  let prev = "";
  for (;;) {
    const first = await ins.peek();
    if (!first) break;
    const id = key(first);
    if (id <= prev) throw new Error(`inputs not strictly grouped/sorted at ${id} after ${prev} (sort with LC_ALL=C)`);
    prev = id;
    const rows = await ins.takeKey(id, key);
    const orows = await outs.takeKey(id, key, () => st.orphanOutputRows++);
    const arows = await acc.takeKey(id, accKey, () => st.accRowsSkipped++);
    st.txs++;
    if (arows.length > 1) st.duplicateAccRows++;
    if (!arows.length) { st.unaccepted++; await write(unacc, id + "\n"); continue; }
    st.accepted++;
    const a = arows[0];
    const tx: RawTx = {
      txId: id, blockTime: Number(copyField(rows[0][6]) ?? 0), payload: null,
      accept: { blockHash: a[1], blueScore: Number(a[2]), daaScore: Number(a[3]), daaExact: true },
      inputs: rows.map((r0) => { const r = r0.map(copyField); return { index: Number(r[1]), prevTxId: bytea(r[2])!, prevIndex: Number(r[3]), sig: bytea(r[4]) ?? "", prevSpk: bytea(r[7]), prevAmount: r[8] === null ? null : BigInt(r[8]) }; }),
      outputs: orows.map((r0) => { const r = r0.map(copyField); return { index: Number(r[1]), amount: BigInt(r[2]!), spk: bytea(r[3]) ?? "", address: r[4] ?? spkAddr(r[3]) }; }),
    };
    // dedupe by index (pass-1 extracts may repeat a row)
    tx.inputs = tx.inputs.filter((x, i, arr) => arr.findIndex((y) => y.index === x.index) === i).sort((x, y) => x.index - y.index);
    tx.outputs = tx.outputs.filter((x, i, arr) => arr.findIndex((y) => y.index === x.index) === i).sort((x, y) => x.index - y.index);
    if (!tx.outputs.length) st.txsWithoutOutputs++;
    st.maxDaa = Math.max(st.maxDaa, tx.accept.daaScore); st.minDaa = Math.min(st.minDaa, tx.accept.daaScore); st.maxBlue = Math.max(st.maxBlue, tx.accept.blueScore);
    const ops = extractOps(tx);
    if (!ops.length) continue;
    const fi = feeIn.get(id);
    if (fi) {
      st.feeFromApi++;
      if (fi.n > tx.inputs.length) st.txsWithInputsMissingInDump++;
      const outSum = tx.outputs.reduce((a, o) => a + o.amount, 0n);
      const fee = fi.inSum > outSum ? fi.inSum - outSum : 0n;
      for (const o of ops) o.fee = fee;
    }
    st.withOps++;
    for (const o of ops) {
      st.opsByOp[o.params.op] = (st.opsByOp[o.params.op] ?? 0) + 1;
      const t = o.params.tick ?? (o.params.ca !== undefined ? `ca:${o.params.ca}` : "<none>");
      st.opsByTick[t] = (st.opsByTick[t] ?? 0) + 1;
    }
    if (ops[0].fee === null) st.feeNull++; else if (ops[0].fee === 0n) st.feeZero++;
    await write(cand, compactLine(toCompact(tx, ops)) + "\n");
    if (st.txs % 500_000 === 0) log(`prep ${st.txs} txs, ${st.withOps} with ops`);
  }
  // trailing rows that matched no input group
  while (await outs.next()) st.orphanOutputRows++;
  await close(cand); await close(unacc);
  const top = Object.entries(st.opsByTick).sort((x, y) => y[1] - x[1]).slice(0, 25);
  const out = { ...st, opsByTick: Object.fromEntries(top), distinctTicks: Object.keys(st.opsByTick).length, inputLines: ins.lines, outputLines: outs.lines, accLines: acc.lines };
  writeFileSync(`${outDir}/prep_stats.json`, JSON.stringify(out, null, 1));
  return out;
}

if (process.argv[1]?.endsWith("prep.ts")) {
  prep(arg("inputs")!, arg("outputs")!, arg("acc")!, arg("out")!, arg("fee-inputs")).then((s) => log(JSON.stringify(s))).catch((e) => { console.error(e); process.exit(1); });
}
