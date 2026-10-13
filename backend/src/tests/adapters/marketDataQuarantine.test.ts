/**
 * tests/adapters/marketDataQuarantine.test.ts
 *
 * The invalid-data policy (audit finding 1): a one-sided IEX quote (bid or ask
 * of 0) used to become a mid of half the price and mark positions with it.
 * Under "quarantine" — the trading runtime's default — it never reaches the
 * bus; drops are counted and logged at 1, 10, 100, ... occurrences.
 */

import { EventBus } from "../../core/engine/eventBus";
import { AlpacaMarketDataAdapter } from "../../adapters/alpaca/marketData";
import { PortfolioStateManager } from "../../core/state/portfolioState";
import { logger } from "../../utils/logger";
import type { QuoteReceivedEvent } from "../../types/events";
import type { Fill } from "../../types/orders";

const T = "2026-03-10T14:30:00.000123Z";
const quote = (bp: number, ap: number): Record<string, unknown> => ({ T: "q", S: "SPY", bp, ap, bs: 2, as: 2, t: T });

function markedPortfolio(policy: "pass" | "quarantine"): { adapter: AlpacaMarketDataAdapter; portfolio: PortfolioStateManager } {
  const bus = new EventBus();
  const portfolio = new PortfolioStateManager(100_000);
  portfolio.applyFill({ id: "f", orderId: "o", symbol: "SPY", side: "buy", qty: 10, price: 500, notional: 5_000, commission: 0, ts: 1, isoTs: T } as Fill);
  bus.on<QuoteReceivedEvent>("QUOTE_RECEIVED", (e) => portfolio.updatePrice(e.payload.symbol, e.payload.midPrice));
  return { adapter: new AlpacaMarketDataAdapter(bus, "paper", { invalidData: policy }), portfolio };
}

afterEach(() => jest.restoreAllMocks());

describe("invalid market data policy", () => {
  it("pass (the old behaviour): a one-sided quote halves the position's mark", () => {
    const { adapter, portfolio } = markedPortfolio("pass");
    adapter.ingestFrame(JSON.stringify([quote(500, 0)]));
    expect(portfolio.getPosition("SPY")!.currentPrice).toBe(250);
  });

  it("quarantine: the one-sided quote never reaches prices; a good quote still does", () => {
    const { adapter, portfolio } = markedPortfolio("quarantine");
    adapter.ingestFrame(JSON.stringify([quote(500, 0), quote(501, 501.02)]));
    expect(portfolio.getPosition("SPY")!.currentPrice).toBeCloseTo(501.01, 9);
    expect(adapter.quarantineCounts()).toEqual({ "quote.ONE_SIDED_QUOTE": 1 });
  });

  it("keeps legitimate but unusual states (locked quotes, zero sizes)", () => {
    const { adapter, portfolio } = markedPortfolio("quarantine");
    adapter.ingestFrame(JSON.stringify([{ ...quote(501, 501), bs: 0 }]));
    expect(portfolio.getPosition("SPY")!.currentPrice).toBe(501);
    expect(adapter.quarantineCounts()).toEqual({});
  });

  it("drops every reject-severity kind and counts each separately", () => {
    const bus = new EventBus();
    const published: string[] = [];
    bus.onAll((e) => { published.push(e.type); });
    const adapter = new AlpacaMarketDataAdapter(bus, "paper", { invalidData: "quarantine" });
    adapter.ingestFrame(JSON.stringify([
      quote(500.05, 500), quote(-1, -1), { ...quote(500, 500.02), t: "bad" },
      { T: "t", S: "SPY", p: 0, s: 1, t: T },
      { T: "b", S: "SPY", o: 1, h: 0.5, l: 1, c: 1, v: 1, t: "2026-03-10T14:30:00Z" },
      { T: "t", S: "SPY", p: 500, s: 1, t: T },
    ]));
    expect(published).toEqual(["TRADE_RECEIVED"]);
    expect(adapter.quarantineCounts()).toEqual({
      "quote.CROSSED_QUOTE": 1, "quote.NON_POSITIVE_PRICE": 1, "quote.BAD_TIMESTAMP": 1,
      "trade.NON_POSITIVE_PRICE": 1, "bar.INVALID_BAR_RANGE": 1,
    });
  });

  it("logs at the 1st, 10th and 100th drop of a kind, not on every one", () => {
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => {});
    const { adapter } = markedPortfolio("quarantine");
    for (let i = 0; i < 150; i++) adapter.ingestFrame(JSON.stringify([quote(500, 0)]));
    const counts = warn.mock.calls
      .filter(([msg]) => String(msg).includes("dropped unusable market data"))
      .map(([, ctx]) => (ctx as { count: number }).count);
    expect(counts).toEqual([1, 10, 100]);
    expect(adapter.quarantineCounts()["quote.ONE_SIDED_QUOTE"]).toBe(150);
  });
});
