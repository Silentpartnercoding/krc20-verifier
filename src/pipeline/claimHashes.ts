/**
 * Claim-side state hashes: the same krc20-sh-v1 chain computed from Kasplex's own per-op records
 * (CLAIM data, never ground truth). Input: opScore-ascending TSV from
 * tools/kasplex_claim_sorted.py with columns
 *   opScore txid op tick amt from to utxo checkpoint opAccept extra(json)
 * Unit = floor(opScore / 10000) = accepting DAA. Only opAccept == "1" rows are hashed.
 *   tsx src/pipeline/claimHashes.ts --claim SORTED.tsv.gz --out UNITS.tsv.gz [--deploy deploy.json] [--holders claim_ledger_holders.tsv] [--tick NACHO]
 * The token's deploy op is not in the per-tick oplist pages; --deploy injects it from /v1/krc20/token-style JSON.
 */
import { createWriteStream, readFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { LineReader } from "./sortedJoin.js";
import { StateHasher, balanceStateHash, unitRow, UNIT_COLS, STATE_HASH_VERSION, type Krc20Event } from "../hash/stateHash.js";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };

export function eventFromClaimRow(row: string[]): { daa: string; accepted: boolean; e: Krc20Event } {
  const [opScore, txId, op, tick, amt, from, to, utxo, , opAccept, extra] = row;
  const x = extra ? (JSON.parse(extra) as Record<string, string>) : {};
  const daa = (BigInt(opScore) / 10000n).toString();
  return { daa, accepted: opAccept === "1", e: { op, txId, tick, amt, from, to, utxo, max: x.max, lim: x.lim, pre: x.pre, dec: x.dec, mod: x.mod } };
}

/** Kasplex op JSON (oplist / op/:id / deploy record) -> claim TSV row. */
export function claimRowFromJson(d: Record<string, string>): string[] {
  const extra: Record<string, string> = {};
  for (const k of ["max", "lim", "pre", "dec", "mod", "price"]) if (d[k] !== undefined) extra[k] = d[k];
  return [d.opScore, d.hashRev, d.op, d.tick ?? d.ca ?? "", d.amt ?? "", d.from ?? "", d.to ?? "", d.utxo ?? "", d.checkpoint ?? "", d.opAccept ?? "", Object.keys(extra).length ? JSON.stringify(extra) : ""];
}

export async function claimHashes(claimPath: string, outPath: string, tick: string, holdersPath?: string, deployPath?: string) {
  const gz = createGzip({ level: 6 }); const file = createWriteStream(outPath); gz.pipe(file);
  gz.write(UNIT_COLS.join("\t") + "\n");
  const rows: string[] = [];
  const h = new StateHasher((u) => rows.push(unitRow(u)));
  const rd = new LineReader(claimPath);
  let n = 0, acc = 0, last = -1n;
  let injected = deployPath ? claimRowFromJson(JSON.parse(readFileSync(deployPath, "utf8"))) : null;
  for (;;) {
    let row = await rd.peek();
    if (injected && (!row || BigInt(injected[0]) < BigInt(row[0]))) { row = injected; injected = null; }
    else row = await rd.next();
    if (!row) break;
    const s = BigInt(row[0]);
    if (s <= last) throw new Error(`claim not ascending at ${row[0]}`);
    last = s; n++;
    const { daa, accepted, e } = eventFromClaimRow(row);
    if (!accepted) continue;
    acc++;
    h.add(daa, "", e);
    for (const r of rows.splice(0)) if (!gz.write(r + "\n")) await new Promise((res) => gz.once("drain", res));
  }
  h.flush();
  for (const r of rows.splice(0)) gz.write(r + "\n");
  await new Promise<void>((r) => { file.once("close", () => r()); gz.end(); });
  const out: Record<string, unknown> = { version: STATE_HASH_VERSION, claimRows: n, acceptedRows: acc, units: h.units, events: h.events, finalCumulative: h.cumulative };
  if (holdersPath) {
    const hs = readFileSync(holdersPath, "utf8").split("\n").filter(Boolean).map((l) => { const [address, balance, locked] = l.split("\t"); return { address, balance, locked }; });
    out.balances = balanceStateHash(tick, hs);
  }
  return out;
}

if (process.argv[1]?.endsWith("claimHashes.ts")) {
  claimHashes(arg("claim")!, arg("out")!, arg("tick", "NACHO")!, arg("holders"), arg("deploy"))
    .then((s) => console.log(JSON.stringify(s, null, 1))).catch((e) => { console.error(e); process.exit(1); });
}
