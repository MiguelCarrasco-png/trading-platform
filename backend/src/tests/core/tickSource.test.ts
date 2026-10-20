jest.mock('../../config/env', () => ({ env: { logLevel: 'error' } }));

import { CachedTickSource, type TickFetcher } from '../../core/backtest/tickSource';
import type { TickCache } from '../../core/backtest/tickCache';
import type { RawTick } from '../../types/market';

const T = Date.parse('2026-10-07T14:00:00Z');
const RAW_QUOTE: RawTick = { t: '2026-10-07T14:00:01.123456789Z', bp: 99.99, bs: 300, ap: 100.01, as: 200, bx: 'V', ax: 'Q', c: ['R'] };

function memoryCache(initial: RawTick[] | null = null): TickCache & { writes: unknown[][] } {
  const writes: unknown[][] = [];
  return {
    writes,
    read: jest.fn(async () => initial),
    write: jest.fn(async (...args: unknown[]) => { writes.push(args); }),
  };
}

function fetcher(records: RawTick[] = [RAW_QUOTE]): TickFetcher & { fetch: jest.Mock } {
  return { fetch: jest.fn(async () => records) };
}

describe('CachedTickSource', () => {
  it('serves a covered window from the cache without calling Alpaca', async () => {
    const f = fetcher();
    const source = new CachedTickSource(memoryCache([RAW_QUOTE]), f);
    const quotes = await source.quotes('SPY', T, T + 5_000);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(source.fetchedWindows).toBe(0);
    expect(quotes).toHaveLength(1);
  });

  it('fetches an uncovered window on its feed and caches exactly that window', async () => {
    const cache = memoryCache(null);
    const f = fetcher();
    const source = new CachedTickSource(cache, f, 'iex');
    await source.trades('SPY', T, T + 5_000);
    expect(f.fetch).toHaveBeenCalledWith('trades', 'SPY', T, T + 5_000, 'iex');
    expect(cache.writes).toEqual([['trades', 'iex', 'SPY', T, T + 5_000, [RAW_QUOTE]]]);
    expect(source.fetchedWindows).toBe(1);
  });

  it('normalizes quotes, keeping the full-precision timestamp and each side\'s venue', async () => {
    const [q] = await new CachedTickSource(memoryCache([RAW_QUOTE]), fetcher()).quotes('SPY', T, T + 5_000);
    expect(q).toMatchObject({
      symbol: 'SPY', bidPrice: 99.99, askPrice: 100.01, bidSize: 300, askSize: 200,
      midPrice: 100, ts: Date.parse('2026-10-07T14:00:01.123Z'), isoTs: RAW_QUOTE.t,
      bidExchange: 'V', askExchange: 'Q',
    });
  });

  it('still answers when the cache cannot be read or written', async () => {
    const cache: TickCache = {
      read: jest.fn(async () => { throw new Error('disk gone'); }),
      write: jest.fn(async () => { throw new Error('disk full'); }),
    };
    const f = fetcher();
    await expect(new CachedTickSource(cache, f).quotes('SPY', T, T + 5_000)).resolves.toHaveLength(1);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it('lets a fetch failure through so the caller can decide what to do', async () => {
    const f: TickFetcher = { fetch: jest.fn(async () => { throw new Error('Alpaca GET failed (403)'); }) };
    await expect(new CachedTickSource(memoryCache(null), f).quotes('SPY', T, T + 5_000)).rejects.toThrow('(403)');
  });
});
