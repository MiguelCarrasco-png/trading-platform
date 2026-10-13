/**
 * bench/delaySimulator.ts
 *
 * Strategy delay and cost sensitivity: replays recorded market events through
 * a fixed strategy and asks what its orders would have achieved had each one
 * reached the market `delay` ms later than the decision.
 *
 * Model (discrete events, one simulated clock):
 *   - Data events become observable at their recorded LOCAL receive time, in
 *     recorded receive order — never re-sorted into provider-time order. The
 *     zero-increment baseline is therefore the recording's own arrival sequence;
 *     the injected delay is ADDITIONAL decision-to-order-arrival latency.
 *   - Strategies evaluate at the data event's time (real IStrategy classes,
 *     nowMs() stepped to simulated time), the platform RiskEngine checks the
 *     intent, and an order is scheduled to arrive at decision + delay.
 *   - At arrival the order is filled against the latest VALID quote whose
 *     observation time ≤ arrival time (ties: data first). Buys pay the ask,
 *     sells receive the bid, then slippage and fees apply. No quote, or a quote
 *     older than stale_quote_ms → unfilled. With liquidity "displayed" the fill
 *     is capped at the displayed size (round lots × lot size); the IOC remainder
 *     is cancelled.
 *   - Invalid quotes (one-sided, crossed, ...) never become observable prices.
 *
 * This is an approximation: IEX top of book is not the consolidated market,
 * there is no queue position, no market impact and no hidden liquidity. Results
 * are labelled accordingly.
 *
 * Inputs:  ObservedEvent[] (from loadObservedEvents), DelayPlan, one grid cell.
 * Outputs: DelayRunResult (one row of delay-cost-results.csv) + segment rows.
 */

import { SymbolStateManager } from "../core/state/symbolState";
import { PortfolioStateManager } from "../core/state/portfolioState";
import { OrderStateManager } from "../core/state/orderState";
import { RiskEngine } from "../core/risk/riskEngine";
import {
  normalizeBar,
  normalizeQuote,
  normalizeTrade,
  validateRawBar,
  validateRawQuote,
  validateRawTrade,
} from "../adapters/alpaca/normalizer";
import { setClockOverride, isClockLockedForLive } from "../utils/time";
import { newId } from "../utils/ids";
import { seededRandom } from "./random";
import { buildBenchStrategies, type BenchStrategyName } from "./strategies";
import { ReplayClockLockedError } from "./processingReplay";
import { bucketUpperBound, type HistogramJSON } from "../core/telemetry/histogram";
import type { Bar, Quote, Trade } from "../types/market";
import type { Fill, OrderIntent } from "../types/orders";
import type { RecordingRecord } from "../core/telemetry/frameRecorder";

// ------------------------------------------------------------------
// Plan
// ------------------------------------------------------------------

export interface DelayCostScenario {
  name: string;
  /** Commission per share, USD. */
  fee_per_share: number;
  /** Regulatory fees on sells, bps of notional (approximation). */
  sell_fee_bps: number;
  /** Extra adverse price per fill beyond the touch, bps. */
  slippage_bps: number;
}

export type DelayModel =
  | { kind: "fixed" }
  | { kind: "jitter"; jitter_ms: number }
  | { kind: "empirical"; samples_ms: number[]; source: string };

export interface DelayPlan {
  plan_version: 1;
  description: string;
  strategy: { name: Exclude<BenchStrategyName, "none" | "null">; params?: Record<string, unknown> };
  symbols: string[];
  /** Chronological, non-overlapping UTC date ranges [from, to). */
  splits: { development: { from: string; to: string }; evaluation: { from: string; to: string } };
  delays_ms: number[];
  cost_scenarios: DelayCostScenario[];
  delay_model: DelayModel;
  seeds: number[];
  stale_quote_ms: number;
  liquidity: "displayed" | "unlimited";
  /** Shares per round lot for displayed-size caps (quote sizes are in round lots). */
  lot_size_shares: number;
  reaction_deadline_ms: number;
  initial_capital: number;
  apply_risk_engine: boolean;
  flatten_at_end: boolean;
  /** How a result will be judged, written down before running. */
  selection_criterion: string;
  delay_represents: "decision_to_order_arrival";
}

export const DEFAULT_DELAYS_MS = [0, 5, 10, 25, 50, 100, 250, 500, 1000, 2000];

