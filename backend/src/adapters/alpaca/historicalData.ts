/**
 * adapters/alpaca/historicalData.ts
 *
 * Historical quotes and trades from Alpaca's market data REST API. Pages
 * through every record for one symbol in [start, end) on an explicit feed,
 * through a per-process rate limiter so every caller together stays inside the
 * plan's request budget. 429s and 5xx are retried by alpacaGet.
 *
 * Records come back raw — Alpaca's field names and nanosecond timestamp
 * strings — so a cache stores exactly what Alpaca sent. Normalize them with
 * normalizeQuote / normalizeTrade.
 *
 * Free plan: SIP history is available except for the latest 15 minutes;
 * a request reaching into that window fails with 403.
 *
 * Inputs:  Kind, symbol, window, feed.
 * Outputs: Raw records with start <= t < end, ascending.
 */

import { env } from "../../config/env";
import { alpacaGet, type AlpacaCredentials } from "./rest";
import { RateLimiter } from "../../utils/rateLimiter";
import { FileTickCache } from "../localfs/fileTickCache";
import { CachedTickSource, type HistoricalTickSource } from "../../core/backtest/tickSource";
import type { HistoricalFeed, RawTick, TickKind } from "../../types/market";

export const ALPACA_DATA_URL = "https://data.alpaca.markets/v2";

/** Alpaca's maximum page size for quotes and trades. */
const PAGE_LIMIT = 10_000;

const DEFAULT_REQUESTS_PER_MINUTE = 190;

type Page = Partial<Record<TickKind, RawTick[] | null>> & { next_page_token?: string | null };

let sharedLimiter: RateLimiter | null = null;

/** One limiter per process: the budget belongs to the account, not to a caller. */
function processLimiter(): RateLimiter {
  sharedLimiter ??= new RateLimiter(env.alpacaDataRequestsPerMinute || DEFAULT_REQUESTS_PER_MINUTE);
  return sharedLimiter;
}

export class AlpacaHistoricalClient {
  constructor(
    private readonly creds: AlpacaCredentials = { key: env.alpacaDataKey, secret: env.alpacaDataSecret },
    private readonly limiter: RateLimiter = processLimiter(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = ALPACA_DATA_URL,
  ) {}

  /**
   * Every record of `kind` for `symbol` with startMs <= t < endMs.
   * @throws when Alpaca rejects the request (bad symbol, no entitlement, 403 on recent SIP data)
   */
  async fetch(kind: TickKind, symbol: string, startMs: number, endMs: number, feed: HistoricalFeed): Promise<RawTick[]> {
    const records: RawTick[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        start: new Date(startMs).toISOString(),
        // Alpaca's end is inclusive; the trim below makes the window half-open.
        end: new Date(endMs).toISOString(),
        feed,
        limit: String(PAGE_LIMIT),
        ...(pageToken ? { page_token: pageToken } : {}),
      });
      const path = `/stocks/${encodeURIComponent(symbol)}/${kind}?${params.toString()}`;
      const page = await this.limiter.schedule(() => alpacaGet<Page>(this.baseUrl, path, this.creds, this.fetchImpl));
      for (const record of page[kind] ?? []) {
        if (Date.parse(record.t) < endMs) records.push(record);
      }
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    return records;
  }
}

/** The tick source backtests use: the local file cache in front of Alpaca, on one feed. */
export function createTickSource(feed: HistoricalFeed): HistoricalTickSource {
  return new CachedTickSource(new FileTickCache(env.marketDataDir), new AlpacaHistoricalClient(), feed);
}
