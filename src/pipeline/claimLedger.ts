/**
 * Balance ledger implied by the Kasplex claim alone (CLAIM ONLY; a consistency check of the claim, not a replay).
 *   tsx src/pipeline/claimLedger.ts --claim claim_by_opscore.tsv.gz --out DIR
 * Input: claim TSV (claimTsv.ts columns) sorted by opScore numerically (sort -t$'\t' -k2,2n).
 * Applies only opAccept=1 ops: mint +amt to `to`; transfer from->to; list from.balance -> from.locked (keyed by
 * the list tx id); send moves the lister's (from) locked amt to `to`; burn subtracts. Reports sums, open
 * orders, and every point where the claim would drive a balance negative.
 */
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { LineReader } from "./sortedJoin.js";
import { CLAIM_COLS } from "./claimTsv.js";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };

export async function claimLedger(path: string, outDir: string) {
  mkdirSync(outDir, { recursive: true });
  const bal = new Map<string, { b: bigint; l: bigint }>();
  const get = (a: string) => { let x = bal.get(a); if (!x) { x = { b: 0n, l: 0n }; bal.set(a, x); } return x; };
  const neg = createWriteStream(`${outDir}/claim_ledger_negative.tsv`);
  const st = { ops: 0, applied: 0, byOp: {} as Record<string, number>, minted: 0n, burned: 0n, negativeEvents: 0, lastOpScore: -1n, maxDaa: 0, transferToSelf: 0, sendSelf: 0 };
  const rd = new LineReader(path);
  for (;;) {
    const r = await rd.next();
    if (!r) break;
    const c = Object.fromEntries(CLAIM_COLS.map((k, i) => [k, r[i] ?? ""]));
    st.ops++;
    const os = BigInt(c.opScore);
    if (os < st.lastOpScore) throw new Error(`claim not sorted by opScore at ${c.hashRev}`);
    st.lastOpScore = os; st.maxDaa = Math.max(st.maxDaa, Number(os / 10000n));
    if (c.opAccept !== "1") continue;
    st.applied++; st.byOp[c.op] = (st.byOp[c.op] ?? 0) + 1;
    const amt = c.amt ? BigInt(c.amt) : 0n;
    const check = (a: string, x: { b: bigint; l: bigint }) => { if (x.b < 0n || x.l < 0n) { st.negativeEvents++; neg.write(`${c.hashRev}\t${c.op}\t${a}\t${x.b}\t${x.l}\n`); } };
    switch (c.op) {
      case "deploy": break;
      case "mint": get(c.to).b += amt; st.minted += amt; break;
      case "transfer": { if (c.from === c.to) st.transferToSelf++; const f = get(c.from); f.b -= amt; check(c.from, f); get(c.to).b += amt; break; }
      case "list": { const f = get(c.from); f.b -= amt; f.l += amt; check(c.from, f); break; }
      case "send": { if (c.from === c.to) st.sendSelf++; const f = get(c.from); f.l -= amt; check(c.from, f); get(c.to).b += amt; break; }
      case "burn": { const f = get(c.from); f.b -= amt; st.burned += amt; check(c.from, f); break; }
      default: throw new Error(`unknown op ${c.op}`);
    }
  }
  await new Promise((r) => neg.end(r));
  let sumB = 0n, sumL = 0n, holders = 0, lockedHolders = 0;
  const rows: string[] = [];
  for (const [a, x] of bal) {
    sumB += x.b; sumL += x.l;
    if (x.b !== 0n || x.l !== 0n) { holders++; rows.push(`${a}\t${x.b}\t${x.l}`); }
    if (x.l !== 0n) lockedHolders++;
  }
  writeFileSync(`${outDir}/claim_ledger_holders.tsv`, rows.join("\n") + "\n");
  const out = { ...st, minted: st.minted.toString(), burned: st.burned.toString(), lastOpScore: st.lastOpScore.toString(), holders, lockedHolders,
    sumBalance: sumB.toString(), sumLocked: sumL.toString(), sumBalancePlusLocked: (sumB + sumL).toString() };
  writeFileSync(`${outDir}/claim_ledger_summary.json`, JSON.stringify(out, null, 1));
  return out;
}

if (process.argv[1]?.endsWith("claimLedger.ts")) claimLedger(arg("claim")!, arg("out")!).then((s) => console.log(JSON.stringify(s, null, 1))).catch((e) => { console.error(e); process.exit(1); });
