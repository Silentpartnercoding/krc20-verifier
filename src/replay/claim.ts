/** Kasplex oplist claim loader. CLAIM ONLY: used for comparison, never as input to the replay. */
import { readdirSync, createReadStream, existsSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

export interface ClaimOp { opScore: string; hashRev: string; op: string; opAccept: string; opError: string; amt?: string; from?: string; to?: string; tick?: string; [k: string]: unknown }

export async function loadClaim(dir: string): Promise<Map<string, ClaimOp>> {
  const byTx = new Map<string, ClaimOp>();
  const opsDir = `${dir}/ops`;
  if (!existsSync(opsDir)) return byTx;
  for (const f of readdirSync(opsDir).filter((x) => x.endsWith(".jsonl.gz")).sort()) {
    const rl = createInterface({ input: createReadStream(`${opsDir}/${f}`).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      const o = JSON.parse(line) as ClaimOp;
      byTx.set(o.hashRev, o); // dedupe (crash-resume may repeat a page)
    }
  }
  if (existsSync(`${dir}/deploy.json`)) {
    const { readFileSync } = await import("node:fs");
    const d = JSON.parse(readFileSync(`${dir}/deploy.json`, "utf8"));
    const op = Array.isArray(d) ? d[0] : d.result?.[0] ?? d;
    if (op?.hashRev) byTx.set(op.hashRev, op);
  }
  return byTx;
}
