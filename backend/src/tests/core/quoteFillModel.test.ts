import {
  DEFAULT_EXECUTION,
  arrivalWindow,
  decideArrival,
  executionForConfig,
  prevailingQuote,
  resolveExecution,
  restingLimitFill,
  stopTriggerTrade,
  triggeredForm,
  validateExecution,
  type ExecutionConfig,
  type PricedOrder,
} from '../../core/execution/quoteFillModel';
import type { Quote, Trade } from '../../types/market';

const T = Date.parse('2026-10-07T14:00:00Z');
const CFG: ExecutionConfig = { ...DEFAULT_EXECUTION, model: 'quote', latencyMs: 250, quoteLookbackMs: 5_000, maxQuoteWaitMs: 5_000 };

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

const marketBuy: PricedOrder = { side: 'buy', orderType: 'market', timeInForce: 'ioc' };
const marketSell: PricedOrder = { side: 'sell', orderType: 'market', timeInForce: 'ioc' };

describe('execution config', () => {
  it('defaults to the bar model, so existing configs are untouched', () => {
    expect(resolveExecution().model).toBe('bar');
    expect(validateExecution(resolveExecution())).toBeNull();
  });

  it('rejects settings that would let a fill land after the next minute is decided', () => {
    expect(validateExecution({ ...CFG, latencyMs: 20_000, maxQuoteWaitMs: 15_000 })).toMatch(/at most 30000/);
    expect(validateExecution({ ...CFG, latencyMs: -1 })).toMatch(/latencyMs/);
    expect(validateExecution({ ...CFG, feed: 'otc' as never })).toMatch(/feed/);
    expect(validateExecution({ ...CFG, model: 'tick' as never })).toMatch(/model/);
  });

  it('stores nothing for the bar model and a fully resolved quote model', () => {
    expect(executionForConfig(undefined)).toBeUndefined();
    expect(executionForConfig({ model: 'bar', latencyMs: 9 })).toBeUndefined();
    expect(executionForConfig({ model: 'quote' })).toEqual({ ...DEFAULT_EXECUTION, model: 'quote' });
    expect(() => executionForConfig({ model: 'quote', extraSlippageBps: -3 })).toThrow('extraSlippageBps');
    expect(() => executionForConfig('quote')).toThrow('object');
  });

  it('asks for quotes from the lookback before the decision to the end of the wait after arrival', () => {
    expect(arrivalWindow(T, CFG)).toEqual({ startMs: T - 5_000, endMs: T + 250 + 5_000 + 1 });
  });
});

describe('prevailingQuote', () => {
  it('is the last usable quote at or before the time, if fresh enough', () => {
    const quotes = [quote(T - 3_000, 99.98, 100.0), quote(T - 1_000, 99.99, 100.01), quote(T + 1, 100, 100.02)];
    expect(prevailingQuote(quotes, T, 5_000)?.ts).toBe(T - 1_000);
    expect(prevailingQuote(quotes, T, 500)).toBeNull();
  });

  it('skips crossed or one-sided quotes', () => {
    const quotes = [quote(T - 2_000, 99.99, 100.01), quote(T - 1_000, 100.02, 100.01), quote(T - 500, 0, 100.01)];
    expect(prevailingQuote(quotes, T, 5_000)?.ts).toBe(T - 2_000);
  });
});

