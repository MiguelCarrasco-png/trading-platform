/**
 * tests/core/liveQuoteFills.test.ts
 *
 * A sim runtime streaming live data prices orders with the backtest's quote
 * model as quotes and trades arrive: at the quote prevailing when an order
 * reaches the market, on trades through a resting limit, on a trade reaching a
 * stop — and only once the ticks those depend on have had time to arrive.
 */

jest.mock('../../config/env', () => ({ env: { logLevel: 'error' } }));

import { EventBus } from '../../core/engine/eventBus';
import { SymbolStateManager } from '../../core/state/symbolState';
import { SimulatedExecutionSink } from '../../core/execution/simulatedExecution';
import { LiveQuoteFills, LiveTickBuffer, simExecution } from '../../core/execution/liveQuoteFills';
import { DEFAULT_EXECUTION, type ExecutionConfig } from '../../core/execution/quoteFillModel';
import { DEFAULT_FILL_MODEL } from '../../core/execution/fillModel';
import type { Bar, Quote, Trade } from '../../types/market';
import type { OrderIntent, Fill } from '../../types/orders';
import type { TradingEvent } from '../../types/events';
import type { UUID } from '../../types/common';

// 10:00 ET on a Wednesday: inside the regular session.
const T = Date.parse('2026-10-07T14:00:00Z');
const CLOSE = Date.parse('2026-10-07T20:00:00Z');
const EXECUTION: ExecutionConfig = { ...DEFAULT_EXECUTION, model: 'quote', latencyMs: 250, feed: 'iex' };

function quote(ts: number, bid: number, ask: number): Quote {
  return {
    symbol: 'SPY', bidPrice: bid, askPrice: ask, bidSize: 100, askSize: 100,
    midPrice: (bid + ask) / 2, spread: ask - bid, microPrice: (bid + ask) / 2, imbalance: 0,
    ts, isoTs: new Date(ts).toISOString(),
  };
}

function trade(ts: number, price: number, size: number): Trade {
  return { symbol: 'SPY', price, size, ts, isoTs: new Date(ts).toISOString() };
}

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    id: `o-${Math.random()}` as UUID, strategyId: 's', symbol: 'SPY', side: 'buy', qty: 10,
    orderType: 'market', timeInForce: 'ioc', ts: T, ...overrides,
  };
}

function setup() {
  let now = T;
  const bus = new EventBus();
  const events: TradingEvent[] = [];
  bus.onAll((e) => { events.push(e); });
  const fillModel = { ...DEFAULT_FILL_MODEL, halfSpreadBps: 0, slippageBps: 0, commissionPerShare: 0 };
  const sink = new SimulatedExecutionSink(bus, new SymbolStateManager(), 'paper', 0, 0, fillModel, EXECUTION);
  const live = new LiveQuoteFills(bus, sink, EXECUTION, { now: () => now, settleMs: 250 });
  return {
    sink,
    events,
    fills: () => events.flatMap((e) => ('fill' in e ? [(e as { fill: Fill }).fill] : [])),
    at: (ms: number) => { now = ms; },
    /** Moves the clock and runs a settling pass, as the timer would. */
    settleAt: async (ms: number) => { now = ms; await live.settle(); },
    live,
    quote: (ts: number, bid: number, ask: number) =>
      bus.publish({ id: 'q', type: 'QUOTE_RECEIVED', ts, mode: 'paper', payload: quote(ts, bid, ask) }),
    trade: (ts: number, price: number, size: number) =>
      bus.publish({ id: 't', type: 'TRADE_RECEIVED', ts, mode: 'paper', payload: trade(ts, price, size) }),
    bar: (b: Bar) => bus.publish({ id: 'b', type: 'BAR_RECEIVED', ts: b.ts + 60_000, mode: 'paper', payload: b }),
  };
}

