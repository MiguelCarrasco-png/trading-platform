jest.mock('../../config/env', () => ({
  env: {
    nodeEnv: 'test',
    logLevel: 'error',
    supabaseUrl: 'https://test.supabase.co',
    supabaseAnonKey: 'test-anon',
    supabaseServiceRoleKey: 'test-service',
  },
}));

import { EventBus } from '../../core/engine/eventBus';
import { StrategyDiagnostics } from '../../core/live/strategyDiagnostics';
import { SymbolStateManager } from '../../core/state/symbolState';
import { logger } from '../../utils/logger';
import type { IStrategy } from '../../strategies/base/strategy';
import type { MarketHours } from '../../core/market/marketHours';
import type { Bar, Quote } from '../../types/market';
import type { TradingEvent } from '../../types/events';

const MIN = 60_000;
const NO_DATA_MS = 5 * MIN;
const LOG_WINDOW_MS = MIN;

function strategy(overrides: Partial<{ symbols: string[]; triggers: string[] | undefined; name: string }> = {}): IStrategy {
  return {
    id: 'cfg-1',
    type: 'beginner_reversal',
    triggers: 'triggers' in overrides ? overrides.triggers : ['bar'],
    config: { name: overrides.name ?? 'My Reversal', symbols: overrides.symbols ?? ['SPY'] },
  } as unknown as IStrategy;
}

function bar(symbol: string, ts: number): Bar {
  return { symbol, open: 1, high: 1, low: 1, close: 1, volume: 1, ts, isoTs: new Date(ts).toISOString(), timeframe: '1m' };
}

function quote(symbol: string, ts: number): Quote {
  return { symbol, bidPrice: 1, askPrice: 1.01, bidSize: 1, askSize: 1, midPrice: 1.005, spread: 0.01, ts, isoTs: new Date(ts).toISOString() } as unknown as Quote;
}

function setup(opts: { strategies?: IStrategy[]; open?: boolean } = {}) {
  let t = 1_000_000;
  const clock = { advance: (ms: number) => { t += ms; }, now: () => t };
  const hours = { open: opts.open ?? true };
  const marketHours: MarketHours = { isOpen: () => hours.open };
  const eventBus = new EventBus();
  const symbolState = new SymbolStateManager();
  const registered = (opts.strategies ?? [strategy()]).map((s, i) => ({ key: `run-${i + 1}`, runId: `run-${i + 1}`, strategy: s }));
  const runEvents: Array<[string, string, string]> = [];
  const orders = new Map<string, { strategyId: string; runId?: string; symbol: string; side: string; qty: number }>();
  const diagnostics = new StrategyDiagnostics(
    {
      eventBus,
      symbolState,
      strategies: () => registered,
      marketHours,
      recordRunEvent: (runId, type, detail) => runEvents.push([runId, type, detail]),
      lookupOrder: (id) => orders.get(id) ?? null,
      now: clock.now,
    },
    { tickMs: 1e9, noDataMs: NO_DATA_MS, logWindowMs: LOG_WINDOW_MS },
  );
  diagnostics.start();
  const publish = (event: Record<string, unknown>) =>
    eventBus.publish({ id: 'e', ts: clock.now(), mode: 'paper', ...event } as unknown as TradingEvent);
  const riskReject = (check = 'MAX_POSITION', runId: string | null = 'run-1') =>
    publish({
      type: 'RISK_REJECTED', strategyId: 'cfg-1', reason: 'position too large', failedCheck: check,
      rejectedIntent: { symbol: 'SPY', side: 'buy', qty: 1, ...(runId ? { runId } : {}) },
    });
  return { clock, hours, symbolState, diagnostics, runEvents, orders, publish, riskReject };
}

