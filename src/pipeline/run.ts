/**
 * Streaming NACHO replay over sorted compact candidates (see prep.ts / compact.ts).
 *   tsx src/pipeline/run.ts --cands candidates.sorted.tsv.gz --out DIR [--tick NACHO]
 * Input lines must be sorted by (blueScore, txId) (LC_ALL=C sort -k1,1 -k2,2). Writes:
 *   DIR/results.tsv.gz  txId opScore daa blue op accept error amt from to nScripts blockHash tiedBlock
 *   DIR/holders.tsv     address balance locked (non-zero only)
 *   DIR/markets.tsv     open list orders at the end (tick|from|utxoTxId, tamt)
 *   DIR/run_summary.json
 */
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { LineReader } from "./sortedJoin.js";
import { fromCompact, type CompactTx } from "./compact.js";
import { Krc20Replay, type OpResult } from "../replay/krc20.js";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const log = (s: string) => console.error(`${new Date().toISOString()} ${s}`);

export const RESULT_COLS = ["txId", "opScore", "daa", "blue", "op", "accept", "error", "amt", "from", "to", "nScripts", "blockHash", "tiedBlock"] as const;

export function resultRow(r: OpResult, daa: number, blue: number, blockHash: string, tied: boolean): string {
  const s = r.scripts.find((x) => x.accept) ?? r.scripts[0];
  return [r.txId, r.opScore, daa, blue, r.op, r.accept ? 1 : 0, r.error, s?.params.amt ?? "", s?.params.from ?? "", s?.params.to ?? "", r.scripts.length, blockHash, tied ? 1 : 0]
    .map((x) => String(x).replace(/[\t\n]/g, " ")).join("\t");
}

export async function runReplay(candPath: string, outDir: string, tick = "NACHO") {
  mkdirSync(outDir, { recursive: true });
  const gz = createGzip({ level: 1 });
  const file = createWriteStream(`${outDir}/results.tsv.gz`);
  gz.pipe(file);
  // Buffer one accepting block's results so each row can carry whether its block held >1 op (tie-broken order).
  let blockBuf: { r: OpResult; d: number; b: number; h: string }[] = [];
  let pending: { d: number; b: number; h: string } | null = null;
  const st = { txs: 0, results: 0, accepted: 0, byOpAccept: {} as Record<string, number>, rejectByOpError: {} as Record<string, number>,
    blocksWithOps: 0, blocksWithMultipleOps: 0, opsInTiedBlocks: 0, lastBlue: -1, lastTxId: "", maxDaa: 0, maxBlue: 0 };
  const flush = async () => {
    if (!blockBuf.length) return;
    st.blocksWithOps++;
    const tied = blockBuf.length > 1;
    if (tied) { st.blocksWithMultipleOps++; st.opsInTiedBlocks += blockBuf.length; }
    for (const x of blockBuf) if (!gz.write(resultRow(x.r, x.d, x.b, x.h, tied) + "\n")) await new Promise((r) => gz.once("drain", r));
    blockBuf = [];
  };
  const engine = new Krc20Replay(new Set([tick]), (r) => { blockBuf.push({ r, ...pending! }); });
  const rd = new LineReader(candPath);
  let lastDaa = -1, idx = 0, lastHash = "";
  for (;;) {
    const row = await rd.next();
    if (!row) break;
    const blue = Number(row[0]), id = row[1];
    if (blue < st.lastBlue || (blue === st.lastBlue && id <= st.lastTxId)) throw new Error(`candidates not sorted at ${row[0]} ${id}`);
    st.lastBlue = blue; st.lastTxId = id;
    const c = JSON.parse(row.slice(2).join("\t")) as CompactTx;
    if (c.h !== lastHash) { await flush(); lastHash = c.h; }
    if (c.d !== lastDaa) { lastDaa = c.d; idx = 0; }
    st.txs++; st.maxDaa = Math.max(st.maxDaa, c.d); st.maxBlue = Math.max(st.maxBlue, c.b);
    pending = { d: c.d, b: c.b, h: c.h };
    const before = engine.resultCount;
    engine.applyTx(String(BigInt(c.d) * 10000n + BigInt(idx)), fromCompact(c));
    if (engine.resultCount > before) {
      idx++;
      const r = blockBuf[blockBuf.length - 1].r;
      st.results++;
      if (r.accept) st.accepted++;
      const k = `${r.op}|${r.accept ? "accept" : "reject"}`;
      st.byOpAccept[k] = (st.byOpAccept[k] ?? 0) + 1;
      if (!r.accept) { const e = `${r.op}|${r.error}`; st.rejectByOpError[e] = (st.rejectByOpError[e] ?? 0) + 1; }
    }
    if (st.txs % 1_000_000 === 0) log(`run ${st.txs} txs, ${st.results} results`);
  }
  await flush();
  await new Promise<void>((r) => { file.once("close", () => r()); gz.end(); });
  const holders = engine.holders(tick);
  writeFileSync(`${outDir}/holders.tsv`, holders.map((h) => `${h.address}\t${h.balance}\t${h.locked}`).join("\n") + "\n");
  writeFileSync(`${outDir}/markets.tsv`, [...engine.markets].map(([k, m]) => `${k}\t${m.tamt}\t${m.uaddr}\t${m.uamt}`).join("\n") + "\n");
  const tok = engine.tokens.get(tick);
  const sumBal = holders.reduce((a, h) => a + h.balance, 0n), sumLocked = holders.reduce((a, h) => a + h.locked, 0n);
  const summary = {
    ...st, tick,
    token: tok && { minted: tok.minted.toString(), burned: tok.burned.toString(), max: tok.max.toString(), lim: tok.lim.toString(), owner: tok.to, deployTx: tok.txid, deployOpScore: tok.opadd },
    holders: holders.length, sumBalance: sumBal.toString(), sumLocked: sumLocked.toString(), sumBalancePlusLocked: (sumBal + sumLocked).toString(),
    openMarkets: engine.markets.size, openMarketsAmount: [...engine.markets.values()].reduce((a, m) => a + m.tamt, 0n).toString(),
  };
  writeFileSync(`${outDir}/run_summary.json`, JSON.stringify(summary, null, 1));
  return summary;
}

if (process.argv[1]?.endsWith("run.ts")) {
  runReplay(arg("cands")!, arg("out")!, arg("tick", "NACHO")!).then((s) => log(JSON.stringify(s))).catch((e) => { console.error(e); process.exit(1); });
}
