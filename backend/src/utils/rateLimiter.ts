/**
 * utils/rateLimiter.ts
 *
 * Spaces calls to an API with a per-minute request budget. Each call waits
 * for its own slot, so a burst of N requests takes N × (60 s / perMinute)
 * instead of tripping the provider's limit and burning retries on 429s.
 *
 * Runs on the real wall clock, never the simulated one: a backtest installs a
 * clock override for its whole run, but the provider counts real seconds.
 *
 * Inputs:  Requests per minute; async functions to run.
 * Outputs: Each function's result, started no sooner than its slot.
 */

export class RateLimiter {
  private readonly intervalMs: number;
  private nextSlotMs = 0;

  constructor(
    perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!(perMinute > 0)) throw new Error(`RateLimiter needs a positive per-minute budget, got ${perMinute}`);
    this.intervalMs = 60_000 / perMinute;
  }

  /** Runs `fn` once its slot comes up; slots are handed out in call order. */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlotMs);
    this.nextSlotMs = slot + this.intervalMs;
    if (slot > now) await this.sleep(slot - now);
    return fn();
  }
}
