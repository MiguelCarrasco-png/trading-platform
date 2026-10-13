/**
 * bench/syntheticWorkload.ts
 *
 * Seeded generator of Alpaca-shaped stock-stream frames for load tests. The
 * rates are WORKLOAD PARAMETERS, not a model of real Alpaca/IEX traffic; every
 * artifact produced from this generator is labelled synthetic. Calibrate rates
 * against a real capture (bench capture → metrics events.* / elapsed) before
 * treating a synthetic result as representative.
 *
 * Model: per symbol, quotes and trades arrive as Poisson processes around a
 * one-tick random-walk mid; each event's provider timestamp precedes its local
 * receipt by a small random transport delay (nanosecond digits included).
 * Events that land in the same millisecond share a frame, as batched frames
 * do. A minute bar per symbol arrives a few tens of ms after each minute ends.
 * Burst windows multiply the arrival rate.
 *
 * Inputs:  SyntheticWorkloadOptions (symbols, rates, duration, bursts, seed).
 * Outputs: Iterable of FrameRecord in recorded order.
 */

import { exponential, intBetween, seededRandom } from "./random";
import type { FrameRecord } from "../core/telemetry/frameRecorder";

export interface BurstSpec {
  /** Offset from session start, ms. */
  startMs: number;
  durationMs: number;
  /** Arrival-rate multiplier inside the window. */
  rateMultiplier: number;
}

export interface SyntheticWorkloadOptions {
  symbols: string[];
  durationMs: number;
  quotesPerSecPerSymbol: number;
  tradesPerSecPerSymbol: number;
  seed: number;
  /** Wall time of the first frame. Default: a regular-session Tuesday morning. */
  startWallMs?: number;
  bursts?: BurstSpec[];
  /** Emit minute bars. Default true. */
  bars?: boolean;
}

/** 2026-03-10 14:00:00 UTC = 10:00 New York. */
export const SYNTHETIC_DEFAULT_START_MS = Date.UTC(2026, 2, 10, 14, 0, 0);
const MONO_BASE_NS = 10_000_000_000n;

interface PendingEvent {
  rxNs: number; // receipt offset from start, ns (Number is exact for < 104 days)
  msg: Record<string, unknown>;
}

function isoWithNs(epochNs: bigint): string {
  const ms = Number(epochNs / 1_000_000n);
  const subMs = Number(epochNs % 1_000_000n);
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, (_m, d: string) => `.${d}${String(subMs).padStart(6, "0")}Z`);
}

function rateMultiplierAt(tMs: number, bursts: BurstSpec[]): number {
  let m = 1;
  for (const b of bursts) if (tMs >= b.startMs && tMs < b.startMs + b.durationMs) m *= b.rateMultiplier;
  return m;
}

/**
 * Generates the whole session's events, then yields them grouped into frames.
 * Memory is proportional to the event count (fine for the hour-scale loads
 * this is meant for; use a recording for longer replays).
 */
export function* generateSyntheticFrames(opts: SyntheticWorkloadOptions): Generator<FrameRecord> {
  const rand = seededRandom(opts.seed);
  const startWallMs = opts.startWallMs ?? SYNTHETIC_DEFAULT_START_MS;
  const bursts = opts.bursts ?? [];
  const events: PendingEvent[] = [];
  const durationNs = opts.durationMs * 1e6;

  for (const [si, symbol] of opts.symbols.entries()) {
    let mid = 100 + si * 37.5;
    let tradeId = 1;
    let lastBarMinute = -1;
    let barOpen = mid, barHigh = mid, barLow = mid, barVol = 0, barCount = 0;
    const quoteMeanNs = 1e9 / Math.max(opts.quotesPerSecPerSymbol, 1e-9);
    const tradeMeanNs = 1e9 / Math.max(opts.tradesPerSecPerSymbol, 1e-9);
    let nextQuote = exponential(rand, quoteMeanNs);
    let nextTrade = opts.tradesPerSecPerSymbol > 0 ? exponential(rand, tradeMeanNs) : Infinity;
    if (opts.quotesPerSecPerSymbol <= 0) nextQuote = Infinity;

    const flushBar = (minute: number): void => {
      if (opts.bars === false || barCount === 0) return;
      const intervalEndNs = (minute + 1) * 60_000 * 1e6;
      const rxNs = intervalEndNs + intBetween(rand, 20, 80) * 1e6;
      if (rxNs > durationNs) return;
      events.push({
        rxNs,
        msg: {
          T: "b", S: symbol, o: barOpen, h: barHigh, l: barLow, c: mid, v: barVol, vw: mid, n: barCount,
          t: new Date(startWallMs + minute * 60_000).toISOString().replace(".000Z", "Z"),
        },
      });
    };

    for (;;) {
      const t = Math.min(nextQuote, nextTrade);
      if (t >= durationNs) break;
      const minute = Math.floor(t / 60_000 / 1e6);
      if (minute !== lastBarMinute) {
        if (lastBarMinute >= 0) flushBar(lastBarMinute);
        lastBarMinute = minute;
        barOpen = barHigh = barLow = mid;
        barVol = 0;
        barCount = 0;
      }
      const transportNs = intBetween(rand, 300_000, 4_000_000); // 0.3–4 ms, synthetic
      const providerNs = BigInt(startWallMs) * 1_000_000n + BigInt(Math.max(0, Math.round(t - transportNs)));
      const mult = rateMultiplierAt(t / 1e6, bursts);

      if (t === nextQuote) {
        mid = Math.max(1, Math.round((mid + (rand() < 0.5 ? -0.01 : 0.01) * (rand() < 0.3 ? 1 : 0)) * 100) / 100);
        const halfSpread = intBetween(rand, 1, 3) * 0.005;
        events.push({
          rxNs: t,
          msg: {
            T: "q", S: symbol, bx: "V", ax: "V", c: ["R"], z: "B",
            bp: Math.round((mid - halfSpread) * 100) / 100,
            ap: Math.round((mid + halfSpread) * 100) / 100,
            bs: intBetween(rand, 1, 20), as: intBetween(rand, 1, 20),
            t: isoWithNs(providerNs),
          },
        });
        nextQuote = t + exponential(rand, quoteMeanNs / mult);
      } else {
        const size = intBetween(rand, 1, 300);
        const price = Math.round((mid + (rand() < 0.5 ? -0.005 : 0.005)) * 100) / 100;
        barHigh = Math.max(barHigh, price);
        barLow = Math.min(barLow, price);
        barVol += size;
        barCount++;
        events.push({
          rxNs: t,
          msg: { T: "t", S: symbol, i: tradeId++, x: "V", p: price, s: size, c: ["@"], z: "B", t: isoWithNs(providerNs) },
        });
        nextTrade = t + exponential(rand, tradeMeanNs / mult);
      }
    }
    if (lastBarMinute >= 0) flushBar(lastBarMinute);
  }

  events.sort((a, b) => a.rxNs - b.rxNs);

  let seq = 0;
  let i = 0;
  while (i < events.length) {
    const frameMs = Math.floor(events[i].rxNs / 1e6);
    const batch: Record<string, unknown>[] = [];
    let j = i;
    while (j < events.length && Math.floor(events[j].rxNs / 1e6) === frameMs) batch.push(events[j++].msg);
    const rxNs = events[i].rxNs;
    yield {
      v: 1, type: "frame", epoch: 1, seq: ++seq,
      rx_wall_ms: startWallMs + frameMs,
      rx_mono_ns: (MONO_BASE_NS + BigInt(Math.round(rxNs))).toString(),
      data: JSON.stringify(batch),
    };
    i = j;
  }
}
