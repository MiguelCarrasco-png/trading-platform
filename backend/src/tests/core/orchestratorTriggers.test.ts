/**
 * tests/core/orchestratorTriggers.test.ts
 *
 * A strategy's `triggers` are its decision clock: the orchestrator calls
 * evaluate() only for those market event kinds, while every event still
 * updates symbol state. Strategies that declare none keep the old behaviour
 * of being called on every quote, trade and bar.
 */

import { EventBus } from "../../core/engine/eventBus";
import { Orchestrator } from "../../core/engine/orchestrator";
import { SymbolStateManager } from "../../core/state/symbolState";
import { PortfolioStateManager } from "../../core/state/portfolioState";
import { OrderStateManager } from "../../core/state/orderState";
import { RiskEngine } from "../../core/risk/riskEngine";
import { ExecutionEngine } from "../../core/execution/executionEngine";
import type { IStrategy } from "../../strategies/base/strategy";
import type { MarketEventKind } from "../../types/market";
import type { UUID } from "../../types/common";

const TS = Date.parse("2026-10-07T14:00:00Z");

function makeStrategy(id: string, triggers?: MarketEventKind[]): IStrategy {
  return {
    id: id as UUID,
    type: "pairs_trading",
    config: {
      id: id as UUID, name: id, type: "pairs_trading", symbols: ["SPY"],
      rollingWindowMs: 60_000, maxPositionSizeUsd: 10_000, cooldownMs: 0, enabled: true,
    },
    ...(triggers ? { triggers } : {}),
    start: jest.fn(),
    stop: jest.fn(),
    evaluate: jest.fn().mockReturnValue(null),
  };
}

function setup() {
  const bus = new EventBus();
  const symbolState = new SymbolStateManager();
  const orchestrator = new Orchestrator(
    bus, symbolState, new PortfolioStateManager(100_000), new OrderStateManager(),
    new RiskEngine(), { submit: jest.fn() } as unknown as ExecutionEngine, "paper",
  );
  return { bus, symbolState, orchestrator };
}

function publishQuote(bus: EventBus): void {
  bus.publish({
    id: "q", type: "QUOTE_RECEIVED", ts: TS, mode: "paper",
    payload: {
      symbol: "SPY", bidPrice: 99.99, askPrice: 100.01, bidSize: 100, askSize: 100,
      midPrice: 100, spread: 0.02, microPrice: 100, imbalance: 0, ts: TS, isoTs: new Date(TS).toISOString(),
    },
  });
}

function publishTrade(bus: EventBus): void {
  bus.publish({
    id: "t", type: "TRADE_RECEIVED", ts: TS, mode: "paper",
    payload: { symbol: "SPY", price: 100, size: 10, ts: TS, isoTs: new Date(TS).toISOString() },
  });
}

function publishBar(bus: EventBus): void {
  bus.publish({
    id: "b", type: "BAR_RECEIVED", ts: TS, mode: "paper",
    payload: {
      symbol: "SPY", open: 100, high: 100, low: 100, close: 100, volume: 1_000,
      ts: TS, isoTs: new Date(TS).toISOString(), timeframe: "1Min",
    },
  });
}

describe("Orchestrator strategy triggers", () => {
  it("calls a bar-triggered strategy on bars only, while quotes and trades still update state", () => {
    const { bus, symbolState, orchestrator } = setup();
    const strategy = makeStrategy("bars", ["bar"]);
    orchestrator.registerStrategy(strategy);
    orchestrator.start();

    publishQuote(bus);
    publishTrade(bus);
    expect(strategy.evaluate).not.toHaveBeenCalled();
    expect(symbolState.get("SPY")?.latestQuote?.midPrice).toBe(100);
    expect(symbolState.get("SPY")?.latestTrade?.price).toBe(100);

    publishBar(bus);
    expect(strategy.evaluate).toHaveBeenCalledTimes(1);
  });

  it("calls a tick-triggered strategy on quotes and trades, not bars", () => {
    const { bus, orchestrator } = setup();
    const strategy = makeStrategy("ticks", ["quote", "trade"]);
    orchestrator.registerStrategy(strategy);
    orchestrator.start();

    publishBar(bus);
    expect(strategy.evaluate).not.toHaveBeenCalled();
    publishQuote(bus);
    publishTrade(bus);
    expect(strategy.evaluate).toHaveBeenCalledTimes(2);
  });

  it("calls a strategy that declares no triggers on every market event", () => {
    const { bus, orchestrator } = setup();
    const strategy = makeStrategy("legacy");
    orchestrator.registerStrategy(strategy);
    orchestrator.start();

    publishQuote(bus);
    publishTrade(bus);
    publishBar(bus);
    expect(strategy.evaluate).toHaveBeenCalledTimes(3);
  });

  it("re-reads the registry after strategies are added or removed", () => {
    const { bus, orchestrator } = setup();
    const calls: string[] = [];
    const a = makeStrategy("a", ["bar"]);
    const b = makeStrategy("b", ["bar"]);
    (a.evaluate as jest.Mock).mockImplementation(() => { calls.push("a"); return null; });
    (b.evaluate as jest.Mock).mockImplementation(() => { calls.push("b"); return null; });
    orchestrator.registerStrategy(a);
    orchestrator.registerStrategy(b);
    orchestrator.start();

    publishBar(bus);
    expect(calls).toEqual(["a", "b"]);

    orchestrator.deregisterStrategy("a");
    publishBar(bus);
    expect(calls).toEqual(["a", "b", "b"]);

    orchestrator.registerStrategy(a);
    publishBar(bus);
    expect(calls).toEqual(["a", "b", "b", "b", "a"]);
  });
});
