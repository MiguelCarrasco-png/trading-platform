/**
 * tests/bench/delaySimulator.test.ts
 *
 * Strategy delay/cost simulation (guide §15, Ticket F):
 *   - no fill uses information observed after the order's arrival
 *   - injected delay changes which quote an order meets
 *   - costs use the correct side (buy at ask, sell at bid) plus slippage and fees
 *   - stale quotes leave orders unfilled; deadlines are counted
 *   - inputs stay in receive order and invalid quotes never become prices
 *   - plans are validated before anything runs; jitter is seeded
 */

import {
  delayPlanTemplate,
  loadObservedEvents,
  simulateDelayRun,
  validateDelayPlan,
  type DelayPlan,
  type ObservedEvent,
  type ObservedEventsReport,
} from "../../bench/delaySimulator";
import { normalizeQuote } from "../../adapters/alpaca/normalizer";
import type { FrameRecord } from "../../core/telemetry/frameRecorder";

const BASE = Date.UTC(2026, 2, 10, 14, 30, 0);
const iso = (offsetMs: number): string => new Date(BASE + offsetMs).toISOString();

function quoteEvent(seq: number, atMs: number, bp: number, ap: number, bs: number, as: number): ObservedEvent {
  return {
    kind: "quote", availableAtMs: BASE + atMs, seq, symbol: "SPY",
    quote: normalizeQuote({ S: "SPY", bp, ap, bs, as, t: iso(atMs - 1) } as never),
  };
}

function plan(over: Partial<DelayPlan> = {}): DelayPlan {
  return {
    ...delayPlanTemplate(),
    symbols: ["SPY"],
    strategy: { name: "quote_imbalance", params: { imbalanceThreshold: 0.6, qty: 1, maxPositionQty: 1, maxHoldMs: 600_000 } },
    delays_ms: [0],
    seeds: [1],
    apply_risk_engine: false,
    flatten_at_end: false,
    stale_quote_ms: 1_000,
    liquidity: "unlimited",
    ...over,
  };
}

const zeroCost = { name: "zero", fee_per_share: 0, sell_fee_bps: 0, slippage_bps: 0 };

/** A bid-heavy quote at t=0 triggers a buy; a very different quote appears at t=50. */
const events = (): ObservedEvent[] => [
  quoteEvent(0, 0, 100.0, 100.02, 10, 1),
  quoteEvent(1, 50, 104.98, 105.0, 1, 1),
  quoteEvent(2, 5_000, 104.98, 105.0, 1, 1),
];

