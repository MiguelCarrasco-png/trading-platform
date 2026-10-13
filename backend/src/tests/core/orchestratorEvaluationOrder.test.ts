/**
 * tests/core/orchestratorEvaluationOrder.test.ts
 *
 * Audit finding 4: the orchestrator re-sorted every registered strategy on
 * every market event. The order is now cached and rebuilt only when the
 * registry changes. These tests pin the semantics the cache must keep:
 * priority first, registration order within a priority, and mid-pass
 * registry changes taking effect from the next event.
 */

// Every built-in type currently shares one priority; give the test two levels.
jest.mock("../../core/oms/priorityConfig", () => ({
  getStrategyPriority: (type: string) => (type === "high_type" ? 200 : 100),
}));

import { EventBus } from "../../core/engine/eventBus";
import { Orchestrator } from "../../core/engine/orchestrator";
import { SymbolStateManager } from "../../core/state/symbolState";
import { PortfolioStateManager } from "../../core/state/portfolioState";
import { OrderStateManager } from "../../core/state/orderState";
import { RiskEngine } from "../../core/risk/riskEngine";
import type { ExecutionEngine } from "../../core/execution/executionEngine";
import type { IStrategy } from "../../strategies/base/strategy";
import type { StrategyType } from "../../types/strategy";
import type { UUID } from "../../types/common";

const T = "2026-03-10T14:30:00Z";

function setup(): { bus: EventBus; orch: Orchestrator; calls: string[]; quote: () => void } {
  const bus = new EventBus();
  const orch = new Orchestrator(
    bus, new SymbolStateManager(), new PortfolioStateManager(100_000), new OrderStateManager(),
    new RiskEngine(), { submit: jest.fn() } as unknown as ExecutionEngine, "paper",
  );
  const calls: string[] = [];
  const quote = (): void => bus.publish({
    id: "q", type: "QUOTE_RECEIVED", ts: 1, mode: "paper",
    payload: { symbol: "SPY", bidPrice: 1, askPrice: 1.01, bidSize: 1, askSize: 1, midPrice: 1.005, spread: 0.01, microPrice: 1.005, imbalance: 0, ts: 1, isoTs: T },
  });
  return { bus, orch, calls, quote };
}

function strategy(id: string, type: string, calls: string[], onEvaluate?: () => void): IStrategy {
  return {
    id: id as UUID,
    type: type as StrategyType,
    config: { id: id as UUID, name: id, type: type as StrategyType, symbols: ["SPY"], rollingWindowMs: 1, maxPositionSizeUsd: 1, cooldownMs: 0, enabled: true },
    start: jest.fn(),
    stop: jest.fn(),
    evaluate: () => { calls.push(id); onEvaluate?.(); return null; },
  };
}

describe("strategy evaluation order", () => {
  it("evaluates higher priority first, then in registration order", () => {
    const { orch, calls, quote } = setup();
    orch.registerStrategy(strategy("low-a", "low_type", calls));
    orch.registerStrategy(strategy("high-a", "high_type", calls));
    orch.registerStrategy(strategy("low-b", "low_type", calls));
    orch.registerStrategy(strategy("high-b", "high_type", calls));
    orch.start();
    quote();
    quote();
    expect(calls).toEqual(["high-a", "high-b", "low-a", "low-b", "high-a", "high-b", "low-a", "low-b"]);
  });

  it("picks up strategies registered after events have been processed", () => {
    const { orch, calls, quote } = setup();
    orch.registerStrategy(strategy("a", "pairs_trading", calls));
    orch.start();
    quote();
    orch.registerStrategy(strategy("b", "pairs_trading", calls));
    quote();
    orch.deregisterStrategy("a");
    quote();
    expect(calls).toEqual(["a", "a", "b", "b"]);
  });

  it("a strategy deregistered mid-pass is skipped; one registered mid-pass waits for the next event", () => {
    const { orch, calls, quote } = setup();
    orch.registerStrategy(strategy("first", "pairs_trading", calls, () => {
      if (orch.hasStrategy("second")) orch.deregisterStrategy("second");
      if (!orch.hasStrategy("late")) orch.registerStrategy(strategy("late", "pairs_trading", calls));
    }));
    orch.registerStrategy(strategy("second", "pairs_trading", calls));
    orch.start();
    quote();
    expect(calls).toEqual(["first"]);
    quote();
    expect(calls).toEqual(["first", "first", "late"]);
  });
});