describe('decideArrival', () => {
  const book = [quote(T - 1_000, 99.99, 100.01), quote(T + 100, 100.04, 100.06)];

  it('fills a market buy at the ask prevailing when it reaches the market, not when it was decided', () => {
    const d = decideArrival(marketBuy, T, book, CFG);
    expect(d).toMatchObject({ kind: 'fill', price: 100.06, ts: T + 250 });
    if (d.kind !== 'fill') throw new Error('expected a fill');
    expect(d.decision?.midPrice).toBe(100);
    expect(d.arrival.midPrice).toBeCloseTo(100.05, 10);
  });

  it('fills a market sell at the bid', () => {
    expect(decideArrival(marketSell, T, book, CFG)).toMatchObject({ kind: 'fill', price: 100.04 });
  });

  it('waits for the first quote after arrival when none is prevailing', () => {
    const late = [quote(T + 2_000, 99.99, 100.01)];
    expect(decideArrival(marketBuy, T, late, CFG)).toMatchObject({ kind: 'fill', price: 100.01, ts: T + 2_000 });
  });

  it('falls back to the bar model when no quote arrives in time', () => {
    expect(decideArrival(marketBuy, T, [], CFG)).toEqual({ kind: 'fallback', reason: 'no_quote' });
    expect(decideArrival(marketBuy, T, [quote(T + 6_000, 99.99, 100.01)], CFG)).toEqual({ kind: 'fallback', reason: 'no_quote' });
  });

  it('adds extra slippage against the order, but never past a limit', () => {
    const slip = { ...CFG, extraSlippageBps: 10 };
    const d = decideArrival(marketBuy, T, book, slip);
    expect(d.kind === 'fill' && d.price).toBeCloseTo(100.06 * 1.001, 10);
    const capped = decideArrival({ side: 'buy', orderType: 'limit', limitPrice: 100.07, timeInForce: 'ioc' }, T, book, slip);
    expect(capped).toMatchObject({ kind: 'fill', price: 100.07 });
  });

  it('fills a marketable limit at the touch', () => {
    const d = decideArrival({ side: 'buy', orderType: 'limit', limitPrice: 100.10, timeInForce: 'day' }, T, book, CFG);
    expect(d).toMatchObject({ kind: 'fill', price: 100.06 });
  });

  it('expires a non-marketable IOC limit and rests a DAY one', () => {
    const ioc = decideArrival({ side: 'buy', orderType: 'limit', limitPrice: 100.0, timeInForce: 'ioc' }, T, book, CFG);
    expect(ioc).toMatchObject({ kind: 'expire', ts: T + 250 });
    const day = decideArrival({ side: 'buy', orderType: 'limit', limitPrice: 100.0, timeInForce: 'day' }, T, book, CFG);
    expect(day).toMatchObject({ kind: 'rest', liveAt: T + 250 });
  });

  it('rests a stop the market has not reached, with or without a quote', () => {
    const sellStop: PricedOrder = { side: 'sell', orderType: 'stop', stopPrice: 99.5, timeInForce: 'day' };
    expect(decideArrival(sellStop, T, book, CFG)).toMatchObject({ kind: 'rest', restsAs: 'stop', liveAt: T + 250 });
    expect(decideArrival(sellStop, T, [], CFG)).toMatchObject({ kind: 'rest', restsAs: 'stop', arrival: null });
  });

  it('executes a stop the market is already through on arrival, at the touch', () => {
    const buyStop: PricedOrder = { side: 'buy', orderType: 'stop', stopPrice: 100.02, timeInForce: 'day' };
    expect(decideArrival(buyStop, T, book, CFG)).toMatchObject({ kind: 'fill', price: 100.06, ts: T + 250 });
  });

  it('rests a stop-limit triggered on arrival as a limit when its limit is not marketable', () => {
    const order: PricedOrder = { side: 'buy', orderType: 'stop_limit', stopPrice: 100.02, limitPrice: 100.03, timeInForce: 'day' };
    expect(decideArrival(order, T, book, CFG)).toMatchObject({ kind: 'rest', restsAs: 'limit' });
  });

  it('falls back for an order missing a price it needs', () => {
    expect(decideArrival({ side: 'buy', orderType: 'stop', timeInForce: 'day' }, T, book, CFG))
      .toEqual({ kind: 'fallback', reason: 'invalid_order' });
    expect(decideArrival({ side: 'buy', orderType: 'stop_limit', stopPrice: 101, timeInForce: 'day' }, T, book, CFG))
      .toEqual({ kind: 'fallback', reason: 'invalid_order' });
  });
});

describe('stops', () => {
  it('trigger on the first trade at or through the stop, not before it is live', () => {
    const trades = [trade(T + 100, 101, 5), trade(T + 900, 100.99, 5), trade(T + 1_000, 101, 5)];
    expect(stopTriggerTrade('buy', 101, T + 500, trades)?.ts).toBe(T + 1_000);
    expect(stopTriggerTrade('sell', 101, T + 500, trades)?.ts).toBe(T + 900);
    expect(stopTriggerTrade('buy', 102, T, trades)).toBeNull();
  });

  it('become market orders, or limits for stop-limits, once triggered', () => {
    expect(triggeredForm({ side: 'sell', orderType: 'stop', stopPrice: 99, timeInForce: 'day' }).orderType).toBe('market');
    expect(triggeredForm({ side: 'sell', orderType: 'stop_limit', stopPrice: 99, limitPrice: 98.9, timeInForce: 'day' }))
      .toMatchObject({ orderType: 'limit', limitPrice: 98.9 });
  });
});

describe('restingLimitFill', () => {
  it('fills only on prints strictly through the limit, never on a touch', () => {
    const trades = [trade(T + 1_000, 100.0, 500), trade(T + 2_000, 99.99, 30)];
    expect(restingLimitFill('buy', 100.0, 10, T, trades)).toEqual({ ts: T + 2_000, qty: 10 });
    expect(restingLimitFill('buy', 100.0, 10, T, [trades[0]])).toBeNull();
    expect(restingLimitFill('sell', 100.0, 10, T, [trade(T + 1, 100.01, 50)])).toEqual({ ts: T + 1, qty: 10 });
  });

  it('fills at most the size printed through the limit, and nothing before the order was live', () => {
    const trades = [trade(T + 100, 99.9, 1_000), trade(T + 1_000, 99.95, 4), trade(T + 2_000, 99.9, 3)];
    expect(restingLimitFill('buy', 100.0, 10, T + 500, trades)).toEqual({ ts: T + 1_000, qty: 7 });
  });
});