let warn: jest.SpyInstance;
let info: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  info = jest.spyOn(logger, 'info').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('StrategyDiagnostics: blocked and rejected orders', () => {
  it('says in plain words which strategy was blocked, by what, and that nothing was sent', () => {
    const { riskReject, diagnostics } = setup();
    riskReject('MAX_POSITION');
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('My Reversal');
    expect(message).toContain('buy 1 SPY');
    expect(message).toContain('MAX_POSITION');
    expect(message).toContain('position too large');
    expect(message).toContain('NOT sent');
    diagnostics.stop();
  });

  it('logs a repeated block once per window and summarises the rest on the next tick', () => {
    const { riskReject, clock, diagnostics } = setup();
    riskReject();
    for (let i = 0; i < 4; i++) { clock.advance(10_000); riskReject(); }
    expect(warn).toHaveBeenCalledTimes(1);

    clock.advance(LOG_WINDOW_MS);
    diagnostics.tick();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toMatch(/4 more in the last/);

    clock.advance(10_000);
    riskReject();
    expect(warn).toHaveBeenCalledTimes(3); // a fresh window logs at once again
    diagnostics.stop();
  });

  it('keeps different checks separate', () => {
    const { riskReject, diagnostics } = setup();
    riskReject('MAX_POSITION');
    riskReject('MARKET_CLOSED');
    expect(warn).toHaveBeenCalledTimes(2);
    diagnostics.stop();
  });

  it('writes a BLOCKED run event only the first time a run hits a given check', () => {
    const { riskReject, clock, runEvents, diagnostics } = setup();
    riskReject('MAX_POSITION');
    clock.advance(LOG_WINDOW_MS * 2);
    riskReject('MAX_POSITION');
    riskReject('MARKET_CLOSED');
    expect(runEvents.map(([run, type]) => [run, type])).toEqual([['run-1', 'BLOCKED'], ['run-1', 'BLOCKED']]);
    expect(runEvents[0][2]).toContain('MAX_POSITION');
    expect(runEvents[1][2]).toContain('MARKET_CLOSED');
    diagnostics.stop();
  });

  it('still logs when the rejected intent has no run (no timeline event possible)', () => {
    const { riskReject, runEvents, diagnostics } = setup();
    riskReject('MAX_POSITION', null);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(runEvents).toEqual([]);
    diagnostics.stop();
  });

  it('reports a capital shortfall with the amounts', () => {
    const { publish, runEvents, diagnostics } = setup();
    publish({ type: 'CAPITAL_UNAVAILABLE', strategyId: 'cfg-1', runId: 'run-1', intentId: 'i', required: 1500, available: 200.5 });
    expect(warn.mock.calls[0][0]).toMatch(/needs \$1500\.00, \$200\.50 available/);
    expect(runEvents[0]).toEqual(['run-1', 'BLOCKED', expect.stringContaining('1500.00')]);
    diagnostics.stop();
  });

  it('names the order when the broker rejects it, and copes with an unknown one', () => {
    const { publish, orders, diagnostics } = setup();
    orders.set('o-1', { strategyId: 'cfg-1', runId: 'run-1', symbol: 'SPY', side: 'sell', qty: 2 });
    publish({ type: 'ORDER_REJECTED', orderId: 'o-1', reason: 'insufficient buying power' });
    expect(warn.mock.calls[0][0]).toMatch(/broker rejected sell 2 SPY: insufficient buying power/);
    publish({ type: 'ORDER_REJECTED', orderId: 'ghost', reason: 'bad' });
    expect(warn).toHaveBeenCalledTimes(2);
    diagnostics.stop();
  });

  it('notes an expired order at info level, not as a warning', () => {
    const { publish, orders, diagnostics } = setup();
    orders.set('o-1', { strategyId: 'cfg-1', symbol: 'SPY', side: 'buy', qty: 1 });
    publish({ type: 'ORDER_EXPIRED', orderId: 'o-1' });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('expired without filling'));
    expect(warn).not.toHaveBeenCalled();
    diagnostics.stop();
  });

  it('stops listening after stop()', () => {
    const { riskReject, diagnostics } = setup();
    diagnostics.stop();
    riskReject();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('StrategyDiagnostics: data watchdog', () => {
  it('warns once, on the run timeline too, when a symbol never produces data', () => {
    const { diagnostics, clock, runEvents } = setup();
    diagnostics.tick(); // first sighting starts the grace period
    clock.advance(NO_DATA_MS - 1);
    diagnostics.tick();
    expect(warn).not.toHaveBeenCalled();

    clock.advance(1);
    diagnostics.tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/No bar data for SPY since the run started/);
    expect(runEvents).toEqual([['run-1', 'NO_DATA', expect.stringContaining('spelled correctly')]]);

    clock.advance(NO_DATA_MS * 3);
    diagnostics.tick();
    expect(warn).toHaveBeenCalledTimes(1); // state change only, never repeated
    diagnostics.stop();
  });

  it('stays quiet while data keeps arriving', () => {
    const { diagnostics, clock, symbolState } = setup();
    diagnostics.tick();
    for (let i = 1; i <= 20; i++) {
      clock.advance(MIN);
      symbolState.onBar(bar('SPY', clock.now()));
      diagnostics.tick();
    }
    expect(warn).not.toHaveBeenCalled();
    diagnostics.stop();
  });

  it('reports data that stops, then reports it flowing again', () => {
    const { diagnostics, clock, symbolState, runEvents } = setup();
    symbolState.onBar(bar('SPY', clock.now()));
    diagnostics.tick();

    clock.advance(NO_DATA_MS);
    diagnostics.tick();
    expect(warn.mock.calls[0][0]).toMatch(/No new bar data for SPY for 5 min/);

    symbolState.onBar(bar('SPY', clock.now()));
    diagnostics.tick();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Data for SPY is flowing again'));
    expect(runEvents.map(([, type]) => type)).toEqual(['NO_DATA', 'DATA_RESUMED']);

    clock.advance(NO_DATA_MS);
    diagnostics.tick();
    expect(warn).toHaveBeenCalledTimes(2); // it can warn again after recovering
    diagnostics.stop();
  });

  it('judges a bar strategy by bars, so a busy quote stream cannot hide missing bars', () => {
    const { diagnostics, clock, symbolState } = setup();
    diagnostics.tick();
    for (let i = 0; i < 10; i++) {
      clock.advance(NO_DATA_MS / 10);
      symbolState.onQuote(quote('SPY', clock.now()));
    }
    diagnostics.tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('No bar data for SPY');
    diagnostics.stop();
  });

  it('checks every symbol of a strategy separately', () => {
    const { diagnostics, clock, symbolState } = setup({ strategies: [strategy({ symbols: ['SPY', 'QQQ'] })] });
    diagnostics.tick();
    clock.advance(NO_DATA_MS);
    symbolState.onBar(bar('SPY', clock.now()));
    diagnostics.tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('QQQ');
    diagnostics.stop();
  });

  it('is silent while the market is closed and restarts its clock at the open', () => {
    const { diagnostics, clock, hours } = setup({ open: false });
    diagnostics.tick();
    clock.advance(NO_DATA_MS * 4);
    diagnostics.tick();
    expect(warn).not.toHaveBeenCalled();

    hours.open = true;
    diagnostics.tick();
    clock.advance(NO_DATA_MS - 1);
    diagnostics.tick();
    expect(warn).not.toHaveBeenCalled();
    clock.advance(1);
    diagnostics.tick();
    expect(warn).toHaveBeenCalledTimes(1);
    diagnostics.stop();
  });
});
