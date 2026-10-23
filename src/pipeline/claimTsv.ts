/**
 * Kasplex oplist claim -> TSV for merge comparison. CLAIM ONLY: never replay input.
 *   tsx src/pipeline/claimTsv.ts --claim data/kasplex/NACHO --out claim.tsv.gz
 * Columns: hashRev opScore op opAccept opError amt from to feeRev txAccept price
 * Sort afterwards with: LC_ALL=C sort -t$'\t' -k1,1
 */
import { createReadStream, createWriteStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { createGunzip, createGzip } from "node:zlib";
import { createInterface } from "node:readline";

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
export const CLAIM_COLS = ["hashRev", "opScore", "op", "opAccept", "opError", "amt", "from", "to", "feeRev", "txAccept", "price"] as const;
export const claimRow = (o: Record<string, unknown>) => CLAIM_COLS.map((k) => String(o[k] ?? "").replace(/[\t\n]/g, " ")).join("\t");

async function main() {
  const dir = arg("claim")!, out = arg("out")!;
  const gz = createGzip({ level: 1 });
  const file = createWriteStream(out);
  gz.pipe(file);
  let n = 0;
  const files = readdirSync(`${dir}/ops`).filter((x) => x.endsWith(".jsonl.gz")).sort();
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(`${dir}/ops/${f}`).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      if (!gz.write(claimRow(JSON.parse(line)) + "\n")) await new Promise((r) => gz.once("drain", r));
      n++;
    }
  }
  if (existsSync(`${dir}/deploy.json`)) {
    const d = JSON.parse(readFileSync(`${dir}/deploy.json`, "utf8"));
    const op = Array.isArray(d) ? d[0] : d.result?.[0] ?? d;
    gz.write(claimRow(op) + "\n"); n++;
  }
  await new Promise<void>((r) => { file.once("close", () => r()); gz.end(); });
  console.error(`claim rows: ${n}`);
}
if (process.argv[1]?.endsWith("claimTsv.ts")) main().catch((e) => { console.error(e); process.exit(1); });
