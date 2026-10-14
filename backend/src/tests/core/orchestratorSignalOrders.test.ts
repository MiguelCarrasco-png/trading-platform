/**
 * tests/core/orchestratorSignalOrders.test.ts
 *
 * A signal can ask for a limit, stop or stop-limit order instead of the
 * default market IOC, and can cancel its strategy's working orders first —
 * an exit replacing a protective stop must not leave the stop behind.
 */

import { EventBus } from "../../core/engine/eventBus";
import { Orchestrator } from "../../core/engine/orchestrator";
import { SymbolStateManager } from "../../core/state/symbolState";
import { PortfolioStateManager } from "../../core/state/portfolioState";
import { OrderStateManager } from "../../core/state/orderState";
import { RiskEngine } from "../../core/risk/riskEngine";
import { ExecutionEngine } from "../../core/execution/executionEngine";
import type { OrderIntent, Order } from "../../types/orders";
import type { StrategySignal } from "../../types/strategy";
import type { OrderIntentCreatedEvent } from "../../types/events";
import type { UUID } from "../../types/common";

const TS = Date.parse("2026-10-07T14:00:00Z");

function setup() {
  const bus = new EventBus();
  const orderState = new OrderStateManager();
  const execution = { submit: jest.fn(async () => ({}) as Order), cancel: jest.fn(async (_brokerOrderId: string) => {}) };
  const orchestrator = new Orchestrator(
    bus, new SymbolStateManager(), new PortfolioStateManager(100_000), orderState,
    new RiskEngine(), execution as unknown as ExecutionEngine, "backtest",
  );
  orchestrator.start();
  const intents: OrderIntent[] = [];
  bus.on("ORDER_INTENT_CREATED", (e) => { intents.push((e as OrderIntentCreatedEvent).payload); });
  const signal = (overrides: Partial<StrategySignal>) => bus.publish({
    id: "sig", type: "STRATEGY_SIGNAL_CREATED", ts: TS, mode: "backtest", strategyId: "s1",
    payload: {
      id: "p" as UUID, strategyId: "s1", strategyType: "pairs_trading", symbol: "SPY",
      direction: "close_long", qty: 10, ts: TS, ...overrides,
    },
  } as never);
  return { orderState, execution, intents, signal };
}

function openOrder(id: string, strategyId: string, symbol: string, status: Order["status"] = "submitted"): Order {
  return {
    id: id as UUID, brokerOrderId: `sim_${id}`, intentId: id as UUID, strategyId, symbol, side: "sell", qty: 10,
    filledQty: 0, orderType: "stop", stopPrice: 99, timeInForce: "day", status, submittedAt: TS, updatedAt: TS, fills: [],
  };
}

describe("signal order requests", () => {
  it("sends a market IOC order by default", () => {
    const { intents, signal } = setup();
    signal({});
    expect(intents[0]).toMatchObject({ orderType: "market", timeInForce: "ioc" });
    expect(intents[0]).not.toHaveProperty("stopPrice");
  });

  it("sends the requested stop, defaulting it to DAY", () => {
    const { intents, signal } = setup();
    signal({ order: { type: "stop", stopPrice: 99.5 } });
    expect(intents[0]).toMatchObject({ side: "sell", orderType: "stop", stopPrice: 99.5, timeInForce: "day" });
    expect(intents[0]).not.toHaveProperty("limitPrice");
  });

  it("sends a stop-limit with both prices and the requested time in force", () => {
    const { intents, signal } = setup();
    signal({ order: { type: "stop_limit", stopPrice: 99.5, limitPrice: 99.4, timeInForce: "gtc" } });
    expect(intents[0]).toMatchObject({ orderType: "stop_limit", stopPrice: 99.5, limitPrice: 99.4, timeInForce: "gtc" });
  });

  it("drops a signal whose order request is incomplete", () => {
    const { intents, signal } = setup();
    signal({ order: { type: "stop" } });
    signal({ order: { type: "limit", limitPrice: -1 } });
    signal({ order: { type: "trailing_stop" as never, stopPrice: 1 } });
    expect(intents).toHaveLength(0);
  });
});

describe("cancelWorkingOrders", () => {
  it("cancels the strategy's open orders on the signal's symbols before sending, and nothing else", () => {
    const { orderState, execution, intents, signal } = setup();
    orderState.addOrder(openOrder("mine", "s1", "SPY"));
    orderState.addOrder(openOrder("other-symbol", "s1", "QQQ"));
    orderState.addOrder(openOrder("other-strategy", "s2", "SPY"));
    orderState.addOrder(openOrder("already-filled", "s1", "SPY", "filled"));

    signal({ cancelWorkingOrders: true });

    expect(execution.cancel.mock.calls.map((c) => c[0])).toEqual(["sim_mine"]);
    expect(intents).toHaveLength(1);
  });

  it("covers a pair's counterpart, and a flat signal only cancels", () => {
    const { orderState, execution, intents, signal } = setup();
    orderState.addOrder(openOrder("leg1", "s1", "SPY"));
    orderState.addOrder(openOrder("leg2", "s1", "QQQ"));

    signal({ direction: "flat", qty: 0, cancelWorkingOrders: true, meta: { counterpartSymbol: "QQQ" } });

    expect(execution.cancel.mock.calls.map((c) => c[0]).sort()).toEqual(["sim_leg1", "sim_leg2"]);
    expect(intents).toHaveLength(0);
  });
});
