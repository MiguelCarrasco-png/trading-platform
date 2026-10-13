/**
 * tests/core/telemetryHistogram.test.ts
 *
 * The fixed-memory latency histogram: bucket arithmetic, percentile accuracy,
 * merge semantics (session percentiles from per-interval histograms) and
 * export round trips.
 */

import { Histogram, bucketIndex, bucketUpperBound } from "../../core/telemetry/histogram";
import { seededRandom } from "../../bench/random";

/** Reference bucketing with powers, for checking the bit-arithmetic fast path. */
function referenceIndex(v: number): number {
  if (v < 128) return v;
  let e = Math.floor(Math.log2(v));
  if (2 ** e > v) e--;
  else if (2 ** (e + 1) <= v) e++;
  const width = 2 ** (e - 7);
  return 128 + (e - 7) * 128 + Math.floor((v - 2 ** e) / width);
}

function exactQuantile(sorted: number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

describe("bucketIndex", () => {
  it("matches the reference at power-of-two boundaries and above 2^32", () => {
    const values: number[] = [];
    for (let e = 0; e <= 52; e++) for (const d of [-1, 0, 1]) values.push(Math.max(0, 2 ** e + d));
    values.push(4294967295, 4294967296, 4294967297, 1e12, 9e15);
    for (const v of values) expect(bucketIndex(v)).toBe(referenceIndex(v));
  });

  it("matches the reference on random values and every value fits its bucket", () => {
    const rand = seededRandom(3);
    for (let i = 0; i < 20_000; i++) {
      const v = Math.floor(rand() ** 4 * 5e10);
      const idx = bucketIndex(v);
      expect(idx).toBe(referenceIndex(v));
      expect(bucketUpperBound(idx)).toBeGreaterThanOrEqual(v);
      if (idx > 0) expect(bucketUpperBound(idx - 1)).toBeLessThan(v);
    }
  });
});

describe("Histogram", () => {
  it("is exact below 128 and reports null when empty", () => {
    const h = new Histogram();
    expect(h.percentile(0.5)).toBeNull();
    expect(h.min).toBeNull();
    for (let v = 0; v < 100; v++) h.record(v);
    expect(h.percentile(0.5)).toBe(49);
    expect(h.percentile(1)).toBe(99);
    expect(h.count).toBe(100);
  });

  it("keeps percentiles within 1/128 of a recorded value", () => {
    const rand = seededRandom(11);
    const values = Array.from({ length: 50_000 }, () => Math.floor(1e5 + rand() ** 3 * 5e7));
    const h = new Histogram();
    values.forEach((v) => h.record(v));
    const sorted = [...values].sort((a, b) => a - b);
    for (const q of [0.5, 0.9, 0.95, 0.99, 0.999]) {
      const exact = exactQuantile(sorted, q);
      const est = h.percentile(q)!;
      expect(est).toBeGreaterThanOrEqual(exact);
      expect((est - exact) / exact).toBeLessThan(1 / 128);
    }
    expect(h.max).toBe(sorted[sorted.length - 1]);
  });

  it("merging per-interval histograms equals recording everything in one", () => {
    const rand = seededRandom(5);
    const whole = new Histogram();
    const parts = [new Histogram(), new Histogram(), new Histogram()];
    for (let i = 0; i < 30_000; i++) {
      const v = Math.floor(rand() * 1e9);
      whole.record(v);
      parts[i % 3].record(v);
    }
    const merged = new Histogram();
    parts.forEach((p) => merged.merge(p));
    expect(merged.toJSON()).toEqual(whole.toJSON());
    expect(merged.percentile(0.99)).toBe(whole.percentile(0.99));
  });

  it("round-trips through its sparse JSON export", () => {
    const h = new Histogram();
    [5, 500, 5_000_000, 3e12].forEach((v) => h.record(v));
    const back = Histogram.fromJSON(JSON.parse(JSON.stringify(h.toJSON())));
    expect(back.toJSON()).toEqual(h.toJSON());
    expect(back.percentile(0.75)).toBe(h.percentile(0.75));
  });

  it("rejects negative and non-finite values instead of clipping them", () => {
    const h = new Histogram();
    expect(() => h.record(-1)).toThrow(RangeError);
    expect(() => h.record(Number.NaN)).toThrow(RangeError);
    expect(() => h.record(Infinity)).toThrow(RangeError);
    expect(h.count).toBe(0);
  });

  it("counts values above a deadline and refuses to merge different units", () => {
    const h = new Histogram();
    [1e6, 2e6, 20e6, 30e6].forEach((v) => h.record(v));
    expect(h.countAbove(10e6)).toBe(2);
    expect(() => h.merge(new Histogram("bytes"))).toThrow(/unit mismatch/);
  });
});
