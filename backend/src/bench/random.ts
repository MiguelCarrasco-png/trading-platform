/**
 * bench/random.ts
 *
 * Seeded pseudo-random numbers so synthetic workloads, delay jitter and trace
 * sampling are reproducible from the seed recorded in the manifest.
 *
 * Inputs:  32-bit integer seed.
 * Outputs: Uniform [0, 1) generator and helpers.
 */

/** mulberry32: small, fast, good enough for workload generation (not crypto). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exponential variate with the given mean (Poisson inter-arrival times). */
export function exponential(rand: () => number, mean: number): number {
  return -Math.log(1 - rand()) * mean;
}

/** Integer in [min, max]. */
export function intBetween(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}
