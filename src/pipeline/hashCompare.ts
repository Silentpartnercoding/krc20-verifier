/**
 * Compare two krc20-sh-v1 unit-hash files (daa nEvents unitHash cumulative chainBlock), merge-joined on daa.
 * Reports the first unit where the cumulative chain diverges, plus per-unit agreement counts.
 *   tsx src/pipeline/hashCompare.ts --a A.tsv.gz --b B.tsv.gz [--context 3] [--out report.json]
 * Blind spot: a matching chain proves both sides hashed identical canonical event strings in identical
 * unit order; it says nothing about fields the v1 event string omits (e.g. the order id of a send).
 */
import { writeFileSync } from "node:fs";
import { LineReader } from "./sortedJoin.js";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
type Row = { daa: bigint; raw: string[] };

async function* units(path: string): AsyncGenerator<Row> {
  const rd = new LineReader(path);
  for (;;) { const r = await rd.next(); if (!r) return; if (r[0] === "daa") continue; yield { daa: BigInt(r[0]), raw: r }; }
}
const fmt = (r?: Row) => r && { daa: r.raw[0], nEvents: Number(r.raw[1]), unitHash: r.raw[2], cumulative: r.raw[3], chainBlock: r.raw[4] || undefined };

export async function compareHashes(a: string, b: string, context = 3) {
  const ia = units(a), ib = units(b);
  let ra = (await ia.next()).value as Row | undefined, rb = (await ib.next()).value as Row | undefined;
  const st = { unitsA: 0, unitsB: 0, bothSameUnitHash: 0, bothDiffUnitHash: 0, onlyA: 0, onlyB: 0 };
  let firstDivergence: Record<string, unknown> | null = null;
  const lastAgree: { a?: Row; b?: Row }[] = [];
  let after: unknown[] = [], lastA: Row | undefined, lastB: Row | undefined;
  const diffUnits: string[] = [];
  while (ra || rb) {
    let pa: Row | undefined, pb: Row | undefined;
    if (ra && (!rb || ra.daa < rb.daa)) { pa = ra; st.onlyA++; }
    else if (rb && (!ra || rb.daa < ra.daa)) { pb = rb; st.onlyB++; }
    else { pa = ra; pb = rb; if (ra!.raw[2] === rb!.raw[2]) st.bothSameUnitHash++; else st.bothDiffUnitHash++; }
    if (pa) { st.unitsA++; lastA = pa; ra = (await ia.next()).value as Row | undefined; }
    if (pb) { st.unitsB++; lastB = pb; rb = (await ib.next()).value as Row | undefined; }
    const agree = pa && pb && pa.raw[3] === pb.raw[3];
    if (!(pa && pb && pa.raw[2] === pb.raw[2]) && diffUnits.length < 50) diffUnits.push(String((pa ?? pb)!.daa));
    if (!firstDivergence) {
      if (agree) { lastAgree.push({ a: pa, b: pb }); if (lastAgree.length > context) lastAgree.shift(); }
      else firstDivergence = { daa: String((pa ?? pb)!.daa), a: fmt(pa), b: fmt(pb), lastAgreeing: lastAgree.map((x) => fmt(x.a)) };
    } else if (after.length < context) after.push({ a: fmt(pa), b: fmt(pb) });
  }
  return { ...st, identical: !firstDivergence, firstDivergence, afterDivergence: after, firstUnitHashDiffDaas: diffUnits,
    finalA: fmt(lastA), finalB: fmt(lastB) };
}

if (process.argv[1]?.endsWith("hashCompare.ts")) {
  compareHashes(arg("a")!, arg("b")!, Number(arg("context", "3"))).then((r) => {
    const s = JSON.stringify(r, null, 1);
    if (arg("out")) writeFileSync(arg("out")!, s + "\n");
    console.log(s);
  }).catch((e) => { console.error(e); process.exit(1); });
}
