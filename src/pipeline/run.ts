/**
 * Streaming NACHO replay over sorted compact candidates (see prep.ts / compact.ts).
 *   tsx src/pipeline/run.ts --cands candidates.sorted.tsv.gz --out DIR [--tick NACHO] [--order node|txid] [--accept-order FILE]
 * Input lines must be sorted by (blueScore, txId) (LC_ALL=C sort -k1,1 -k2,2). Writes:
 *   DIR/results.tsv.gz  txId opScore daa blue op accept error amt from to nScripts blockHash tiedBlock
 *   DIR/holders.tsv     address balance locked (non-zero only)
 *   DIR/markets.tsv     open list orders at the end (tick|from|utxoTxId, tamt)
 *   DIR/run_summary.json
 * Optional: --state-hashes FILE.tsv.gz  per-unit chained event hashes (docs/state-hashes.md);
 *   balance/market state hashes are then added to run_summary.json under "stateHashes".
 * In-unit order (which tx of one accepting chain block gets op index 0, 1, ...):
 *   --order node (default)  DAA < 110,165,000: txid sort; DAA >= 110,165,000: node acceptance order from
 *                           --accept-order FILE (chainBlock daa txid position, see tools/vchain_order.py).
 *                           This is the rule in go-krc20d @ a9754ffd sequencer/archive.go (sort.Strings(txIdList)
 *                           only when daaScore < 110165000) with node order after that. Units missing from the file
 *                           fall back to txid sort and are counted in orderFallbackUnits.
 *   --order txid            txid sort everywhere (the earlier behaviour).
 */
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { LineReader } from "./sortedJoin.js";
import { fromCompact, type CompactTx } from "./compact.js";
import { Krc20Replay, type OpResult } from "../replay/krc20.js";
import { StateHasher, balanceStateHash, marketStateHash, unitRow, UNIT_COLS, STATE_HASH_VERSION, type Krc20Event } from "../hash/stateHash.js";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const log = (s: string) => console.error(`${new Date().toISOString()} ${s}`);

export const RESULT_COLS = ["txId", "opScore", "daa", "blue", "op", "accept", "error", "amt", "from", "to", "nScripts", "blockHash", "tiedBlock"] as const;

export function resultRow(r: OpResult, daa: number, blue: number, blockHash: string, tied: boolean): string {
  const s = r.scripts.find((x) => x.accept) ?? r.scripts[0];
  return [r.txId, r.opScore, daa, blue, r.op, r.accept ? 1 : 0, r.error, s?.params.amt ?? "", s?.params.from ?? "", s?.params.to ?? "", r.scripts.length, blockHash, tied ? 1 : 0]
    .map((x) => String(x).replace(/[\t\n]/g, " ")).join("\t");
}

/** Accepted OpResult -> canonical event input (first accepted script, as in resultRow). */
export function eventFromResult(r: OpResult): Krc20Event | null {
  if (!r.accept) return null;
  const s = r.scripts.find((x) => x.accept)!;
  const p = s.params;
  return { op: s.op, txId: r.txId, tick: p.tick, from: p.from, to: p.to, amt: p.amt, utxo: p.utxo, max: p.max, lim: p.lim, pre: p.pre, dec: p.dec, mod: p.mod };
}

export const NODE_ORDER_DAA = 110_165_000;

/** chainBlock -> (txid -> position) from accept_order.tsv. */
export function loadAcceptOrder(path: string): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const f = line.split("\t");
    if (f.length < 4) continue;
    let u = m.get(f[0]); if (!u) m.set(f[0], u = new Map());
    u.set(f[2], Number(f[3]));
  }
  return m;
}

