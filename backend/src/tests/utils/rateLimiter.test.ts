import { RateLimiter } from '../../utils/rateLimiter';

/** A clock that only moves when the limiter sleeps, recording each wait. */
function fakeClock(start = 1_000_000) {
  let now = start;
  const waits: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => { waits.push(ms); now += ms; },
    waits,
  };
}

describe('RateLimiter', () => {
  it('spaces calls evenly across the per-minute budget', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(120, clock.now, clock.sleep); // one slot every 500 ms
    const started: number[] = [];
    await Promise.all([1, 2, 3].map(() => limiter.schedule(async () => { started.push(clock.now()); })));
    expect(clock.waits).toEqual([500, 500]);
    expect(started[0]).toBe(1_000_000);
  });

  it('does not wait once the previous slot has passed', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(60, clock.now, clock.sleep);
    await limiter.schedule(async () => undefined);
    await clock.sleep(5_000);
    clock.waits.length = 0;
    await limiter.schedule(async () => undefined);
    expect(clock.waits).toEqual([]);
  });

  it('returns what the scheduled function returns', async () => {
    const clock = fakeClock();
    await expect(new RateLimiter(60, clock.now, clock.sleep).schedule(async () => 42)).resolves.toBe(42);
  });

  it('rejects a budget that is not positive', () => {
    expect(() => new RateLimiter(0)).toThrow('positive per-minute budget');
  });
});
