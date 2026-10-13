/**
 * tests/core/rollingWindowGuards.test.ts
 *
 * Audit finding 2: a quote with an unparseable timestamp normalized to
 * ts = NaN, and a NaN item at the front of a rolling window stopped eviction
 * from removing anything behind it. Non-finite timestamps are now ignored.
 */

import { RollingTimeWindow, RollingNumericWindow } from "../../core/state/rollingWindow";

describe("rolling windows ignore items they cannot place in time", () => {
  it("a NaN timestamp no longer wedges eviction", () => {
    const w = new RollingTimeWindow<number>(1_000);
    w.push({ ts: Number.NaN, value: -1 });
    w.push({ ts: 0, value: 0 });
    w.push({ ts: 500, value: 1 });
    w.push({ ts: 2_000, value: 2 });
    expect(w.getValues()).toEqual([2]);
  });

  it("ignores infinite timestamps too", () => {
    const w = new RollingTimeWindow<number>(1_000);
    w.push({ ts: Infinity, value: 9 });
    w.push({ ts: -Infinity, value: 9 });
    w.push({ ts: 10, value: 1 });
    expect(w.size()).toBe(1);
  });

  it("keeps a numeric window's sums consistent with what it holds", () => {
    const w = new RollingNumericWindow(1_000);
    w.push({ ts: 0, value: 10 });
    w.push({ ts: Number.NaN, value: 1_000_000 });
    w.push({ ts: 100, value: 20 });
    expect(w.size()).toBe(2);
    expect(w.mean()).toBe(15);
    expect(w.stdDev()).toBeCloseTo(Math.SQRT2 * 5, 12);
  });
});
