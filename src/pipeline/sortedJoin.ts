/** Helpers to walk gzipped, key-sorted TSV files in lockstep (merge join). Keys compare as plain JS strings (= C-locale sort of ASCII hex). */
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

export class LineReader {
  private it: AsyncIterator<string>;
  peeked: string[] | null = null;
  done = false;
  lines = 0;
  private lastKey: string | null = null;
  constructor(path: string, gz = path.endsWith(".gz")) {
    const s = createReadStream(path);
    this.it = createInterface({ input: gz ? s.pipe(createGunzip()) : s, crlfDelay: Infinity })[Symbol.asyncIterator]();
  }
  async peek(): Promise<string[] | null> {
    while (this.peeked === null && !this.done) {
      const r = await this.it.next();
      if (r.done) { this.done = true; break; }
      if (!r.value) continue;
      this.lines++;
      this.peeked = r.value.split("\t");
    }
    return this.peeked;
  }
  async next(): Promise<string[] | null> { const p = await this.peek(); this.peeked = null; return p; }
  /**
   * Take all consecutive rows whose key (via keyOf) equals k; rows with smaller keys are skipped and counted.
   * Throws if the file's keys ever decrease (unsorted input would otherwise silently drop rows from the join).
   */
  async takeKey(k: string, keyOf: (r: string[]) => string, onSkip?: (r: string[]) => void): Promise<string[][]> {
    const out: string[][] = [];
    for (;;) {
      const r = await this.peek();
      if (!r) return out;
      const rk = keyOf(r);
      if (this.lastKey !== null && rk < this.lastKey) throw new Error(`input not sorted: key ${rk} after ${this.lastKey} (sort with LC_ALL=C)`);
      this.lastKey = rk;
      if (rk < k) { onSkip?.(r); this.peeked = null; continue; }
      if (rk > k) return out;
      out.push(r); this.peeked = null;
    }
  }
}
