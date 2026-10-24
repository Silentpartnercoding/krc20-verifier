/**
 * Acceptance data (which chain block accepted each tx, its blue score and DAA score).
 * Independent sources only: api.kaspa.org (kaspaApi client) or the dump's own
 * transactions_acceptances + blocks rows (pgstream pass 2/3). Never the Kasplex opScore.
 *
 * DAA from the API path: the accepting block's DAA is fetched exactly when the tx is near a
 * rule boundary; elsewhere it is interpolated from fetched anchors and marked daaExact=false.
 * Rule outcomes only depend on DAA through the activation boundaries, and ordering uses blue score
 * (strictly increasing along the selected chain), so interpolation cannot change a replay result
 * as long as the boundary margin holds; every op inside the margin uses an exact DAA.
 */
import { KaspaApi } from "../sources/kaspaApi.js";
import { bytea, copyRows } from "../sources/streamLoad.js";
import { RANGE } from "./krc20.js";
import { HF_DAA_2026Q1 } from "../script/parse.js";
import type { Acceptance } from "./types.js";

export const BOUNDARIES = [RANGE.krcMinA, RANGE.krcMaxA, RANGE.krcMinB, RANGE.listSend, RANGE.burnChown, HF_DAA_2026Q1];

export async function acceptanceFromApi(api: KaspaApi, txIds: string[], marginDaa = 50_000, log = (_: string) => {}, exactAll = false): Promise<{ map: Map<string, Acceptance>; missing: string[] }> {
  const raw = new Map<string, { hash: string; blue: number }>();
  for (let i = 0; i < txIds.length; i += 1000) {
    const res = await api.searchTransactions(txIds.slice(i, i + 1000), { resolve: "no", acceptance: "accepted" });
    for (const t of res) if (t.is_accepted && t.accepting_block_hash) raw.set(t.transaction_id, { hash: t.accepting_block_hash, blue: Number(t.accepting_block_blue_score) });
    if ((i / 1000) % 50 === 0) log(`acceptance ${Math.min(i + 1000, txIds.length)}/${txIds.length}`);
  }
  // Anchors: one exact block per ~1/64 of the blue-score span, plus extremes.
  const entries = [...raw.values()].sort((a, b) => a.blue - b.blue);
  const anchors = new Map<number, number>(); // blue -> daa
  const exact = async (e: { hash: string; blue: number }) => {
    const b = await api.getBlock(e.hash);
    const daa = Number(b.header.daaScore);
    anchors.set(e.blue, daa);
    return daa;
  };
  if (entries.length) for (let k = 0; k <= 64; k++) await exact(entries[Math.min(entries.length - 1, Math.floor((k * (entries.length - 1)) / 64))]);
  const interp = (blue: number) => {
    const xs = [...anchors.keys()].sort((a, b) => a - b);
    let lo = xs[0], hi = xs[xs.length - 1];
    for (const x of xs) { if (x <= blue) lo = x; if (x >= blue) { hi = x; break; } }
    if (lo === hi) return anchors.get(lo)! + (blue - lo);
    return Math.round(anchors.get(lo)! + ((blue - lo) * (anchors.get(hi)! - anchors.get(lo)!)) / (hi - lo));
  };
  const map = new Map<string, Acceptance>();
  const exactByHash = new Map<string, number>();
  for (const [id, e] of raw) {
    let daa = anchors.get(e.blue) ?? interp(e.blue), isExact = anchors.has(e.blue);
    if (!isExact && (exactAll || BOUNDARIES.some((b) => Math.abs(daa - b) <= marginDaa))) {
      daa = exactByHash.get(e.hash) ?? (await exact(e));
      exactByHash.set(e.hash, daa);
      isExact = true;
    }
    map.set(id, { blueScore: e.blue, daaScore: daa, blockHash: e.hash, daaExact: isExact });
  }
  return { map, missing: txIds.filter((id) => !raw.has(id)) };
}

/** Exact acceptance from the dump: acceptances.tsv.gz (tx -> block) + blocks.tsv.gz (block -> blue/daa). */
export async function acceptanceFromStream(dir: string): Promise<Map<string, Acceptance>> {
  const blocks = new Map<string, { blue: number; daa: number }>();
  for await (const r of copyRows(`${dir}/blocks.tsv.gz`)) blocks.set(bytea(r[0])!, { blue: Number(r[6]), daa: Number(r[8]) });
  const map = new Map<string, Acceptance>();
  for await (const r of copyRows(`${dir}/acceptances.tsv.gz`)) {
    const b = blocks.get(bytea(r[1])!);
    if (b) map.set(bytea(r[0])!, { blueScore: b.blue, daaScore: b.daa, blockHash: bytea(r[1])!, daaExact: true });
  }
  return map;
}
