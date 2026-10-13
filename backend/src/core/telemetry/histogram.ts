/**
 * core/telemetry/histogram.ts
 *
 * Fixed-memory latency histogram. Values are non-negative integers
 * (nanoseconds by convention). Buckets are log-linear: exact below 128, then
 * 128 linear sub-buckets per power of two, so any reported percentile is within
 * 1/128 (< 0.8%) of a value that was actually recorded. Memory is one
 * Float64Array of 6,016 counts (47 KB) regardless of how many values are recorded.
 *
 * Percentiles are computed from bucket counts, never by averaging other
 * percentiles: merge() adds counts, so per-interval histograms combine into a
 * correct session distribution.
 *
 * Inputs:  Integer durations.
 * Outputs: Counts, min/max, percentiles, and a mergeable sparse export.
 */

const SUB_BUCKET_BITS = 7;
const SUB_BUCKETS = 1 << SUB_BUCKET_BITS; // 128
/** Values up to 2^53 (Number.MAX_SAFE_INTEGER range) are bucketed. */
const MAX_EXPONENT = 52;
const BUCKET_COUNT = SUB_BUCKETS + (MAX_EXPONENT - SUB_BUCKET_BITS + 1) * SUB_BUCKETS;
const MAX_TRACKABLE = 2 ** (MAX_EXPONENT + 1) - 1;
const EMPTY = new Float64Array(0);

/** Sparse, JSON-safe histogram export. Bucket indexes are stable across versions with the same layout. */
export interface HistogramJSON {
  layout: "log-linear-7";
  unit: string;
  count: number;
  min: number | null;
  max: number | null;
  sum: number;
  /** Values above the trackable range, counted but not bucketed. */
  overflow: number;
  buckets: Array<[number, number]>;
}

function exponentOf(v: number): number {
  // Below 2^32 an integer's exponent is exact from its leading-zero count.
  if (v < 4294967296) return 31 - Math.clz32(v);
  let e = Math.floor(Math.log2(v));
  // log2 can be off by one at exact powers of two in floating point.
  if (2 ** e > v) e--;
  else if (2 ** (e + 1) <= v) e++;
  return e;
}

/** Bucket index for a non-negative integer value. */
export function bucketIndex(v: number): number {
  if (v < SUB_BUCKETS) return v;
  if (v < 4294967296) {
    // Bit arithmetic: exponent from leading zeros, sub-bucket from the next 7 bits.
    const e = 31 - Math.clz32(v);
    return ((e - SUB_BUCKET_BITS + 1) << SUB_BUCKET_BITS) + ((v >>> (e - SUB_BUCKET_BITS)) & (SUB_BUCKETS - 1));
  }
  const e = exponentOf(v);
  const width = 2 ** (e - SUB_BUCKET_BITS);
  const sub = Math.floor((v - 2 ** e) / width);
  return SUB_BUCKETS + (e - SUB_BUCKET_BITS) * SUB_BUCKETS + sub;
}

/** Largest value that maps to the bucket: a conservative percentile estimate. */
export function bucketUpperBound(index: number): number {
  if (index < SUB_BUCKETS) return index;
  const k = index - SUB_BUCKETS;
  const e = Math.floor(k / SUB_BUCKETS) + SUB_BUCKET_BITS;
  const sub = k % SUB_BUCKETS;
  const width = 2 ** (e - SUB_BUCKET_BITS);
  return 2 ** e + (sub + 1) * width - 1;
}

export class Histogram {
  /** Allocated on first record, so unused histograms cost nothing. */
  private counts: Float64Array = EMPTY;
  private _count = 0;
  private _sum = 0;
  private _min = Infinity;
  private _max = -Infinity;
  private _overflow = 0;

  constructor(readonly unit = "ns") {}

