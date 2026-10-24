/**
 * Annotate compact candidate lines with the lowest input-creation DAA of each tx (field `mi`), so the engine can apply
 * the archive-input rule (ARCHIVE_INPUT_MIN_DAA in src/replay/krc20.ts).
 *   tsx src/pipeline/inputMinDaa.ts --cands cands.sorted.tsv.gz --mi tx_min_input_daa.tsv --out cands.mi.sorted.tsv.gz
 * --mi: `txId\tminInputDaa` (optionally .gz; repeated txIds allowed, the minimum is kept) (plain hex txId, decimal DAA): for each tx, the minimum accepting DAA score over the txs
 *       that created ALL of its inputs (not only the op's input). Built from L1 data; txs absent from the file keep
 *       no `mi` and the rule is not applied to them. Line order is preserved, so the output stays sorted.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { createGunzip, createGzip } from "node:zlib";
import { createInterface } from "node:readline";

/** Streams the file (it can have ~11M rows); repeated txIds keep the minimum. */
export async function loadMinInputDaa(path: string): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  const src = createReadStream(path);
  const rl = createInterface({ input: path.endsWith(".gz") ? src.pipe(createGunzip()) : src, crlfDelay: Infinity });
  for await (const line of rl) {
    const [id, d] = line.split("\t");
    if (!id || d === undefined || d === "") continue;
    const n = Number(d);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`bad DAA for ${id}: ${d}`);
    const prev = m.get(id);
    if (prev === undefined || n < prev) m.set(id, n);
  }
  return m;
}

/** Returns the line with `mi` set (or unchanged when the tx is not in the map). */
export function annotateLine(line: string, mi: Map<string, number>): { line: string; set: boolean } {
  const t1 = line.indexOf("\t"), t2 = line.indexOf("\t", t1 + 1);
  const id = line.slice(t1 + 1, t2), v = mi.get(id);
  if (v === undefined) return { line, set: false };
  const c = JSON.parse(line.slice(t2 + 1));
  c.mi = v;
  return { line: `${line.slice(0, t2)}\t${JSON.stringify(c)}`, set: true };
}

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
if (process.argv[1]?.endsWith("inputMinDaa.ts")) {
  const cands = arg("cands")!, out = arg("out")!, mi = await loadMinInputDaa(arg("mi")!);
  const src = createReadStream(cands);
  const rl = createInterface({ input: cands.endsWith(".gz") ? src.pipe(createGunzip()) : src, crlfDelay: Infinity });
  const gz = createGzip({ level: 1 }); const file = createWriteStream(out); gz.pipe(file);
  const st = { lines: 0, annotated: 0, miEntries: mi.size };
  for await (const l of rl) {
    if (!l) continue;
    st.lines++;
    const r = annotateLine(l, mi);
    if (r.set) st.annotated++;
    if (!gz.write(r.line + "\n")) await new Promise((res) => gz.once("drain", res));
  }
  await new Promise<void>((res) => { file.once("close", () => res()); gz.end(); });
  console.error(JSON.stringify(st));
}
