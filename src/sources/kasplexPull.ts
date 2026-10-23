/**
 * Kasplex claim fetcher for one KRC-20 tick (default NACHO).
 *
 * Kasplex is the audited party: this data is the CLAIM, never the source of truth.
 *
 * API semantics (probed 2026-10-20, [V]):
 *  - GET /v1/krc20/oplist?tick=T&next=X  -> up to 50 ops with opScore < X, descending.
 *  - The tick-filtered oplist does not include the deploy op; it is fetched via /v1/krc20/op/{opScore}.
 *  - Rate limit headers: x-ratelimit-limit 1000 per 60 s.
 *
 * Snapshot: the ceiling opScore is fixed at the first run (stored in state.json), so the pull is a
 * deterministic snapshot "all ops with opScore < ceiling". The opScore range is split into segments
 * processed by a small worker pool; each segment's cursor is persisted after every page (resumable).
 * Output: one gzipped JSONL file per segment, raw op objects as returned (including `checkpoint`).
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { TokenBucket, sleep } from "../util/rateLimit.js";

const BASE = "https://api.kasplex.org/v1";
const UA = "krc20-verifier/0.0.1 (independent KRC-20 audit; polite, cached)";
const tick = (process.env.TICK ?? "NACHO").toUpperCase();
const out = process.env.OUT ?? `data/kasplex/${tick}`;
const RATE = Number(process.env.RATE ?? 12); // req/s, below 1000/60 = 16.7
const WORKERS = Number(process.env.WORKERS ?? 6);
const SEGMENTS = Number(process.env.SEGMENTS ?? 600);

interface Segment { id: number; lo: string; hi: string; cursor: string; done: boolean; ops: number; pages: number }
interface State { tick: string; startedAt: string; ceiling: string; floor: string; info: unknown; token: unknown; deploy: unknown; segments: Segment[] }

const bucket = new TokenBucket(RATE, RATE);
let requests = 0;

async function getJson(url: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    await bucket.take();
    requests++;
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
      if (res.status === 429) {
        const reset = Number(res.headers.get("x-ratelimit-reset") ?? 30);
        log(`429 on ${url}; sleeping ${reset}s`);
        await sleep(reset * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.message !== "successful" && j.message !== "synced") throw new Error(`api message ${j.message}`);
      return j;
    } catch (e) {
      const wait = Math.min(60_000, 1000 * 2 ** attempt);
      log(`error ${String(e)} on ${url}; retry in ${wait} ms`);
      await sleep(wait);
    }
  }
}

function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
  appendFileSync(join(out, "pull.log"), line);
}

function saveState(s: State) {
  const tmp = join(out, "state.json.tmp");
  writeFileSync(tmp, JSON.stringify(s, null, 1));
  renameSync(tmp, join(out, "state.json"));
}

async function init(): Promise<State> {
  const info = (await getJson(`${BASE}/info`)).result;
  const token = (await getJson(`${BASE}/krc20/token/${tick}`)).result[0];
  const deploy = (await getJson(`${BASE}/krc20/op/${token.opScoreAdd}`)).result[0];
  // Fix ceiling: newest op + 1 at start time.
  const newest = (await getJson(`${BASE}/krc20/oplist?tick=${tick}`)).result[0];
  const ceiling = (BigInt(newest.opScore) + 1n).toString();
  const floor = token.opScoreAdd as string;
  const lo = BigInt(floor), hi = BigInt(ceiling);
  const step = (hi - lo) / BigInt(SEGMENTS) + 1n;
  const segments: Segment[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const a = lo + step * BigInt(i);
    if (a >= hi) break;
    const b = a + step < hi ? a + step : hi;
    segments.push({ id: i, lo: a.toString(), hi: b.toString(), cursor: b.toString(), done: false, ops: 0, pages: 0 });
  }
  writeFileSync(join(out, "token.json"), JSON.stringify(token));
  writeFileSync(join(out, "deploy.json"), JSON.stringify(deploy));
  writeFileSync(join(out, "info-at-start.json"), JSON.stringify(info));
  return { tick, startedAt: new Date().toISOString(), ceiling, floor, info, token, deploy, segments };
}

async function runSegment(s: State, seg: Segment) {
  const file = join(out, "ops", `seg-${String(seg.id).padStart(4, "0")}.jsonl.gz`);
  while (!seg.done) {
    const j = await getJson(`${BASE}/krc20/oplist?tick=${tick}&next=${seg.cursor}`);
    const page: any[] = j.result;
    const keep = page.filter((o) => BigInt(o.opScore) >= BigInt(seg.lo));
    if (keep.length) {
      // Each page appended as its own gzip member (valid multi-member gzip), written before the cursor moves.
      appendFileSync(file, gzipSync(keep.map((o) => JSON.stringify(o)).join("\n") + "\n"));
      seg.ops += keep.length;
    }
    seg.pages++;
    if (page.length < 50 || keep.length < page.length) seg.done = true;
    else seg.cursor = page[page.length - 1].opScore;
    saveState(s);
  }
}

async function main() {
  mkdirSync(join(out, "ops"), { recursive: true });
  const statePath = join(out, "state.json");
  const s: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : await init();
  saveState(s);
  log(`tick ${tick} ceiling ${s.ceiling} floor ${s.floor} segments ${s.segments.length} remaining ${s.segments.filter((x) => !x.done).length}`);
  const queue = s.segments.filter((x) => !x.done);
  // A segment interrupted mid-page may have appended its last page before the cursor was saved;
  // duplicates are removed by (opScore) at load time.
  const t0 = Date.now();
  const timer = setInterval(() => {
    const ops = s.segments.reduce((a, x) => a + x.ops, 0);
    const done = s.segments.filter((x) => x.done).length;
    log(`progress ops=${ops} segmentsDone=${done}/${s.segments.length} requests=${requests} rate=${(requests / ((Date.now() - t0) / 1000)).toFixed(1)}/s`);
  }, 60_000);
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      for (let seg = queue.shift(); seg; seg = queue.shift()) await runSegment(s, seg);
    }),
  );
  clearInterval(timer);
  const ops = s.segments.reduce((a, x) => a + x.ops, 0);
  log(`DONE ops=${ops} requests=${requests}`);
  writeFileSync(join(out, "DONE"), JSON.stringify({ ops, finishedAt: new Date().toISOString() }));
}

main().catch((e) => {
  log(`FATAL ${e?.stack ?? e}`);
  process.exit(1);
});
