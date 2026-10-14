jest.mock('../../config/env', () => ({ env: { logLevel: 'error' } }));

import { EventBus } from '../../core/engine/eventBus';
import { SymbolStateManager } from '../../core/state/symbolState';
import { SimulatedExecutionSink } from '../../core/execution/simulatedExecution';
import { DEFAULT_EXECUTION, type ExecutionConfig } from '../../core/execution/quoteFillModel';
import { DEFAULT_FILL_MODEL } from '../../core/execution/fillModel';
import type { HistoricalTickSource } from '../../core/backtest/tickSource';
import type { Bar, Quote, Trade } from '../../types/market';
import type { OrderIntent, Fill } from '../../types/orders';
import type { TradingEvent } from '../../types/events';
import type { UUID } from '../../types/common';

// 10:00 ET on a Wednesday: inside the regular session.
const T = Date.parse('2026-10-07T14:00:00Z');
const MIN = 60_000;
const QUOTE_MODEL: ExecutionConfig = { ...DEFAULT_EXECUTION, model: 'quote', latencyMs: 250 };

function quote(ts: number, bid: number, ask: number): Quote {
  return {
    symbol: 'SPY', bidPrice: bid, askPrice: ask, bidSize: 100, askSize: 100,
    midPrice: (bid + ask) / 2, spread: ask - bid, microPrice: (bid + ask) / 2, imbalance: 0,
    ts, isoTs: new Date(ts).toISOString(),
  };
}

function bar(ts: number, low: number, high: number, open = (low + high) / 2): Bar {
  return { symbol: 'SPY', open, high, low, close: open, volume: 100_000, ts, isoTs: new Date(ts).toISOString(), timeframe: '1Min' };
}

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: `o-${Math.random()}` as UUID, strategyId: 's', symbol: 'SPY', side: 'buy', qty: 10,
    orderType: 'market', timeInForce: 'ioc', ts: T, ...overrides,
  };
}

function source(quotes: Quote[] = [], trades: Trade[] = []): HistoricalTickSource & { trades: jest.Mock; quotes: jest.Mock } {
  return {
    feed: 'sip',
    quotes: jest.fn(async (_s: string, from: number, to: number) => quotes.filter((q) => q.ts >= from && q.ts < to)),
    trades: jest.fn(async (_s: string, from: number, to: number) => trades.filter((t) => t.ts >= from && t.ts < to)),
  };
}

function setup(execution: ExecutionConfig = QUOTE_MODEL) {
  const bus = new EventBus();
  const events: TradingEvent[] = [];
  bus.onAll((e) => { events.push(e); });
  const sink = new SimulatedExecutionSink(bus, new SymbolStateManager(), 'backtest', 0, 0, { ...DEFAULT_FILL_MODEL, halfSpreadBps: 0, slippageBps: 0, commissionPerShare: 0 }, execution);
  const fills = () => events.flatMap((e) => ('fill' in e ? [(e as { fill: Fill }).fill] : []));
  return { sink, events, fills };
}

async function arrive(sink: SimulatedExecutionSink, src: HistoricalTickSource) {
  for (const plan of await sink.planArrivals(src)) sink.applyArrival(plan);
}

