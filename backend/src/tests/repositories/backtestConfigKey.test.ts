jest.mock('../../adapters/supabase/client');
jest.mock('../../config/env', () => ({ env: { logLevel: 'error' } }));

import { backtestConfigKey } from '../../adapters/supabase/repositories';
import { DEFAULT_EXECUTION } from '../../core/execution/quoteFillModel';
import type { BacktestConfig } from '../../types/backtest';

const base: BacktestConfig = {
  id: 'bt-1',
  name: 'n',
  strategyConfig: {
    id: 's', name: 's', type: 'pairs_trading', symbols: ['SPY', 'QQQ'],
    rollingWindowMs: 3_600_000, maxPositionSizeUsd: 10_000, cooldownMs: 0, enabled: true,
  },
  startDate: '2024-01-01T00:00:00Z',
  endDate: '2024-02-01T00:00:00Z',
  initialCapital: 100_000,
  dataGranularity: 'bar',
  slippageBps: 5,
  commissionPerShare: 0.005,
};

describe('backtestConfigKey engine version', () => {
  it('reads a config saved before engine versions existed as v1', () => {
    expect(backtestConfigKey(base)).toBe(backtestConfigKey({ ...base, engineVersion: 1 }));
  });

  it('never matches a stored result produced under other simulation semantics', () => {
    expect(backtestConfigKey({ ...base, engineVersion: 2 })).not.toBe(backtestConfigKey(base));
  });

  it('tells quote-fill runs apart from bar-model runs and from each other', () => {
    const quote = { ...base, engineVersion: 2, execution: { ...DEFAULT_EXECUTION, model: 'quote' as const } };
    expect(backtestConfigKey(quote)).not.toBe(backtestConfigKey({ ...base, engineVersion: 2 }));
    expect(backtestConfigKey({ ...quote, execution: { ...quote.execution, latencyMs: 500 } }))
      .not.toBe(backtestConfigKey(quote));
  });

  it('ignores fields that do not affect the simulation', () => {
    expect(backtestConfigKey({ ...base, engineVersion: 2, id: 'other', name: 'other' }))
      .toBe(backtestConfigKey({ ...base, engineVersion: 2 }));
  });
});
