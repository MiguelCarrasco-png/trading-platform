/**
 * core/backtest/tickCache.ts
 *
 * Storage-agnostic contract for cached historical quotes and trades — the
 * tick-level counterpart of BarCache. Quote-based fill simulation reads a few
 * seconds around each order rather than whole days, so coverage is the exact
 * [start, end) windows that were fetched, not per-day completeness.
 *
 * Inputs:  Windows fetched from Alpaca, with every record Alpaca had for them.
 * Outputs: The records for a window, when stored windows cover all of it.
 */

import type { HistoricalFeed, RawTick, TickKind } from "../../types/market";

/** A half-open time range [startMs, endMs). */
export interface TickWindow {
  startMs: number;
  endMs: number;
}

export interface TickCache {
  /**
   * Records with startMs <= t < endMs in time order, when stored windows cover
   * the whole range; null when any part of it was never fetched.
   */
  read(kind: TickKind, feed: HistoricalFeed, symbol: string, startMs: number, endMs: number): Promise<RawTick[] | null>;
  /**
   * Stores every record Alpaca had for [startMs, endMs). An empty list is
   * meaningful: the window is known to be empty.
   */
  write(kind: TickKind, feed: HistoricalFeed, symbol: string, startMs: number, endMs: number, records: RawTick[]): Promise<void>;
}

/** True when the union of `windows` covers all of [startMs, endMs). */
export function windowsCover(windows: readonly TickWindow[], startMs: number, endMs: number): boolean {
  let reached = startMs;
  for (const w of [...windows].sort((a, b) => a.startMs - b.startMs)) {
    if (reached >= endMs) break;
    if (w.startMs > reached) return false;
    if (w.endMs > reached) reached = w.endMs;
  }
  return reached >= endMs;
}
