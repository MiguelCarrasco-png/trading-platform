jest.mock('../../config/env', () => ({
  env: {
    alpacaApiKey: 'k', alpacaApiSecret: 's', alpacaTradingMode: 'paper',
    alpacaPaperBaseUrl: '', alpacaLiveBaseUrl: '',
    alpacaDataStreamUrl: '', alpacaPaperStreamUrl: '', alpacaLiveStreamUrl: '',
    supabaseUrl: '', supabaseAnonKey: '', supabaseServiceRoleKey: '',
    port: 8080, nodeEnv: 'test', corsOrigin: '', logLevel: 'error',
    defaultRollingWindowMs: 60_000, maxPositionSizeUsd: 1_000_000_000,
    maxNotionalExposureUsd: 1_000_000_000, orderCooldownMs: 0,
    enableLiveTrading: false, enableWebSocketPush: false, databaseUrl: '',
  },
}));

jest.mock('../../core/backtest/backtestLoader');

import { BacktestEngine } from '../../core/backtest/backtestEngine';
import { BacktestLoader } from '../../core/backtest/backtestLoader';
import { DEFAULT_EXECUTION } from '../../core/execution/quoteFillModel';
import type { HistoricalTickSource } from '../../core/backtest/tickSource';
import type { IStrategy } from '../../strategies/base/strategy';
import type { BacktestConfig } from '../../types/backtest';
import type { Bar, Quote } from '../../types/market';
import type { StrategySignal } from '../../types/strategy';
import type { UUID } from '../../types/common';

const MockLoader = BacktestLoader as jest.MockedClass<typeof BacktestLoader>;
const MIN = 60_000;
const T0 = Date.parse('2026-10-07T14:00:00Z'); // 10:00 ET

function bar(ts: number, open: number): Bar {
  return { symbol: 'SPY', open, high: open + 0.05, low: open - 0.05, close: open, volume: 100_000, ts, isoTs: new Date(ts).toISOString(), timeframe: '1Min' };
}

function quote(ts: number, bid: number, ask: number): Quote {
  return {
    symbol: 'SPY', bidPrice: bid, askPrice: ask, bidSize: 100, askSize: 100,
    midPrice: (bid + ask) / 2, spread: ask - bid, microPrice: (bid + ask) / 2, imbalance: 0,
    ts, isoTs: new Date(ts).toISOString(),
  };
}

/** Buys 10 SPY on the bar starting at `buyAt` and sells them on the bar starting at `sellAt`. */
function roundTrip(buyAt: number, sellAt: number): IStrategy {
  return {
    id: 'rt' as UUID, type: 'pairs_trading', triggers: ['bar'],
    config: {
      id: 'rt' as UUID, name: 'round trip', type: 'pairs_trading', symbols: ['SPY'],
      rollingWindowMs: MIN, maxPositionSizeUsd: 1_000_000, cooldownMs: 0, enabled: true,
    },
    start: () => {}, stop: () => {},
    evaluate: (ctx): StrategySignal | null => {
      const b = ctx.symbolState.get('SPY')?.latestBar;
      const direction = b?.ts === buyAt ? 'long' : b?.ts === sellAt ? 'close_long' : null;
      if (!direction) return null;
      return { id: newSig(), strategyId: 'rt', strategyType: 'pairs_trading', symbol: 'SPY', direction, qty: 10, triggerLabel: direction, ts: b!.ts + MIN };
    },
  };
}

let sigs = 0;
const newSig = () => `sig-${++sigs}` as UUID;

function engineWith(bars: Bar[], quotes: Quote[]) {
  MockLoader.mockImplementation(() => ({ streamBars: jest.fn(async function* () { yield bars; }) } as unknown as BacktestLoader));
  const source: HistoricalTickSource = {
    feed: 'sip',
    quotes: jest.fn(async (_s: string, from: number, to: number) => quotes.filter((q) => q.ts >= from && q.ts < to)),
    trades: jest.fn(async () => []),
  };
  return { engine: new BacktestEngine(new BacktestLoader(), { tickSource: () => source }), source };
}

function config(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    id: 'bt', name: 'quote fills',
    strategyConfig: { id: 'rt', name: 'rt', type: 'pairs_trading', symbols: ['SPY'], rollingWindowMs: MIN, maxPositionSizeUsd: 1e9, cooldownMs: 0, enabled: true },
    startDate: new Date(T0).toISOString(), endDate: new Date(T0 + 10 * MIN).toISOString(),
    initialCapital: 100_000, dataGranularity: 'bar', slippageBps: 0, commissionPerShare: 0,
    fillModel: { halfSpreadBps: 0 },
    execution: { ...DEFAULT_EXECUTION, model: 'quote', latencyMs: 250 },
    ...overrides,
  };
}

