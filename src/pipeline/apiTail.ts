/**
 * api.kaspa.org lookups for the streaming pipeline (L1 data; cached, <= 2 req/s via KaspaApi).
 *
 *   status: tsx src/pipeline/apiTail.ts --mode status --ids ids.txt --out status.tsv
 *     For dump txs with no dump acceptance row: is the tx accepted on L1 (api.kaspa.org)? If so, exact
 *     accepting block, blue score and DAA (GET /blocks/{hash} header). Columns:
 *     txId accepted acceptingBlock blue daa acceptingBlockTime blockTime nContainingBlocks
 *     `accepted` rows can be appended to the acc_by_tx file (txId block blue daa) and prep re-run, so the
 *     supplement covers EVERY dump NACHO tx lacking dump acceptance, not only ones the claim names.
 *
 *   tail:   tsx src/pipeline/apiTail.ts --mode tail --ids ids.txt --out DIR
 *     For tx ids the claim lists after the dump window (the claim only says WHICH ids to fetch; content
 *     and acceptance come from api.kaspa.org): fetch full txs (resolve_previous_outpoints=full), acceptance
 *     via acceptanceFromApi (exact DAA near rule boundaries, interpolated elsewhere and flagged), extract
 *     ops and write compact candidate lines in prep.ts format. Writes DIR/tail_candidates.unsorted.tsv.gz,
 *     DIR/tail_acceptance.tsv (txId accepted block blue daa daaExact acceptingBlockTime), DIR/tail_stats.json.
 */
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createGzip } from "node:zlib";
import { KaspaApi } from "../sources/kaspaApi.js";
import { apiTxToRaw } from "../sources/apiTx.js";
import { acceptanceFromApi } from "../replay/acceptance.js";
import { extractOps } from "../replay/extract.js";
import { compactLine, toCompact } from "./compact.js";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const log = (s: string) => console.error(`${new Date().toISOString()} ${s}`);
const readIds = (p: string) => [...new Set(readFileSync(p, "utf8").split("\n").map((x) => x.trim().toLowerCase()).filter((x) => /^[0-9a-f]{64}$/.test(x)))];

export async function status(api: KaspaApi, ids: string[], outPath: string) {
  const rows: string[] = [];
  const st = { ids: ids.length, found: 0, accepted: 0, notAccepted: 0, notFound: 0 };
  const found = new Map<string, any>();
  for (const t of await api.searchTransactions(ids, { resolve: "no" })) found.set(t.transaction_id, t);
  for (const id of ids) {
    const t = found.get(id);
    if (!t) { st.notFound++; rows.push([id, "notfound", "", "", "", "", "", ""].join("\t")); continue; }
    st.found++;
    if (t.is_accepted && t.accepting_block_hash) {
      st.accepted++;
      const b = await api.getBlock(t.accepting_block_hash);
      rows.push([id, "1", t.accepting_block_hash, Number(b.header.blueScore), Number(b.header.daaScore), t.accepting_block_time ?? "", t.block_time ?? "", (t.block_hash ?? []).length].join("\t"));
    } else { st.notAccepted++; rows.push([id, "0", "", "", "", "", t.block_time ?? "", (t.block_hash ?? []).length].join("\t")); }
  }
  writeFileSync(outPath, rows.join("\n") + "\n");
  return st;
}

export async function tail(api: KaspaApi, ids: string[], outDir: string) {
  mkdirSync(outDir, { recursive: true });
  const fetched: any[] = [];
  for (let i = 0; i < ids.length; i += 1000) {
    fetched.push(...(await api.searchTransactions(ids.slice(i, i + 1000), { resolve: "full" })));
    log(`tail fetched ${Math.min(i + 1000, ids.length)}/${ids.length}`);
  }
  const acc = await acceptanceFromApi(api, ids, 50_000, log);
  const gz = createGzip({ level: 1 }), file = createWriteStream(`${outDir}/tail_candidates.unsorted.tsv.gz`);
  gz.pipe(file);
  const accRows: string[] = [];
  const st = { ids: ids.length, fetched: fetched.length, accepted: 0, notAccepted: 0, notFound: 0, withOps: 0, daaExact: 0, opsByOp: {} as Record<string, number>, minBlue: Number.MAX_SAFE_INTEGER, maxBlue: 0, minAcceptingTime: Number.MAX_SAFE_INTEGER, maxAcceptingTime: 0 };
  const byId = new Map(fetched.map((t) => [t.transaction_id, t]));
  for (const id of ids) {
    const t = byId.get(id);
    if (!t) { st.notFound++; accRows.push(`${id}\tnotfound\t\t\t\t\t`); continue; }
    const a = acc.map.get(id);
    if (!a) { st.notAccepted++; accRows.push(`${id}\t0\t\t\t\t\t`); continue; }
    st.accepted++; if (a.daaExact) st.daaExact++;
    const at = Number(t.accepting_block_time ?? 0);
    st.minBlue = Math.min(st.minBlue, a.blueScore); st.maxBlue = Math.max(st.maxBlue, a.blueScore);
    if (at) { st.minAcceptingTime = Math.min(st.minAcceptingTime, at); st.maxAcceptingTime = Math.max(st.maxAcceptingTime, at); }
    accRows.push([id, 1, a.blockHash, a.blueScore, a.daaScore, a.daaExact ? 1 : 0, at].join("\t"));
    const raw = apiTxToRaw(t, a);
    const ops = extractOps(raw);
    if (!ops.length) continue;
    st.withOps++;
    for (const o of ops) st.opsByOp[o.params.op] = (st.opsByOp[o.params.op] ?? 0) + 1;
    if (!gz.write(compactLine(toCompact(raw, ops)) + "\n")) await new Promise((r) => gz.once("drain", r));
  }
  await new Promise<void>((r) => { file.once("close", () => r()); gz.end(); });
  writeFileSync(`${outDir}/tail_acceptance.tsv`, accRows.join("\n") + "\n");
  writeFileSync(`${outDir}/tail_stats.json`, JSON.stringify({ ...st, apiNetworkCalls: api.networkCalls }, null, 1));
  return st;
}

if (process.argv[1]?.endsWith("apiTail.ts")) {
  const api = new KaspaApi({ offline: process.argv.includes("--offline") });
  const ids = readIds(arg("ids")!);
  const p = arg("mode") === "status" ? status(api, ids, arg("out")!) : tail(api, ids, arg("out")!);
  p.then((s) => log(JSON.stringify({ ...s, apiNetworkCalls: api.networkCalls }))).catch((e) => { console.error(e); process.exit(1); });
}
