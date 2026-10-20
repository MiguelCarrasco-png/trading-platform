import { RiskEngine } from '../../core/risk/riskEngine';
import type { OrderIntent } from '../../types/orders';

function intent(overrides: Partial<OrderIntent>): OrderIntent {
  return { id: 'i', strategyId: 's', symbol: 'SPY', side: 'buy', qty: 10, orderType: 'market', timeInForce: 'day', ts: 0, ...overrides };
}

describe('RiskEngine.estimateWorstCasePrice for stops', () => {
  const risk = new RiskEngine({ gapBufferBps: 0, spreadBufferBps: 100 }); // a 1% buffer
  const mid = 100;

  it('reserves from the stop when a buy stop sits above the market', () => {
    expect(risk.estimateWorstCasePrice('buy', intent({ orderType: 'stop', stopPrice: 110 }), mid)).toBeCloseTo(111.1, 10);
    expect(risk.estimateWorstCasePrice('buy', intent({ orderType: 'stop', stopPrice: 90 }), mid)).toBeCloseTo(101, 10);
  });

  it('values a sell stop below the market from the stop', () => {
    expect(risk.estimateWorstCasePrice('sell', intent({ side: 'sell', orderType: 'stop', stopPrice: 95 }), mid)).toBeCloseTo(94.05, 10);
  });

  it('uses a stop-limit\'s limit, as for any limit order', () => {
    expect(risk.estimateWorstCasePrice('buy', intent({ orderType: 'stop_limit', stopPrice: 110, limitPrice: 112 }), mid)).toBe(112);
  });
});