describe('BacktestEngine — quote fills', () => {
  const bars = [bar(T0, 100), bar(T0 + MIN, 100.2), bar(T0 + 2 * MIN, 100.4), bar(T0 + 3 * MIN, 100.6)];

  it('fills each order at the touch prevailing when it reaches the market, latency after the decision', async () => {
    // Decisions happen when bars complete: the buy at 10:01, the sell at 10:03.
    const quotes = [
      quote(T0 + MIN - 400, 100.09, 100.11), quote(T0 + MIN + 100, 100.12, 100.14),
      quote(T0 + 3 * MIN - 300, 100.49, 100.51),
    ];
    const { engine } = engineWith(bars, quotes);
    const result = await engine.run(config(), () => [roundTrip(T0, T0 + 2 * MIN)]);

    expect(result.fills!.map((f) => [f.side, f.price, f.ts, f.source])).toEqual([
      ['buy', 100.14, T0 + MIN + 250, 'quote'],
      ['sell', 100.49, T0 + 3 * MIN + 250, 'quote'],
    ]);
    // The bar model would have bought at the 10:01 open (100.2) and sold at the 10:03 open (100.6).
    const report = result.metrics.meta!.execution as Record<string, unknown>;
    expect(report).toMatchObject({ model: 'quote', latencyMs: 250, fills: { quote: 2, trade: 0, bar: 0 } });
    expect(report.avgSpreadCostBps).toBeGreaterThan(0);
    expect(result.config.execution).toMatchObject({ model: 'quote', latencyMs: 250 });
  });

  it('prices an order with the next bar when no quote is available, and reports why', async () => {
    const { engine } = engineWith(bars, [quote(T0 + MIN - 400, 100.09, 100.11)]);
    const result = await engine.run(config(), () => [roundTrip(T0, T0 + 2 * MIN)]);

    expect(result.fills!.map((f) => [f.side, f.price, f.source, f.fallbackReason])).toEqual([
      ['buy', 100.11, 'quote', undefined],
      ['sell', 100.6, 'bar', 'no_quote'],
    ]);
    expect((result.metrics.meta!.execution as { fallbacks: unknown }).fallbacks).toEqual({ no_quote: 1 });
  });

  it('can still fill an order decided on the final bar', async () => {
    const { engine } = engineWith(bars, [quote(T0 + 4 * MIN + 10, 100.69, 100.71)]);
    const result = await engine.run(config(), () => [roundTrip(T0 + 3 * MIN, -1)]);
    expect(result.fills!.map((f) => [f.price, f.ts])).toEqual([[100.71, T0 + 4 * MIN + 250]]);
  });

  it('expires a resting DAY limit at the close of its session', async () => {
    const close = Date.parse('2026-10-07T20:00:00Z'); // 16:00 EDT
    const day = [bar(T0, 100), bar(T0 + MIN, 100), bar(close, 100)];
    const passiveBid: IStrategy = {
      ...roundTrip(-1, -1),
      evaluate: (ctx) => (ctx.symbolState.get('SPY')?.latestBar?.ts === T0
        ? {
          id: newSig(), strategyId: 'rt', strategyType: 'pairs_trading', symbol: 'SPY', direction: 'flat', qty: 0, ts: T0,
          meta: { kind: 'maker_quotes', makerQuotes: [{ side: 'buy', price: 99, qty: 10 }], timeInForce: 'day' },
        }
        : null),
    };
    const { engine, source } = engineWith(day, [quote(T0 + MIN - 400, 99.99, 100.01)]);
    const result = await engine.run(config({ endDate: new Date(close + MIN).toISOString() }), () => [passiveBid]);

    expect(result.fills).toHaveLength(0);
    expect(result.orders!.map((o) => o.status)).toEqual(['canceled']);
    expect((result.metrics.meta!.execution as { expiredAtClose: number }).expiredAtClose).toBe(1);
    // The bars never reached 99, so no trades were fetched for the resting bid.
    expect(source.trades).not.toHaveBeenCalled();
  });

  it('keeps the bar model when no execution model is asked for', async () => {
    const { engine, source } = engineWith(bars, []);
    const result = await engine.run(config({ execution: undefined }), () => [roundTrip(T0, T0 + 2 * MIN)]);
    expect(result.fills!.map((f) => f.price)).toEqual([100.2, 100.6]);
    expect(source.quotes).not.toHaveBeenCalled();
    expect(result.metrics.meta).not.toHaveProperty('execution');
  });

  it('refuses quote fills without a tick source, and invalid settings', async () => {
    MockLoader.mockImplementation(() => ({ streamBars: jest.fn(async function* () { yield bars; }) } as unknown as BacktestLoader));
    await expect(new BacktestEngine(new BacktestLoader()).run(config(), () => []))
      .rejects.toThrow('no tick source');
    const { engine } = engineWith(bars, []);
    await expect(engine.run(config({ execution: { ...DEFAULT_EXECUTION, model: 'quote', latencyMs: -5 } }), () => []))
      .rejects.toThrow('Invalid execution config');
  });
});
