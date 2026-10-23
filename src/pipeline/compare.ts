/**
 * Merge-compare replay results with the Kasplex claim, both sorted by tx id (LC_ALL=C sort -k1,1).
 *   tsx src/pipeline/compare.ts --results results.bytx.tsv.gz --claim claim_sorted.tsv.gz --dump-max-daa N --out DIR
 * The claim is only compared against; it never feeds the replay.
 * Writes DIR/compare_summary.json and detail TSVs (reject_vs_claim_accept, accept_vs_claim_reject,
 * amount_mismatch, from_to_mismatch, daa_mismatch, only_in_claim, only_in_replay).
 */
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from "node:fs";
import { LineReader } from "./sortedJoin.js";
import { CLAIM_COLS } from "./claimTsv.js";
import { RESULT_COLS } from "./run.js";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
type Row = Record<string, string>;
const asObj = (cols: readonly string[], r: string[]): Row => Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ""]));
const inc = (m: Record<string, number>, k: string, n = 1) => { m[k] = (m[k] ?? 0) + n; };

export interface CompareSummary {
  replayResults: number; claimOps: number; matched: number;
  bothAccept: number; replayRejectClaimAccept: number; replayAcceptClaimReject: number; bothReject: number;
  rejectVsClaimAcceptByOpError: Record<string, number>; amountMismatch: number; amountMismatchByOp: Record<string, number>;
  fromToMismatch: number; opMismatch: number; daaMismatch: number; tiedBlockAmongRejects: number;
  onlyInClaim: number; onlyInClaimByWindowOp: Record<string, number>; onlyInReplay: number; onlyInReplayByOpAccept: Record<string, number>;
  samples: Record<string, string[]>;
}

export async function compare(resultsPath: string, claimPath: string, dumpMaxDaa: number, outDir: string): Promise<CompareSummary> {
  mkdirSync(outDir, { recursive: true });
  const files: Record<string, WriteStream> = {};
  const out = (name: string, line: string) => { (files[name] ??= createWriteStream(`${outDir}/${name}.tsv`)).write(line + "\n"); };
  const s: CompareSummary = { replayResults: 0, claimOps: 0, matched: 0, bothAccept: 0, replayRejectClaimAccept: 0, replayAcceptClaimReject: 0, bothReject: 0,
    rejectVsClaimAcceptByOpError: {}, amountMismatch: 0, amountMismatchByOp: {}, fromToMismatch: 0, opMismatch: 0, daaMismatch: 0, tiedBlockAmongRejects: 0,
    onlyInClaim: 0, onlyInClaimByWindowOp: {}, onlyInReplay: 0, onlyInReplayByOpAccept: {}, samples: {} };
  const sample = (k: string, id: string) => { const a = (s.samples[k] ??= []); if (a.length < 10) a.push(id); };
  const R = new LineReader(resultsPath), C = new LineReader(claimPath);
  let lastR = "", lastC = "";
  const onlyClaim = (c: Row) => {
    s.onlyInClaim++;
    const daa = Number(BigInt(c.opScore || "0") / 10000n);
    const w = daa > dumpMaxDaa ? "afterDump" : "insideDump";
    inc(s.onlyInClaimByWindowOp, `${w}|${c.op}|opAccept=${c.opAccept}`);
    sample(`onlyInClaim|${w}|${c.op}`, c.hashRev);
    out(`only_in_claim_${w}`, CLAIM_COLS.map((k) => c[k]).join("\t"));
  };
  const onlyReplay = (r: Row) => {
    s.onlyInReplay++;
    inc(s.onlyInReplayByOpAccept, `${r.op}|accept=${r.accept}|${r.error}`);
    sample(`onlyInReplay|${r.op}|${r.accept}`, r.txId);
    out("only_in_replay", RESULT_COLS.map((k) => r[k]).join("\t"));
  };
  for (;;) {
    const rr = await R.peek(), cr = await C.peek();
    if (!rr && !cr) break;
    const r = rr && asObj(RESULT_COLS, rr), c = cr && asObj(CLAIM_COLS, cr);
    if (r && r.txId <= lastR && R.lines > 1) throw new Error(`results not sorted/unique at ${r.txId}`);
    if (c && c.hashRev <= lastC && C.lines > 1) throw new Error(`claim not sorted/unique at ${c.hashRev}`);
    if (r && (!c || r.txId < c.hashRev)) { s.replayResults++; lastR = r.txId; onlyReplay(r); await R.next(); continue; }
    if (c && (!r || c.hashRev < r.txId)) { s.claimOps++; lastC = c.hashRev; onlyClaim(c); await C.next(); continue; }
    // matched
    s.replayResults++; s.claimOps++; s.matched++; lastR = r!.txId; lastC = c!.hashRev;
    await R.next(); await C.next();
    const ra = r!.accept === "1", ca = c!.opAccept === "1";
    if (r!.op !== c!.op) { s.opMismatch++; sample("opMismatch", r!.txId); out("op_mismatch", `${r!.txId}\t${r!.op}\t${c!.op}`); }
    const cDaa = Number(BigInt(c!.opScore) / 10000n);
    if (cDaa !== Number(r!.daa)) { s.daaMismatch++; sample("daaMismatch", r!.txId); out("daa_mismatch", `${r!.txId}\t${r!.daa}\t${cDaa}\t${c!.opScore}`); }
    if (ra && ca) s.bothAccept++;
    else if (!ra && !ca) s.bothReject++;
    else if (!ra && ca) {
      s.replayRejectClaimAccept++;
      inc(s.rejectVsClaimAcceptByOpError, `${r!.op}|${r!.error}`);
      if (r!.tiedBlock === "1") s.tiedBlockAmongRejects++;
      sample(`rejectVsClaimAccept|${r!.op}|${r!.error}`, r!.txId);
      out("reject_vs_claim_accept", [...RESULT_COLS.map((k) => r![k]), c!.opScore, c!.amt, c!.from, c!.to, c!.feeRev].join("\t"));
    } else {
      s.replayAcceptClaimReject++;
      sample("acceptVsClaimReject", r!.txId);
      out("accept_vs_claim_reject", [...RESULT_COLS.map((k) => r![k]), c!.opScore, c!.opError].join("\t"));
    }
    if (ra && ca) {
      if (r!.amt !== c!.amt) { s.amountMismatch++; inc(s.amountMismatchByOp, r!.op); sample(`amountMismatch|${r!.op}`, r!.txId); out("amount_mismatch", `${r!.txId}\t${r!.op}\t${r!.amt}\t${c!.amt}\t${r!.daa}\t${c!.opScore}`); }
      if (r!.from !== c!.from || r!.to !== c!.to) { s.fromToMismatch++; sample(`fromToMismatch|${r!.op}`, r!.txId); out("from_to_mismatch", `${r!.txId}\t${r!.op}\t${r!.from}\t${c!.from}\t${r!.to}\t${c!.to}`); }
    }
  }
  await Promise.all(Object.values(files).map((f) => new Promise((res) => f.end(res))));
  writeFileSync(`${outDir}/compare_summary.json`, JSON.stringify(s, null, 1));
  return s;
}

if (process.argv[1]?.endsWith("compare.ts")) {
  compare(arg("results")!, arg("claim")!, Number(arg("dump-max-daa", "0")), arg("out")!).then((s) => console.log(JSON.stringify(s, null, 1))).catch((e) => { console.error(e); process.exit(1); });
}