describe('LiveQuoteFills', () => {
  it('fills a market order at the live quote prevailing when it reaches the market, once ticks have settled', async () => {
    const { sink, fills, settleAt, quote } = setup();
    quote(T - 100, 99.99, 100.01);
    await sink.submitOrder(intent());
    quote(T + 200, 100.0, 100.02);
    quote(T + 300, 100.05, 100.07);

    await settleAt(T + 400); // a tick stamped before the arrival may still be on its way
    expect(fills()).toHaveLength(0);
    await settleAt(T + 500);
    expect(fills()).toEqual([expect.objectContaining({ price: 100.02, ts: T + 250, source: 'quote', decisionMid: 100 })]);
  });

  it('waits out the quote wait for a first quote, then leaves the order to the bar model', async () => {
    const { sink, fills, settleAt, quote, bar } = setup();
    await sink.submitOrder(intent());
    await settleAt(T + 3_000);
    expect(sink.hasArrivals()).toBe(true);
    quote(T + 3_100, 100.0, 100.02);
    await settleAt(T + 3_400);
    expect(fills().map((f) => [f.price, f.ts])).toEqual([[100.02, T + 3_100]]);

    // No quote within 5 s of reaching the market at 10:00:10.250.
    await sink.submitOrder(intent({ side: 'sell', ts: T + 10_000 }));
    await settleAt(T + 15_400);
    expect(sink.hasArrivals()).toBe(true);
    await settleAt(T + 15_600);
    expect(sink.executionReport().fallbacks).toEqual({ no_quote: 1 });
    bar({ symbol: 'SPY', open: 100.1, high: 100.2, low: 100, close: 100.1, volume: 1_000, ts: T, isoTs: '', timeframe: '1Min' });
    expect(fills()[1]).toMatchObject({ side: 'sell', price: 100.1, source: 'bar', fallbackReason: 'no_quote' });
  });

  it('fills a resting limit on live trades through its price, never on a touch', async () => {
    const { sink, fills, settleAt, quote, trade } = setup();
    quote(T - 100, 99.99, 100.01);
    await sink.submitOrder(intent({ orderType: 'limit', limitPrice: 99.95, timeInForce: 'day' }));
    await settleAt(T + 500);
    expect(sink.hasResting()).toBe(true);

    trade(T + 1_000, 99.95, 100);
    trade(T + 2_000, 99.94, 4);
    expect(fills().map((f) => [f.qty, f.price, f.ts, f.source])).toEqual([[4, 99.95, T + 2_000, 'trade']]);
    trade(T + 3_000, 99.9, 100);
    expect(fills().map((f) => f.qty)).toEqual([4, 6]);
    expect(sink.hasResting()).toBe(false);
  });

  it('ignores trades outside the regular session and expires a DAY order at the close', async () => {
    const { sink, events, fills, settleAt, quote, trade } = setup();
    quote(T - 100, 99.99, 100.01);
    await sink.submitOrder(intent({ side: 'sell', orderType: 'limit', limitPrice: 101, timeInForce: 'gtc' }));
    await sink.submitOrder(intent({ side: 'sell', orderType: 'limit', limitPrice: 101, timeInForce: 'day' }));
    await settleAt(T + 500);

    await settleAt(CLOSE + 50);
    expect(events.filter((e) => e.type === 'ORDER_EXPIRED')).toHaveLength(1);
    trade(CLOSE + 60_000, 101.5, 100); // after hours, through the GTC limit
    expect(fills()).toHaveLength(0);
    expect(sink.hasResting()).toBe(true);
  });

  it('triggers a stop on a live trade and sells at the bid prevailing at the trigger', async () => {
    const { sink, fills, settleAt, quote, trade } = setup();
    quote(T - 100, 99.99, 100.01);
    await sink.submitOrder(intent({ side: 'sell', orderType: 'stop', stopPrice: 99.5, timeInForce: 'day' }));
    await settleAt(T + 500);
    expect(sink.hasResting()).toBe(true);

    quote(T + 9_900, 99.48, 99.5);
    trade(T + 10_000, 99.5, 10);
    expect(sink.hasArrivals()).toBe(true);
    await settleAt(T + 10_300);
    expect(fills()).toEqual([expect.objectContaining({ price: 99.48, ts: T + 10_000, source: 'quote' })]);
    expect(sink.executionReport().stopsTriggered).toBe(1);
  });

  it("never applies an order's pricing twice when settling passes overlap", async () => {
    const { sink, live, at } = setup();
    await sink.submitOrder(intent());
    at(T + 5_600); // its wait for a quote is over
    await Promise.all([live.settle(), live.settle()]);
    expect(sink.executionReport().fallbacks).toEqual({ no_quote: 1 });
  });
});

describe('LiveTickBuffer', () => {
  it('reads [start, end) windows in time order, placing a late tick where it belongs', async () => {
    const ticks = new LiveTickBuffer('iex', 60_000, () => T);
    ticks.addQuote(quote(T - 300, 100, 100.02));
    ticks.addQuote(quote(T - 100, 100, 100.02));
    ticks.addQuote(quote(T - 200, 100, 100.02));
    expect((await ticks.quotes('SPY', T - 300, T - 100)).map((q) => q.ts)).toEqual([T - 300, T - 200]);
    expect(await ticks.quotes('QQQ', 0, T)).toEqual([]);
  });

  it('drops ticks once they are older than its horizon', async () => {
    let now = T;
    const ticks = new LiveTickBuffer('iex', 1_000, () => now);
    ticks.addTrade(trade(T, 100, 1));
    now = T + 2_500;
    ticks.addTrade(trade(now, 100, 1));
    expect((await ticks.trades('SPY', 0, now + 1)).map((t) => t.ts)).toEqual([now]);
  });
});

describe('simExecution', () => {
  const base = { streaming: true, model: 'quote' as const, latencyMs: 300, streamUrl: 'wss://stream.data.alpaca.markets/v2/iex' };

  it('prices on the live stream by default, labelled with its feed', () => {
    expect(simExecution(base)).toEqual({ ...DEFAULT_EXECUTION, model: 'quote', latencyMs: 300, feed: 'iex' });
    expect(simExecution({ ...base, streamUrl: 'wss://stream.data.alpaca.markets/v2/sip' }).feed).toBe('sip');
  });

  it('uses the bar model when asked, or when there is no live stream', () => {
    expect(simExecution({ ...base, model: 'bar' }).model).toBe('bar');
    expect(simExecution({ ...base, streaming: false }).model).toBe('bar');
  });

  it('refuses an unusable latency', () => {
    expect(() => simExecution({ ...base, latencyMs: -1 })).toThrow('Sim execution');
  });
});
