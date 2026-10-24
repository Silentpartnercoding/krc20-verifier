/**
 * api.kaspa.org client. Polite by construction:
 *  - token bucket, default 2 req/s, single-digit concurrency (callers await sequentially);
 *  - every response cached on disk (keyed by sha256 of method+url+body) and never refetched;
 *  - POST /transactions/search in batches of <= 1000 ids;
 *  - descriptive User-Agent; retries with exponential backoff (429/5xx/network).
 * The cache directory lives outside git (default data/api).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { TokenBucket, sleep } from "../util/rateLimit.js";

const BASE = "https://api.kaspa.org";
const UA = "krc20-verifier/0.0.1 (independent KRC-20 audit; cached, <=2 req/s)";

export interface ApiOptions { cacheDir?: string; ratePerSec?: number; offline?: boolean }

export class KaspaApi {
  readonly cacheDir: string;
  private bucket: TokenBucket;
  networkCalls = 0;
  private offline: boolean;
  constructor(opts: ApiOptions = {}) {
    this.cacheDir = opts.cacheDir ?? process.env.KASPA_API_CACHE ?? "data/api";
    this.bucket = new TokenBucket(opts.ratePerSec ?? 2, 1);
    this.offline = opts.offline ?? false;
    mkdirSync(this.cacheDir, { recursive: true });
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
    const bodyStr = body === undefined ? "" : JSON.stringify(body);
    const key = createHash("sha256").update(`${method} ${path} ${bodyStr}`).digest("hex");
    const file = join(this.cacheDir, key.slice(0, 2), `${key}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).response;
    if (this.offline) throw new Error(`offline and not cached: ${method} ${path}`);
    for (let attempt = 0; ; attempt++) {
      await this.bucket.take();
      this.networkCalls++;
      try {
        const res = await fetch(BASE + path, {
          method,
          headers: { "user-agent": UA, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
          body: body ? bodyStr : undefined,
          signal: AbortSignal.timeout(60_000), // a frozen socket must fail and retry, not hang
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const json = await res.json();
        mkdirSync(join(this.cacheDir, key.slice(0, 2)), { recursive: true });
        writeFileSync(file + ".tmp", JSON.stringify({ method, path, body: body ?? null, fetchedAt: new Date().toISOString(), response: json }));
        renameSync(file + ".tmp", file);
        return json;
      } catch (e) {
        if (attempt >= 8 || String(e).includes("HTTP 4") && !String(e).includes("429")) throw e;
        await sleep(Math.min(120_000, 2000 * 2 ** attempt));
      }
    }
  }

  getTransaction(txId: string, resolve: "no" | "light" | "full" = "light"): Promise<any> {
    return this.request("GET", `/transactions/${txId}?inputs=true&outputs=true&resolve_previous_outpoints=${resolve}`);
  }

  getBlock(hash: string): Promise<any> {
    return this.request("GET", `/blocks/${hash}?includeTransactions=false`);
  }

  /** POST /transactions/search, batches of <= 1000 ids, results concatenated. */
  async searchTransactions(ids: string[], opts: { resolve?: "no" | "light" | "full"; acceptance?: "accepted" } = {}): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < ids.length; i += 1000) {
      const batch = ids.slice(i, i + 1000);
      const q = new URLSearchParams({ resolve_previous_outpoints: opts.resolve ?? "light" });
      if (opts.acceptance) q.set("acceptance", opts.acceptance);
      out.push(...(await this.request("POST", `/transactions/search?${q}`, { transactionIds: batch })));
    }
    return out;
  }
}