export function delayPlanTemplate(): DelayPlan {
  return {
    plan_version: 1,
    description: "Fixed quote_imbalance v1 on SPY/QQQ; additional decision-to-arrival delay sensitivity.",
    strategy: { name: "quote_imbalance", params: { imbalanceThreshold: 0.6, qty: 1, maxPositionQty: 1, maxHoldMs: 30_000 } },
    symbols: ["SPY", "QQQ"],
    splits: {
      development: { from: "2026-01-01", to: "2026-07-01" },
      evaluation: { from: "2026-07-01", to: "2027-01-01" },
    },
    delays_ms: DEFAULT_DELAYS_MS,
    cost_scenarios: [
      { name: "touch_no_fees", fee_per_share: 0, sell_fee_bps: 0, slippage_bps: 0 },
      { name: "base", fee_per_share: 0, sell_fee_bps: 0.3, slippage_bps: 1 },
      { name: "stress", fee_per_share: 0.005, sell_fee_bps: 0.3, slippage_bps: 5 },
    ],
    delay_model: { kind: "fixed" },
    seeds: [1],
    stale_quote_ms: 2_000,
    liquidity: "displayed",
    lot_size_shares: 100,
    reaction_deadline_ms: 1_000,
    initial_capital: 100_000,
    apply_risk_engine: true,
    flatten_at_end: true,
    selection_criterion:
      "Report every cell. A delay is 'tolerable' only if base-scenario net P&L on the evaluation split stays " +
      "above zero by more than two standard errors; otherwise no break-even delay is established.",
    delay_represents: "decision_to_order_arrival",
  };
}

/** Rejects plans that would make the experiment ambiguous. */
export function validateDelayPlan(plan: DelayPlan): void {
  const fail = (m: string): never => { throw new Error(`Invalid delay plan: ${m}`); };
  if (plan.plan_version !== 1) fail("plan_version must be 1");
  if (!plan.symbols?.length) fail("symbols must not be empty");
  if (!plan.delays_ms?.length || plan.delays_ms.some((d) => !(d >= 0))) fail("delays_ms must be non-negative numbers");
  if (!plan.cost_scenarios?.length) fail("cost_scenarios must not be empty");
  if (!plan.seeds?.length) fail("seeds must not be empty");
  if (!plan.selection_criterion) fail("selection_criterion must be written down before running");
  const d = plan.splits?.development, e = plan.splits?.evaluation;
  if (!d || !e) fail("splits.development and splits.evaluation are required");
  const [d0, d1, e0, e1] = [d.from, d.to, e.from, e.to].map((s) => Date.parse(s));
  if ([d0, d1, e0, e1].some((x) => !Number.isFinite(x))) fail("split dates must be ISO dates");
  if (!(d0 < d1 && d1 <= e0 && e0 < e1)) fail("splits must be chronological and non-overlapping (development before evaluation)");
  if (!(plan.stale_quote_ms > 0)) fail("stale_quote_ms must be > 0");
  if (!(plan.lot_size_shares > 0)) fail("lot_size_shares must be > 0");
}

// ------------------------------------------------------------------
// Input
// ------------------------------------------------------------------

export type ObservedEvent =
  | { kind: "quote"; availableAtMs: number; seq: number; symbol: string; quote: Quote }
  | { kind: "trade"; availableAtMs: number; seq: number; symbol: string; trade: Trade }
  | { kind: "bar"; availableAtMs: number; seq: number; symbol: string; bar: Bar };

export interface ObservedEventsReport {
  frames: number;
  events: number;
  rejected: Record<string, number>;
  /** Wall clock stepped backwards between frames; times clamped to stay ordered. */
  wallClockRegressions: number;
}

/**
 * Converts recording frames into observable events in receive order. Invalid
 * ("reject") messages are dropped and counted; out-of-symbol messages skipped.
 */
