/**
 * core/backtest/tickSource.ts
 *
 * Historical quotes and trades for one symbol over a short window: from the
 * tick cache when stored windows cover it, otherwise from Alpaca, after which
 * the fetched window is cached. Quote-based fill simulation reads this; it
 * never feeds strategies or symbol state.
 *
 * The cache is an optimization: a cache that cannot be read or written makes
 * a run slower, never wrong.
 *
 * Inputs:  Symbol and window; a TickCache and a fetcher (AlpacaHistoricalClient).
 * Outputs: Normalized Quote / Trade arrays in time order.
 */

import { normalizeQuote, normalizeTrade } from "../../adapters/alpaca/normalizer";
import { logger } from "../../utils/logger";
import type { TickCache } from "./tickCache";
import type { HistoricalFeed, Quote, RawTick, TickKind, Trade } from "../../types/market";

/** Fetches raw records for a window; AlpacaHistoricalClient implements it. */
export interface TickFetcher {
  fetch(kind: TickKind, symbol: string, startMs: number, endMs: number, feed: HistoricalFeed): Promise<RawTick[]>;
}

export interface HistoricalTickSource {
  /** Feed the records come from. */
  readonly feed: HistoricalFeed;
  /** Quotes with startMs <= ts < endMs, in time order. */
  quotes(symbol: string, startMs: number, endMs: number): Promise<Quote[]>;
  /** Trades with startMs <= ts < endMs, in time order. */
  trades(symbol: string, startMs: number, endMs: number): Promise<Trade[]>;
}

export class CachedTickSource implements HistoricalTickSource {
  /** Windows fetched from Alpaca because the cache did not cover them. */
  fetchedWindows = 0;

  constructor(
    private readonly cache: TickCache,
    private readonly fetcher: TickFetcher,
    readonly feed: HistoricalFeed = "sip",
  ) {}

  async quotes(symbol: string, startMs: number, endMs: number): Promise<Quote[]> {
    const records = await this._load("quotes", symbol, startMs, endMs);
    return records.map((r) => normalizeQuote({ ...r, S: symbol } as never));
  }

  async trades(symbol: string, startMs: number, endMs: number): Promise<Trade[]> {
    const records = await this._load("trades", symbol, startMs, endMs);
    return records.map((r) => normalizeTrade({ ...r, S: symbol } as never));
  }

  private async _load(kind: TickKind, symbol: string, startMs: number, endMs: number): Promise<RawTick[]> {
    try {
      const cached = await this.cache.read(kind, this.feed, symbol, startMs, endMs);
      if (cached) return cached;
    } catch (err) {
      logger.warn("CachedTickSource: tick cache unreadable, fetching from Alpaca", { kind, symbol, err: String(err) });
    }

    this.fetchedWindows++;
    const records = await this.fetcher.fetch(kind, symbol, startMs, endMs, this.feed);
    try {
      await this.cache.write(kind, this.feed, symbol, startMs, endMs, records);
    } catch (err) {
      logger.warn("CachedTickSource: tick cache write failed — window stays uncached", { kind, symbol, err: String(err) });
    }
    return records;
  }
}
