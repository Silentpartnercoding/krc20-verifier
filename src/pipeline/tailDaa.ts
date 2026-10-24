/**
 * Exact DAA scores for tail accepting blocks (resumable, cached, rate-limited).
 *   tsx src/pipeline/tailDaa.ts --acc tail_acceptance.tsv --out DIR [--rate 1.6]
 * Reads tail_acceptance.tsv (txId accepted block blue daa daaExact acceptingBlockTime), takes the distinct accepting
 * blocks whose daaExact is 0, and fetches GET /blocks/{hash} for each. Every response is cached on disk, so a restart
 * re-reads the cache and continues where it stopped. Writes DIR/block_daa.tsv (block blue daa) at the end and
 * DIR/progress.json every 200 blocks. L1 data only.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { KaspaApi } from "../sources/kaspaApi.js";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const out = arg("out")!;
mkdirSync(out, { recursive: true });
const blocks = new Set<string>();
for (const line of readFileSync(arg("acc")!, "utf8").split("\n")) {
  const f = line.split("\t");
  if (f.length < 6 || f[1] !== "1" || f[5] === "1") continue;
  blocks.add(f[2]);
}
const list = [...blocks].sort();
const api = new KaspaApi({ ratePerSec: Number(arg("rate", "1.6")) });
const rows: string[] = [];
const t0 = Date.now();
const writeAtomic = (p: string, s: string) => { writeFileSync(p + ".tmp", s); renameSync(p + ".tmp", p); };
for (let i = 0; i < list.length; i++) {
  const b = await api.getBlock(list[i]);
  if (b.verboseData?.hash && b.verboseData.hash !== list[i]) throw new Error(`hash mismatch ${list[i]}`);
  rows.push([list[i], Number(b.header.blueScore), Number(b.header.daaScore)].join("\t"));
  if ((i + 1) % 200 === 0 || i + 1 === list.length) {
    const el = (Date.now() - t0) / 1000, net = api.networkCalls;
    const rate = net / Math.max(el, 1);
    writeAtomic(`${out}/progress.json`, JSON.stringify({ done: i + 1, total: list.length, networkCalls: net, elapsedSec: Math.round(el),
      etaSec: rate > 0 ? Math.round((list.length - i - 1) / rate) : null, updatedAt: new Date().toISOString() }) + "\n");
  }
}
writeAtomic(`${out}/block_daa.tsv`, rows.join("\n") + "\n");
console.error(`done ${list.length} blocks, ${api.networkCalls} network calls`);
