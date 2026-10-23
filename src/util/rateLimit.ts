/** Simple token bucket shared by all workers in one process. */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly ratePerSec: number, private readonly burst: number) {
    this.tokens = burst;
  }
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000));
    }
  }
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
