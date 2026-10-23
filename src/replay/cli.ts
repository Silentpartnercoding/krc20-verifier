/**
 * Independent KRC-20 replay of one token from L1 data.
 *   npx tsx src/replay/cli.ts --stream data/stream --acc stream|api [--claim DIR] [--tail-api] [--out DIR]
 * Inputs (independent L1 data only): pgstream output from the 2025-12-18 db-dl.kaspa.org dump,
 * acceptance from the dump (pass 2/3) or api.kaspa.org. The Kasplex claim is only used afterwards to
 * compare (and, with --tail-api, to know WHICH post-dump tx ids to fetch from api.kaspa.org; their
 * content and acceptance still come from L1). Blind spot printed at the end.
 */
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { KaspaApi } from "../sources/kaspaApi.js";
import { loadStreamTxs } from "../sources/streamLoad.js";
import { apiTxToRaw } from "../sources/apiTx.js";
import { acceptanceFromApi, acceptanceFromStream } from "./acceptance.js";
import { extractOps } from "./extract.js";
import { Krc20Replay } from "./krc20.js";
import { loadClaim } from "./claim.js";
import type { OpCandidate, RawTx } from "./types.js";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k: string) => process.argv.includes(`--${k}`);
const log = (s: string) => console.error(`${new Date().toISOString()} ${s}`);

async function main() {
  const streamDir = arg("stream", "data/stream")!;
  const accMode = arg("acc", "stream")!;
  const claimDir = arg("claim");
  const outDir = arg("out", "data/replay")!;
  const tick = (arg("tick", "NACHO")!).toUpperCase();
  mkdirSync(outDir, { recursive: true });
  const api = new KaspaApi({ offline: flag("offline") });

  const shells = await loadStreamTxs(streamDir, tick.toLowerCase());
  log(`stream txs with ${tick} kasplex inputs: ${shells.size}`);
  const acc = accMode === "api"
    ? (await acceptanceFromApi(api, [...shells.keys()], 50_000, log)).map
    : await acceptanceFromStream(streamDir);
  const txs: RawTx[] = [];
  let unaccepted = 0;
  for (const s of shells.values()) {
    const a = acc.get(s.txId);
    if (!a) { unaccepted++; continue; }
    txs.push({ ...s, accept: a });
  }
  log(`accepted: ${txs.length}, no acceptance found: ${unaccepted}`);

  const claim = claimDir ? await loadClaim(claimDir) : new Map();
  if (flag("tail-api") && claimDir) {
    const maxBlue = txs.reduce((m, t) => Math.max(m, t.accept.blueScore), 0);
    const maxDaa = txs.reduce((m, t) => Math.max(m, t.accept.daaScore), 0);
    const known = new Set(txs.map((t) => t.txId));
    // Only claim ops AFTER the dump window: claim ops inside the window that the dump lacks must surface
    // as "onlyInClaim" discrepancies, not be back-filled.
    const tailIds = [...claim.values()].filter((o) => !known.has(o.hashRev) && Number(BigInt(o.opScore) / 10000n) > maxDaa).map((o) => o.hashRev);
    log(`claim tx ids not in the dump stream: ${tailIds.length} (fetching content + acceptance from api.kaspa.org)`);
    const fetched = await api.searchTransactions(tailIds, { resolve: "full", acceptance: "accepted" });
    const accTail = await acceptanceFromApi(api, fetched.map((t: any) => t.transaction_id), 50_000, log);
    for (const t of fetched) {
      const a = accTail.map.get(t.transaction_id);
      if (a && a.blueScore > 0) txs.push(apiTxToRaw(t, a));
    }
    log(`tail txs added: ${txs.length - known.size} (dump max accepting blue score ${maxBlue})`);
  }

  // Order: accepting blue score; intra-block order is NOT recoverable from this data -> tie-break by txId and flag.
  txs.sort((a, b) => a.accept.blueScore - b.accept.blueScore || (a.txId < b.txId ? -1 : 1));
  const engine = new Krc20Replay(new Set([tick]));
  const perBlock = new Map<string, number>();
  let lastDaa = -1, idx = 0;
  for (const t of txs) {
    const ops: OpCandidate[] = extractOps(t);
    if (!ops.length) continue;
    if (t.accept.daaScore !== lastDaa) { lastDaa = t.accept.daaScore; idx = 0; }
    const before = engine.results.length;
    engine.applyTx(String(BigInt(t.accept.daaScore) * 10000n + BigInt(idx)), ops);
    if (engine.results.length > before) { idx++; perBlock.set(t.accept.blockHash, (perBlock.get(t.accept.blockHash) ?? 0) + 1); }
  }
  const tiedBlocks = [...perBlock.values()].filter((n) => n > 1).length;

  // Outputs
  const ws = createWriteStream(`${outDir}/ops.jsonl`);
  for (const r of engine.results) ws.write(JSON.stringify(r) + "\n");
  ws.end();
  const holders = engine.holders(tick);
  writeFileSync(`${outDir}/holders.json`, JSON.stringify(holders.map((h) => ({ address: h.address, balance: h.balance.toString(), locked: h.locked.toString() })), null, 1));
  const tok = engine.tokens.get(tick);

  // Compare with claim (by tx id).
  const cmp = { claimOps: claim.size, matched: 0, acceptMismatch: [] as string[], amountMismatch: [] as string[], onlyInReplay: [] as string[], onlyInClaim: 0 };
  if (claim.size) {
    const seen = new Set<string>();
    for (const r of engine.results) {
      const c = claim.get(r.txId);
      seen.add(r.txId);
      if (!c) { cmp.onlyInReplay.push(r.txId); continue; }
      cmp.matched++;
      if ((c.opAccept === "1") !== r.accept) cmp.acceptMismatch.push(r.txId);
      const amt = r.scripts.find((s) => s.accept)?.params.amt;
      if (r.accept && c.amt !== undefined && amt !== undefined && c.amt !== amt) cmp.amountMismatch.push(r.txId);
    }
    cmp.onlyInClaim = [...claim.keys()].filter((k) => !seen.has(k)).length;
  }
  const summary = {
    tick, ops: engine.results.length, accepted: engine.results.filter((r) => r.accept).length,
    token: tok && { minted: tok.minted.toString(), burned: tok.burned.toString(), max: tok.max.toString(), owner: tok.to },
    holders: holders.length, sumBalances: holders.reduce((a, h) => a + h.balance + h.locked, 0n).toString(),
    blocksWithMultipleOps: tiedBlocks, inexactDaa: txs.filter((t) => !t.accept.daaExact).length, apiNetworkCalls: api.networkCalls,
    compare: { ...cmp, acceptMismatch: cmp.acceptMismatch.length, amountMismatch: cmp.amountMismatch.length, onlyInReplay: cmp.onlyInReplay.length,
      samples: { acceptMismatch: cmp.acceptMismatch.slice(0, 20), amountMismatch: cmp.amountMismatch.slice(0, 20), onlyInReplay: cmp.onlyInReplay.slice(0, 20) } },
    blindSpot: [
      "Dump window ends 2025-12-18 16:19 (dump time); later ops come only from tx ids the claim names (--tail-api), so omissions after the dump are undetectable.",
      "The dump filter only sees ops whose input signature_script contains 'kasplex' and the tick; payload ops (DAA >= 408,300,500) are post-dump.",
      `Intra-block order is not recoverable from these tables; ${tiedBlocks} accepting blocks hold >1 ${tick} op and were tie-broken by tx id.`,
      "go-krc20d @a9754ffd is the rule reference; rules that existed only in older indexer versions are not modelled.",
    ],
  };
  writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