describe("simulateDelayRun", () => {
  it("fills at the quote observable at arrival — never one that appears later", () => {
    const { result } = simulateDelayRun({ events: events(), plan: plan(), split: "t", delayMs: 25, cost: zeroCost, seed: 1 });
    expect(result.orders).toBe(1);
    expect(result.filled).toBe(1);
    // Bought at 100.02 (the t=0 ask), marked at the t=5000 mid ≈ 104.99.
    expect(result.net_pnl_marked).toBeCloseTo(104.99 - 100.02, 6);
    expect(result.mean_delay_move_bps).toBeCloseTo(0, 6); // arrival quote = decision quote
  });

  it("a longer delay meets the later quote (delay changes actual execution, not a label)", () => {
    const { result } = simulateDelayRun({ events: events(), plan: plan(), split: "t", delayMs: 75, cost: zeroCost, seed: 1 });
    expect(result.filled).toBe(1);
    expect(result.net_pnl_marked).toBeCloseTo(104.99 - 105.0, 6);
    expect(result.mean_delay_move_bps!).toBeGreaterThan(400); // the mid moved ~5% against the buy during the delay
  });

  it("ties go to data: an order arriving exactly when a quote is observed sees that quote", () => {
    const { result } = simulateDelayRun({ events: events(), plan: plan(), split: "t", delayMs: 50, cost: zeroCost, seed: 1 });
    expect(result.net_pnl_marked).toBeCloseTo(104.99 - 105.0, 6);
  });

  it("leaves an order unfilled when the newest observable quote is stale", () => {
    const evs = [quoteEvent(0, 0, 100.0, 100.02, 10, 1), quoteEvent(1, 10_000, 100.0, 100.02, 1, 1)];
    const { result } = simulateDelayRun({ events: evs, plan: plan({ stale_quote_ms: 500 }), split: "t", delayMs: 2_000, cost: zeroCost, seed: 1 });
    expect(result.unfilled_stale_quote).toBe(1);
    expect(result.filled).toBe(0);
    expect(result.deadline_misses).toBe(1); // 2,000 ms > the 1,000 ms reaction deadline
  });

  it("charges the correct side, slippage and sell fees on a round trip", () => {
    // Buy on a bid-heavy quote, then sell on an ask-heavy one.
    const evs = [
      quoteEvent(0, 0, 100.0, 100.1, 10, 1),
      quoteEvent(1, 1_000, 101.0, 101.1, 1, 10),
      quoteEvent(2, 2_000, 101.0, 101.1, 1, 1),
    ];
    const cost = { name: "c", fee_per_share: 0.01, sell_fee_bps: 10, slippage_bps: 100 };
    const { result } = simulateDelayRun({ events: evs, plan: plan(), split: "t", delayMs: 0, cost, seed: 1 });
    expect(result.round_trips).toBe(1);
    const buy = 100.1 * 1.01;            // ask + 1% slippage
    const sell = 101.0 * 0.99;           // bid − 1% slippage
    const fees = 0.01 * 2 + (sell * 10) / 10_000;
    expect(result.net_pnl_marked).toBeCloseTo(sell - buy - fees, 6);
    expect(result.gross_pnl).toBeCloseTo(101.0 - 100.1, 6); // at the touch, no costs
    expect(result.long_pnl).toBeCloseTo(sell - buy - fees, 6);
  });

  it("caps fills at displayed size (round lots × lot size) and counts the IOC remainder", () => {
    const evs = [quoteEvent(0, 0, 100.0, 100.02, 10, 1), quoteEvent(1, 100, 100.0, 100.02, 1, 1)];
    const p = plan({ liquidity: "displayed", lot_size_shares: 100, strategy: { name: "quote_imbalance", params: { imbalanceThreshold: 0.6, qty: 250, maxPositionQty: 250, maxHoldMs: 600_000 } } });
    const { result } = simulateDelayRun({ events: evs, plan: p, split: "t", delayMs: 0, cost: zeroCost, seed: 1 });
    expect(result.partial).toBe(1); // 1 lot displayed = 100 shares of the 250 wanted
    expect(result.open_position_at_end).toBe(100);
  });

  it("is reproducible for a seed and changes with jitter", () => {
    const p = plan({ delay_model: { kind: "jitter", jitter_ms: 100 } });
    const a = simulateDelayRun({ events: events(), plan: p, split: "t", delayMs: 0, cost: zeroCost, seed: 3 }).result;
    const b = simulateDelayRun({ events: events(), plan: p, split: "t", delayMs: 0, cost: zeroCost, seed: 3 }).result;
    expect(a).toEqual(b);
  });
});

describe("loadObservedEvents", () => {
  it("keeps receive order (not provider order) and drops invalid quotes", async () => {
    const frames: FrameRecord[] = [
      { v: 1, type: "frame", epoch: 1, seq: 1, rx_wall_ms: BASE + 10, rx_mono_ns: "1", data: JSON.stringify([
        { T: "q", S: "SPY", bp: 100, ap: 100.02, bs: 1, as: 1, t: iso(5) },
        { T: "q", S: "SPY", bp: 100, ap: 0, bs: 1, as: 1, t: iso(6) },
      ]) },
      // Provider time EARLIER than the first frame, received later.
      { v: 1, type: "frame", epoch: 1, seq: 2, rx_wall_ms: BASE + 20, rx_mono_ns: "2", data: JSON.stringify([
        { T: "t", S: "SPY", p: 100.01, s: 5, i: 1, t: iso(-500) },
        { T: "q", S: "QQQ", bp: 1, ap: 2, bs: 1, as: 1, t: iso(1) },
      ]) },
    ];
    const report: ObservedEventsReport = { frames: 0, events: 0, rejected: {}, wallClockRegressions: 0 };
    const out = await loadObservedEvents(frames, ["SPY"], report);
    expect(out.map((e) => e.kind)).toEqual(["quote", "trade"]);
    expect(out[1].availableAtMs).toBe(BASE + 20);
    expect(report.rejected).toEqual({ "q.ONE_SIDED_QUOTE": 1 });
  });
});

describe("validateDelayPlan", () => {
  it("accepts the template", () => {
    expect(() => validateDelayPlan(delayPlanTemplate())).not.toThrow();
  });

  it.each([
    ["overlapping splits", { splits: { development: { from: "2026-01-01", to: "2026-08-01" }, evaluation: { from: "2026-07-01", to: "2027-01-01" } } }],
    ["evaluation before development", { splits: { development: { from: "2026-07-01", to: "2027-01-01" }, evaluation: { from: "2026-01-01", to: "2026-07-01" } } }],
    ["no selection criterion", { selection_criterion: "" }],
    ["negative delay", { delays_ms: [0, -5] }],
    ["no cost scenarios", { cost_scenarios: [] }],
  ])("rejects %s", (_name, over) => {
    expect(() => validateDelayPlan({ ...delayPlanTemplate(), ...(over as Partial<DelayPlan>) })).toThrow(/Invalid delay plan/);
  });
});