export async function loadObservedEvents(
  records: Iterable<RecordingRecord> | AsyncIterable<RecordingRecord>,
  symbols: string[],
  report: ObservedEventsReport,
): Promise<ObservedEvent[]> {
  const wanted = new Set(symbols);
  const out: ObservedEvent[] = [];
  let lastMs = -Infinity;
  let seq = 0;
  for await (const rec of records as AsyncIterable<RecordingRecord>) {
    if (rec.type !== "frame") continue;
    report.frames++;
    let msgs: unknown;
    try {
      msgs = JSON.parse(rec.data);
    } catch {
      continue;
    }
    if (!Array.isArray(msgs)) continue;
    let at = rec.rx_wall_ms;
    if (at < lastMs) {
      report.wallClockRegressions++;
      at = lastMs;
    }
    lastMs = at;
    for (const raw of msgs as Array<Record<string, unknown>>) {
      if (!raw || typeof raw !== "object") continue;
      const symbol = raw["S"];
      if (typeof symbol !== "string" || !wanted.has(symbol)) continue;
      const kind = raw["T"];
      const issue = kind === "q" ? validateRawQuote(raw) : kind === "t" ? validateRawTrade(raw) : kind === "b" ? validateRawBar(raw) : null;
      if (kind !== "q" && kind !== "t" && kind !== "b") continue;
      if (issue?.severity === "reject") {
        const key = `${kind}.${issue.code}`;
        report.rejected[key] = (report.rejected[key] ?? 0) + 1;
        continue;
      }
      report.events++;
      if (kind === "q") out.push({ kind: "quote", availableAtMs: at, seq: seq++, symbol, quote: normalizeQuote(raw as never) });
      else if (kind === "t") out.push({ kind: "trade", availableAtMs: at, seq: seq++, symbol, trade: normalizeTrade(raw as never) });
      else out.push({ kind: "bar", availableAtMs: at, seq: seq++, symbol, bar: normalizeBar(raw as never, "1m") });
    }
  }
  return out;
}

/** Events whose observation date falls in [from, to). */
export function sliceByDate(events: ObservedEvent[], from: string, to: string): ObservedEvent[] {
  const a = Date.parse(from), b = Date.parse(to);
  return events.filter((e) => e.availableAtMs >= a && e.availableAtMs < b);
}

/** Draws delays from a probe histogram (bucket upper bounds, weighted by count). */
export function samplesFromHistogram(json: HistogramJSON, maxSamples = 10_000): number[] {
  const total = json.buckets.reduce((s, [, c]) => s + c, 0);
  if (total === 0) return [];
  const out: number[] = [];
  for (const [index, count] of json.buckets) {
    const n = Math.max(1, Math.round((count / total) * maxSamples));
    const ms = bucketUpperBound(index) / 1e6;
    for (let i = 0; i < n; i++) out.push(ms);
  }
  return out;
}

// ------------------------------------------------------------------
// Simulation
// ------------------------------------------------------------------

export interface DelayRunResult {
  split: string;
  delay_ms: number;
  cost_scenario: string;
  seed: number;
  strategy: string;
  strategy_version: number | null;
  events: number;
  signals: number;
  orders: number;
  risk_rejected: number;
  suppressed_in_flight: number;
  filled: number;
  partial: number;
  unfilled_no_quote: number;
  unfilled_stale_quote: number;
  unfilled_no_displayed_size: number;
  deadline_misses: number;
  round_trips: number;
  gross_pnl: number;
  net_pnl_marked: number;
  net_pnl_flattened: number;
  return_pct: number;
  max_drawdown_usd: number;
  max_drawdown_pct: number;
  fees_total: number;
  turnover_usd: number;
  turnover_x: number;
  avg_holding_ms: number | null;
  long_pnl: number;
  short_pnl: number;
  per_trade_pnl_mean: number | null;
  per_trade_pnl_stderr: number | null;
  mean_delay_move_bps: number | null;
  mean_shortfall_bps: number | null;
  open_position_at_end: number;
}

export interface SegmentRow {
  split: string;
  delay_ms: number;
  cost_scenario: string;
  seed: number;
  date: string;
  segment: string;
  round_trips: number;
  net_pnl: number;
}

interface PendingOrder {
  id: string;
  strategyId: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  decisionMs: number;
  arrivalMs: number;
  decisionMid: number | null;
  seq: number;
}

interface Lot {
  qty: number; // signed
  price: number;
  openedMs: number;
}

const NEW_YORK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** New York date and session segment of an instant. */
export function sessionSegment(ms: number): { date: string; segment: string } {
  const p = Object.fromEntries(NEW_YORK.formatToParts(ms).map((x) => [x.type, x.value]));
  const minute = Number(p.hour) * 60 + Number(p.minute);
  const segment =
    minute < 9 * 60 + 30 || minute >= 16 * 60 ? "extended"
      : minute < 10 * 60 ? "open"
        : minute >= 15 * 60 + 30 ? "close"
          : "midday";
  return { date: `${p.year}-${p.month}-${p.day}`, segment };
}