/** Order one accepting block's candidate txs. Returns true when node order from the file was used. */
export function orderUnit<T extends { id: string }>(txs: T[], daa: number, hash: string, mode: "node" | "txid", acc?: Map<string, Map<string, number>>): "txid" | "node" | "fallback" {
  txs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (mode === "txid" || daa < NODE_ORDER_DAA || txs.length < 2) return "txid";
  const pos = acc?.get(hash);
  if (!pos) return "fallback";
  const big = Number.MAX_SAFE_INTEGER;
  txs.sort((a, b) => (pos.get(a.id) ?? big) - (pos.get(b.id) ?? big) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return "node";
}

export async function runReplay(candPath: string, outDir: string, tick = "NACHO", stateHashPath?: string,
  orderMode: "node" | "txid" = "node", acceptOrderPath?: string) {
  mkdirSync(outDir, { recursive: true });
  if (orderMode === "node" && !acceptOrderPath) throw new Error("--order node needs --accept-order FILE (or use --order txid)");
  const acc = orderMode === "node" ? loadAcceptOrder(acceptOrderPath!) : undefined;
  const gz = createGzip({ level: 1 });
  const file = createWriteStream(`${outDir}/results.tsv.gz`);
  gz.pipe(file);
  // Buffer one accepting block's results so each row can carry whether its block held >1 op (tie-broken order).
  let blockBuf: { r: OpResult; d: number; b: number; h: string }[] = [];
  let pending: { d: number; b: number; h: string } | null = null;
  const st = { txs: 0, results: 0, accepted: 0, byOpAccept: {} as Record<string, number>, rejectByOpError: {} as Record<string, number>,
    blocksWithOps: 0, blocksWithMultipleOps: 0, opsInTiedBlocks: 0, lastBlue: -1, lastTxId: "", maxDaa: 0, maxBlue: 0,
    orderMode, orderNodeUnits: 0, orderFallbackUnits: 0 };
  let hasher: StateHasher | null = null, hgz: ReturnType<typeof createGzip> | null = null, hfile: ReturnType<typeof createWriteStream> | null = null;
  const hrows: string[] = [];
  if (stateHashPath) {
    hgz = createGzip({ level: 6 }); hfile = createWriteStream(stateHashPath); hgz.pipe(hfile);
    hgz.write(UNIT_COLS.join("\t") + "\n");
    hasher = new StateHasher((u) => { hrows.push(unitRow(u)); });
  }
  const flush = async () => {
    if (!blockBuf.length) return;
    if (hasher) {
      for (const x of blockBuf) { const e = eventFromResult(x.r); if (e) hasher.add(x.d, x.h, e); }
      hasher.flush();
      for (const row of hrows.splice(0)) if (!hgz!.write(row + "\n")) await new Promise((r) => hgz!.once("drain", r));
    }
    st.blocksWithOps++;
    const tied = blockBuf.length > 1;
    if (tied) { st.blocksWithMultipleOps++; st.opsInTiedBlocks += blockBuf.length; }
    for (const x of blockBuf) if (!gz.write(resultRow(x.r, x.d, x.b, x.h, tied) + "\n")) await new Promise((r) => gz.once("drain", r));
    blockBuf = [];
  };
  const engine = new Krc20Replay(new Set([tick]), (r) => { blockBuf.push({ r, ...pending! }); });
  const rd = new LineReader(candPath);
  let lastDaa = -1, idx = 0, lastHash = "";
  let unit: { id: string; c: CompactTx }[] = [];
  const applyUnit = async () => {
    if (!unit.length) return;
    const how = orderUnit(unit, unit[0].c.d, unit[0].c.h, orderMode, acc);
    if (how === "node") st.orderNodeUnits++; else if (how === "fallback") st.orderFallbackUnits++;
    for (const { c } of unit) {
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
    unit = [];
  };
  for (;;) {
    const row = await rd.next();
    if (!row) break;
    const blue = Number(row[0]), id = row[1];
    if (blue < st.lastBlue || (blue === st.lastBlue && id <= st.lastTxId)) throw new Error(`candidates not sorted at ${row[0]} ${id}`);
    st.lastBlue = blue; st.lastTxId = id;
    const c = JSON.parse(row.slice(2).join("\t")) as CompactTx;
    if (unit.length && unit[0].c.h !== c.h) await applyUnit();
    unit.push({ id, c });
  }
  await applyUnit();
  await flush();
  await new Promise<void>((r) => { file.once("close", () => r()); gz.end(); });
  if (hgz) await new Promise<void>((r) => { hfile!.once("close", () => r()); hgz!.end(); });
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
    ...(hasher && { stateHashes: {
      version: STATE_HASH_VERSION, units: hasher.units, events: hasher.events, finalCumulative: hasher.cumulative,
      balances: balanceStateHash(tick, holders),
      markets: marketStateHash(tick, [...engine.markets].map(([k, m]) => { const [, from, listTxId] = k.split("|"); return { from, listTxId, tamt: m.tamt }; })),
    } }),
  };
  writeFileSync(`${outDir}/run_summary.json`, JSON.stringify(summary, null, 1));
  return summary;
}

if (process.argv[1]?.endsWith("run.ts")) {
  runReplay(arg("cands")!, arg("out")!, arg("tick", "NACHO")!, arg("state-hashes"), arg("order", "node") as "node" | "txid", arg("accept-order")).then((s) => log(JSON.stringify(s))).catch((e) => { console.error(e); process.exit(1); });
}