describe('SimulatedExecutionSink — quote model', () => {
  it('prices a market order at the quote prevailing on arrival and records the attribution', async () => {
    const { sink, fills } = setup();
    await sink.submitOrder(intent());
    sink.processBarOpen(bar(T, 99, 101)); // the bar model must not touch it
    expect(fills()).toHaveLength(0);

    await arrive(sink, source([quote(T - 500, 99.99, 100.01), quote(T + 100, 100.03, 100.05)]));
    expect(fills()).toEqual([expect.objectContaining({
      price: 100.05, qty: 10, ts: T + 250, source: 'quote', arrivalBid: 100.03, arrivalAsk: 100.05, decisionMid: 100,
    })]);
    expect(sink.pendingCount()).toBe(0);
  });

  it('prices the order with the next bar when its quotes cannot be fetched, and says why', async () => {
    const { sink, fills } = setup();
    await sink.submitOrder(intent());
    const broken: HistoricalTickSource = {
      feed: 'sip',
      quotes: async () => { throw new Error('Alpaca GET failed (403)'); },
      trades: async () => [],
    };
    await arrive(sink, broken);
    expect(fills()).toHaveLength(0);
    sink.processBarOpen(bar(T, 99, 101, 100.5));
    expect(fills()).toEqual([expect.objectContaining({ price: 100.5, source: 'bar', fallbackReason: 'quote_data_unavailable' })]);
    expect(sink.executionReport().fallbacks).toEqual({ quote_data_unavailable: 1 });
  });

  it('expires a non-marketable IOC limit on arrival', async () => {
    const { sink, events } = setup();
    await sink.submitOrder(intent({ orderType: 'limit', limitPrice: 99.0 }));
    await arrive(sink, source([quote(T - 500, 99.99, 100.01)]));
    expect(events.map((e) => e.type)).toContain('ORDER_EXPIRED');
    expect(sink.executionReport().expiredUnmarketable).toBe(1);
    expect(sink.pendingCount()).toBe(0);
  });

  describe('resting limits', () => {
    const restingBuy = () => intent({ orderType: 'limit', limitPrice: 100.0, timeInForce: 'day', qty: 10 });

    it('rest on arrival and fill on trades through the limit, piece by piece', async () => {
      const { sink, events, fills } = setup();
      await sink.submitOrder(restingBuy());
      const src = source(
        [quote(T - 500, 100.01, 100.03)],
        [trade(T + MIN + 5_000, 99.99, 4), trade(T + 2 * MIN + 1_000, 99.98, 50)],
      );
      await arrive(sink, src);
      expect(sink.hasResting()).toBe(true);

      for (const plan of await sink.planResting([bar(T + MIN, 99.9, 100.1)], src)) sink.applyResting(plan);
      expect(events.filter((e) => e.type === 'ORDER_PARTIAL_FILL')).toHaveLength(1);

      for (const plan of await sink.planResting([bar(T + 2 * MIN, 99.9, 100.1)], src)) sink.applyResting(plan);
      expect(fills().map((f) => [f.qty, f.price, f.source])).toEqual([[4, 100.0, 'trade'], [6, 100.0, 'trade']]);
      expect(events.filter((e) => e.type === 'ORDER_FILLED')).toHaveLength(1);
      expect(sink.hasResting()).toBe(false);
    });

    it('fetch no trades for a minute whose bar never reached through the limit', async () => {
      const { sink } = setup();
      await sink.submitOrder(restingBuy());
      const src = source([quote(T - 500, 100.01, 100.03)], [trade(T + MIN + 1, 99.0, 100)]);
      await arrive(sink, src);
      expect(await sink.planResting([bar(T + MIN, 100.0, 100.2)], src)).toEqual([]);
      expect(src.trades).not.toHaveBeenCalled();
    });

    it('do not fill on extended-hours prints', async () => {
      const { sink } = setup();
      await sink.submitOrder(restingBuy());
      const src = source([quote(T - 500, 100.01, 100.03)]);
      await arrive(sink, src);
      const afterClose = Date.parse('2026-10-07T20:30:00Z'); // 16:30 ET
      expect(await sink.planResting([bar(afterClose, 99.0, 100.2)], src)).toEqual([]);
      expect(src.trades).not.toHaveBeenCalled();
    });

    it('stop when canceled', async () => {
      const { sink, fills } = setup();
      const order = await sink.submitOrder(restingBuy());
      const src = source([quote(T - 500, 100.01, 100.03)], [trade(T + MIN + 1, 99.0, 100)]);
      await arrive(sink, src);
      await sink.cancelOrder(order.brokerOrderId!);
      expect(await sink.planResting([bar(T + MIN, 99.0, 100.2)], src)).toEqual([]);
      expect(fills()).toHaveLength(0);
    });
  });

  it('reports notional-weighted spread and delay costs against the order', async () => {
    const { sink } = setup();
    await sink.submitOrder(intent({ side: 'buy' }));
    await sink.submitOrder(intent({ side: 'sell' }));
    // Decision mid 100.00; arrival 100.03 / 100.05 (mid 100.04).
    await arrive(sink, source([quote(T - 500, 99.99, 100.01), quote(T + 100, 100.03, 100.05)]));
    const report = sink.executionReport();
    expect(report.fills).toEqual({ quote: 2, trade: 0, bar: 0 });
    // Buy pays 1 bp of spread, the sell 1 bp too; the mid moved 4 bp up: against the buy, for the sell.
    expect(report.avgSpreadCostBps).toBeCloseTo(1, 1);
    expect(report.avgDelayCostBps).toBeCloseTo(0, 1);
  });

  it('never fills a bar-model order against a bar that completed before it was placed', async () => {
    const { sink, fills } = setup(DEFAULT_EXECUTION);
    await sink.submitOrder(intent({ ts: T + MIN })); // decided as the 10:00 bar completed
    sink.processBarOpen(bar(T, 99, 101, 100)); // that same 10:00 bar
    expect(fills()).toHaveLength(0);
    sink.processBarOpen(bar(T + MIN, 99, 101, 100.5)); // the 10:01 bar
    expect(fills().map((f) => f.price)).toEqual([100.5]);
  });

  it('leaves bar-model fills exactly as before', async () => {
    const { sink, fills } = setup(DEFAULT_EXECUTION);
    await sink.submitOrder(intent());
    sink.processBarOpen(bar(T + MIN, 99, 101, 100.5));
    expect(fills()).toHaveLength(1);
    expect(fills()[0]).not.toHaveProperty('source');
  });
});

function trade(ts: number, price: number, size: number): Trade {
  return { symbol: 'SPY', price, size, ts, isoTs: new Date(ts).toISOString() };
}