export interface DelayRunInput {
  events: ObservedEvent[];
  plan: DelayPlan;
  split: string;
  delayMs: number;
  cost: DelayCostScenario;
  seed: number;
}

/** Runs one cell of the delay × cost × seed grid. */
export function simulateDelayRun(input: DelayRunInput): { result: DelayRunResult; segments: SegmentRow[] } {
  if (isClockLockedForLive()) throw new ReplayClockLockedError();
  const { events, plan, delayMs, cost, seed } = input;
  const rand = seededRandom(seed);
  const sampleDelay = (): number => {
    const m = plan.delay_model;
    if (m.kind === "jitter") return delayMs + rand() * m.jitter_ms;
    if (m.kind === "empirical" && m.samples_ms.length > 0) return delayMs + m.samples_ms[Math.floor(rand() * m.samples_ms.length)];
    return delayMs;
  };

  let simNow = events[0]?.availableAtMs ?? 0;
  setClockOverride(() => Math.floor(simNow));
  try {
    const symbolState = new SymbolStateManager();
    const portfolio = new PortfolioStateManager(plan.initial_capital);
    const orderState = new OrderStateManager();
    const risk = new RiskEngine({ staleQuoteThresholdMs: plan.stale_quote_ms });
    const strategies = buildBenchStrategies({ name: plan.strategy.name, count: 1, symbols: plan.symbols, params: plan.strategy.params });
    for (const s of strategies) s.start();

    const lastQuote = new Map<string, { quote: Quote; at: number }>();
    const inFlight = new Set<string>();
    const pending: PendingOrder[] = [];
    const lots = new Map<string, Lot[]>();
    const grossPos = new Map<string, number>();
    let grossCash = plan.initial_capital;
    let netCash = plan.initial_capital;
    let orderSeq = 0;
    const r: DelayRunResult = {
      split: input.split, delay_ms: delayMs, cost_scenario: cost.name, seed,
      strategy: plan.strategy.name, strategy_version: strategies[0]?.version ?? null,
      events: events.length, signals: 0, orders: 0, risk_rejected: 0, suppressed_in_flight: 0,
      filled: 0, partial: 0, unfilled_no_quote: 0, unfilled_stale_quote: 0, unfilled_no_displayed_size: 0,
      deadline_misses: 0, round_trips: 0, gross_pnl: 0, net_pnl_marked: 0, net_pnl_flattened: 0, return_pct: 0,
      max_drawdown_usd: 0, max_drawdown_pct: 0, fees_total: 0, turnover_usd: 0, turnover_x: 0,
      avg_holding_ms: null, long_pnl: 0, short_pnl: 0, per_trade_pnl_mean: null, per_trade_pnl_stderr: null,
      mean_delay_move_bps: null, mean_shortfall_bps: null, open_position_at_end: 0,
    };
    const tradePnls: number[] = [];
    const holdings: number[] = [];
    const delayMoves: number[] = [];
    const shortfalls: number[] = [];
    const segments = new Map<string, SegmentRow>();
    let peak = plan.initial_capital;

    const mid = (sym: string): number | null => lastQuote.get(sym)?.quote.midPrice ?? symbolState.get(sym)?.latestBar?.close ?? null;
    const netEquity = (): number => {
      let eq = netCash;
      for (const p of portfolio.getAllPositions()) {
        const m = mid(p.symbol);
        if (m !== null) eq += p.qty * m;
      }
      return eq;
    };
    const markDrawdown = (): void => {
      const eq = netEquity();
      if (eq > peak) peak = eq;
      const dd = peak - eq;
      if (dd > r.max_drawdown_usd) {
        r.max_drawdown_usd = dd;
        r.max_drawdown_pct = peak > 0 ? dd / peak : 0;
      }
    };

    /** Applies a fill to lots, returning realized P&L of closed quantity. */
    const closeLots = (sym: string, signedQty: number, price: number, at: number): void => {
      const book = lots.get(sym) ?? [];
      let remaining = signedQty;
      while (remaining !== 0 && book.length > 0 && Math.sign(book[0].qty) !== Math.sign(remaining)) {
        const lot = book[0];
        const closeQty = Math.min(Math.abs(lot.qty), Math.abs(remaining));
        const direction = Math.sign(lot.qty);
        const pnl = (price - lot.price) * closeQty * direction;
        tradePnls.push(pnl);
        holdings.push(at - lot.openedMs);
        if (direction > 0) r.long_pnl += pnl; else r.short_pnl += pnl;
        r.round_trips++;
        const { date, segment } = sessionSegment(at);
        const key = `${date}|${segment}`;
        const row = segments.get(key) ?? {
          split: input.split, delay_ms: delayMs, cost_scenario: cost.name, seed, date, segment, round_trips: 0, net_pnl: 0,
        };
        row.round_trips++;
        row.net_pnl += pnl;
        segments.set(key, row);
        lot.qty -= closeQty * direction;
        remaining += closeQty * direction;
        if (lot.qty === 0) book.shift();
      }
      if (remaining !== 0) book.push({ qty: remaining, price, openedMs: at });
      lots.set(sym, book);
    };

    const fillOrder = (o: PendingOrder): void => {
      simNow = o.arrivalMs;
      inFlight.delete(`${o.strategyId}|${o.symbol}`);
      if (o.arrivalMs - o.decisionMs > plan.reaction_deadline_ms) r.deadline_misses++;
      const lq = lastQuote.get(o.symbol);
      if (!lq) { r.unfilled_no_quote++; return; }
      if (o.arrivalMs - lq.at > plan.stale_quote_ms) { r.unfilled_stale_quote++; return; }
      const q = lq.quote;
      const touch = o.side === "buy" ? q.askPrice : q.bidPrice;
      const displayed = (o.side === "buy" ? q.askSize : q.bidSize) * plan.lot_size_shares;
      const qty = plan.liquidity === "displayed" ? Math.min(o.qty, Math.floor(displayed)) : o.qty;
      if (qty <= 0) { r.unfilled_no_displayed_size++; return; }
      if (qty < o.qty) r.partial++; else r.filled++;

      const sign = o.side === "buy" ? 1 : -1;
      const slip = cost.slippage_bps / 10_000;
      const price = o.side === "buy" ? touch * (1 + slip) : touch * (1 - slip);
      const notional = qty * price;
      const fees = qty * cost.fee_per_share + (o.side === "sell" ? (notional * cost.sell_fee_bps) / 10_000 : 0);
      r.fees_total += fees;
      r.turnover_usd += notional;
      grossCash -= sign * qty * touch;
      grossPos.set(o.symbol, (grossPos.get(o.symbol) ?? 0) + sign * qty);
      netCash -= sign * notional + fees;
      if (o.decisionMid !== null && o.decisionMid > 0) {
        delayMoves.push(((q.midPrice - o.decisionMid) / o.decisionMid) * 10_000 * sign);
        shortfalls.push(((price - o.decisionMid) / o.decisionMid) * 10_000 * sign);
      }
      // Fees are charged to the trade that closes a position via lots at the effective price.
      closeLots(o.symbol, sign * qty, price + (sign * fees) / qty, o.arrivalMs);
      const fill: Fill = {
        id: newId(), orderId: o.id, symbol: o.symbol, side: o.side, qty, price, notional,
        commission: fees, ts: Math.floor(o.arrivalMs), isoTs: new Date(Math.floor(o.arrivalMs)).toISOString(),
      };
      portfolio.applyFill(fill);
      markDrawdown();
    };

    const drainArrivals = (beforeMs: number, inclusive: boolean): void => {
      while (pending.length > 0 && (inclusive ? pending[0].arrivalMs <= beforeMs : pending[0].arrivalMs < beforeMs)) {
        fillOrder(pending.shift()!);
      }
    };

    const schedule = (o: PendingOrder): void => {
      let i = pending.length;
      while (i > 0 && (pending[i - 1].arrivalMs > o.arrivalMs || (pending[i - 1].arrivalMs === o.arrivalMs && pending[i - 1].seq > o.seq))) i--;
      pending.splice(i, 0, o);
    };

    for (const ev of events) {
      // Orders arriving strictly before this observation see the previous state.
      drainArrivals(ev.availableAtMs, false);
      simNow = ev.availableAtMs;
      if (ev.kind === "quote") {
        symbolState.onQuote(ev.quote);
        lastQuote.set(ev.symbol, { quote: ev.quote, at: ev.availableAtMs });
        portfolio.updatePrice(ev.symbol, ev.quote.midPrice);
        markDrawdown();
      } else if (ev.kind === "trade") {
        symbolState.onTrade(ev.trade);
      } else {
        symbolState.onBar(ev.bar);
      }

      for (const strategy of strategies) {
        if (!strategy.config.symbols.includes(ev.symbol)) continue;
        const signal = strategy.evaluate({ symbol: ev.symbol, symbolState, portfolioState: portfolio, orderState });
        if (!signal || signal.qty <= 0) continue;
        r.signals++;
        const legs: Array<{ symbol: string; side: "buy" | "sell"; qty: number }> = [];
        const sideOf = (d: string): "buy" | "sell" | null =>
          d === "long" || d === "close_short" ? "buy" : d === "short" || d === "close_long" ? "sell" : null;
        const side = sideOf(signal.direction);
        if (!side) continue;
        legs.push({ symbol: signal.symbol, side, qty: signal.qty });
        const meta = signal.meta ?? {};
        if (typeof meta["counterpartSymbol"] === "string" && typeof meta["counterpartDirection"] === "string") {
          const cSide = sideOf(meta["counterpartDirection"] as string);
          const cQty = Math.floor(signal.qty * ((meta["hedgeRatio"] as number) || 1));
          if (cSide && cQty > 0) legs.push({ symbol: meta["counterpartSymbol"] as string, side: cSide, qty: cQty });
        }
        for (const leg of legs) {
          const key = `${strategy.id}|${leg.symbol}`;
          if (inFlight.has(key)) { r.suppressed_in_flight++; continue; }
          const m = mid(leg.symbol);
          if (plan.apply_risk_engine) {
            const intent: OrderIntent = {
              id: newId(), strategyId: strategy.id, symbol: leg.symbol, side: leg.side, qty: leg.qty,
              orderType: "market", timeInForce: "ioc", ts: Math.floor(simNow),
            };
            const quoteAt = lastQuote.get(leg.symbol)?.quote.ts;
            const check = risk.check(intent, portfolio.getSnapshot(), m ?? undefined, quoteAt);
            if (!check.passed) { r.risk_rejected++; continue; }
          }
          r.orders++;
          inFlight.add(key);
          schedule({
            id: newId(), strategyId: strategy.id, symbol: leg.symbol, side: leg.side, qty: leg.qty,
            decisionMs: ev.availableAtMs, arrivalMs: ev.availableAtMs + sampleDelay(), decisionMid: m, seq: orderSeq++,
          });
        }
      }
    }
    // Orders still in flight at the end of data arrive against the last observable state.
    drainArrivals(Infinity, true);

    // Results.
    let grossEq = grossCash;
    for (const [sym, qty] of grossPos) grossEq += qty * (mid(sym) ?? 0);
    r.gross_pnl = grossEq - plan.initial_capital;
    r.net_pnl_marked = netEquity() - plan.initial_capital;
    let flattened = netCash;
    for (const p of portfolio.getAllPositions()) {
      if (p.qty === 0) continue;
      r.open_position_at_end += Math.abs(p.qty);
      const q = lastQuote.get(p.symbol)?.quote;
      const touch = q ? (p.qty > 0 ? q.bidPrice : q.askPrice) : mid(p.symbol) ?? 0;
      const slip = cost.slippage_bps / 10_000;
      const price = p.qty > 0 ? touch * (1 - slip) : touch * (1 + slip);
      const fees = Math.abs(p.qty) * cost.fee_per_share + (p.qty > 0 ? (Math.abs(p.qty) * price * cost.sell_fee_bps) / 10_000 : 0);
      flattened += p.qty * price - fees;
    }
    r.net_pnl_flattened = plan.flatten_at_end ? flattened - plan.initial_capital : r.net_pnl_marked;
    r.return_pct = r.net_pnl_flattened / plan.initial_capital;
    r.turnover_x = r.turnover_usd / plan.initial_capital;
    const meanOf = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    r.avg_holding_ms = meanOf(holdings);
    r.per_trade_pnl_mean = meanOf(tradePnls);
    if (tradePnls.length >= 2 && r.per_trade_pnl_mean !== null) {
      const m = r.per_trade_pnl_mean;
      const variance = tradePnls.reduce((s, x) => s + (x - m) ** 2, 0) / (tradePnls.length - 1);
      r.per_trade_pnl_stderr = Math.sqrt(variance / tradePnls.length);
    }
    r.mean_delay_move_bps = meanOf(delayMoves);
    r.mean_shortfall_bps = meanOf(shortfalls);
    return { result: r, segments: [...segments.values()] };
  } finally {
    setClockOverride(null);
  }
}