  /**
   * Records one value. Negative or non-finite values are a caller bug and are
   * rejected rather than silently clipped; route signed quantities through two
   * histograms (see LatencyProbe's negative event-age handling).
   */
  record(value: number | bigint): void {
    const v = typeof value === "bigint" ? Number(value) : Number.isInteger(value) ? value : Math.round(value);
    if (!(v >= 0) || v === Infinity) {
      throw new RangeError(`Histogram.record: value must be a non-negative finite number (got ${String(value)})`);
    }
    this._count++;
    this._sum += v;
    if (v < this._min) this._min = v;
    if (v > this._max) this._max = v;
    if (v > MAX_TRACKABLE) {
      this._overflow++;
      return;
    }
    if (this.counts === EMPTY) this.counts = new Float64Array(BUCKET_COUNT);
    this.counts[bucketIndex(v)]++;
  }

  get count(): number {
    return this._count;
  }

  get min(): number | null {
    return this._count > 0 ? this._min : null;
  }

  get max(): number | null {
    return this._count > 0 ? this._max : null;
  }

  get mean(): number | null {
    return this._count > 0 ? this._sum / this._count : null;
  }

  /**
   * Value at quantile q in [0, 1]: the upper bound of the bucket holding the
   * ceil(q·count)-th smallest value, capped at the recorded maximum. Null when
   * the histogram is empty.
   */
  percentile(q: number): number | null {
    if (this._count === 0) return null;
    if (q <= 0) return this._min;
    if (q >= 1) return this._max;
    const rank = Math.ceil(q * this._count);
    let seen = 0;
    for (let i = 0; i < this.counts.length; i++) {
      const c = this.counts[i];
      if (c === 0) continue;
      seen += c;
      if (seen >= rank) return Math.min(bucketUpperBound(i), this._max);
    }
    // Remaining rank lies in overflow.
    return this._max;
  }

  /** Number of recorded values strictly greater than threshold (bucket-resolution). */
  countAbove(threshold: number): number {
    if (this._count === 0) return 0;
    let above = this._overflow;
    for (let i = 0; i < this.counts.length; i++) {
      const c = this.counts[i];
      if (c !== 0 && bucketUpperBound(i) > threshold) above += c;
    }
    return above;
  }

  /** Adds another histogram's counts into this one. Units must match. */
  merge(other: Histogram): void {
    if (other.unit !== this.unit) throw new Error(`Histogram.merge: unit mismatch (${this.unit} vs ${other.unit})`);
    if (other.counts.length > 0) {
      if (this.counts === EMPTY) this.counts = new Float64Array(BUCKET_COUNT);
      for (let i = 0; i < BUCKET_COUNT; i++) this.counts[i] += other.counts[i];
    }
    this._count += other._count;
    this._sum += other._sum;
    this._overflow += other._overflow;
    if (other._count > 0) {
      this._min = Math.min(this._min, other._min);
      this._max = Math.max(this._max, other._max);
    }
  }

  reset(): void {
    this.counts = EMPTY;
    this._count = 0;
    this._sum = 0;
    this._min = Infinity;
    this._max = -Infinity;
    this._overflow = 0;
  }

  toJSON(): HistogramJSON {
    const buckets: Array<[number, number]> = [];
    for (let i = 0; i < this.counts.length; i++) {
      if (this.counts[i] !== 0) buckets.push([i, this.counts[i]]);
    }
    return {
      layout: "log-linear-7",
      unit: this.unit,
      count: this._count,
      min: this.min,
      max: this.max,
      sum: this._sum,
      overflow: this._overflow,
      buckets,
    };
  }

  static fromJSON(json: HistogramJSON): Histogram {
    if (json.layout !== "log-linear-7") throw new Error(`Histogram.fromJSON: unknown layout ${json.layout}`);
    const h = new Histogram(json.unit);
    if (json.buckets.length > 0) h.counts = new Float64Array(BUCKET_COUNT);
    for (const [i, c] of json.buckets) h.counts[i] = c;
    h._count = json.count;
    h._sum = json.sum;
    h._overflow = json.overflow;
    if (json.count > 0 && json.min !== null && json.max !== null) {
      h._min = json.min;
      h._max = json.max;
    }
    return h;
  }
}
