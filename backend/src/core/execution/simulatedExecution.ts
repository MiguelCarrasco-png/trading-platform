/**
 * core/execution/simulatedExecution.ts
 *
 * Simulated execution sink for backtesting and replay modes.
 *
 * Behavior (backtest, bar-driven):
 *   - submitOrder() returns an unfilled Order (status="submitted", filledQty=0,
 *     fills=[]) and queues the intent. ORDER_FILLED is NOT emitted at submit time.
 *   - processBarOpen(bar) fills any queued intents for that symbol against the
 *     bar using the configured FillModel. This guarantees no same-bar lookahead:
 *     a strategy that submits on bar N's close can only see fills at bar N+1.
 *   - flushPending(symbol) fills queued intents at the latest mid price. Used
 *     for replay/quote-driven modes that don't emit bars.
 *   - cancelOrder() can target either a queued intent (cancels before fill) or
 *     a broker order id; broker-id cancellation is a no-op since simulated
 *     fills complete atomically once a bar arrives.
 *   - If no usable reference price is available, the order is rejected via
 *     ORDER_REJECTED rather than filled at $0.
 *
 * Quote model (ExecutionConfig.model = "quote", see quoteFillModel.ts):
 *   - Orders are priced against real quotes when they reach the market,
 *     latencyMs after the decision. The quotes come from a HistoricalTickSource,
 *     which is asynchronous while the event bus is not, so the engine calls
 *     planArrivals() / planResting() between timestamp batches and then
 *     applies each plan in time order, setting the simulated clock to it.
 *   - Resting limits fill on regular-session trades printing through their
 *     price, checked minute by minute and fetched only for minutes whose bar
 *     reached the limit. A DAY order expires at its regular session's close
 *     (planExpiries); GTC orders rest until filled, canceled, or the run ends.
 *   - An order the quote model cannot price falls back to the bar model; its
 *     fill records why. Every fill records what priced it (Fill.source).
 *
 * Inputs:  OrderIntent from the ExecutionEngine; current symbol state for prices.
 * Outputs: Submitted Order; publishes ORDER_SUBMITTED + ORDER_FILLED/ORDER_REJECTED.
 */

import { EventBus } from "../engine/eventBus";
import { SymbolStateManager } from "../state/symbolState";
import { logger } from "../../utils/logger";
import { barEndMs, msToIso, nowMs } from "../../utils/time";
import { newId } from "../../utils/ids";
import {
  DEFAULT_FILL_MODEL,
  evaluateFill,
  type FillModelConfig,
} from "./fillModel";
import {
  DEFAULT_EXECUTION,
  arrivalWindow,
  decideArrival,
  restingLimitFill,
  type ArrivalDecision,
  type ExecutionConfig,
} from "./quoteFillModel";
import type { IExecutionSink } from "./IExecutionSink";
import { buildClientOrderId } from "../ledger/clientOrderId";
import { regularSessionCloseAfter, regularSessionHours } from "../market/marketHours";
import type { HistoricalTickSource } from "../backtest/tickSource";
import type { OrderIntent, Order, Fill } from "../../types/orders";
import type { ExecutionMode, Symbol, TimeInForce } from "../../types/common";
import type { Bar, Quote } from "../../types/market";

interface QueuedIntent {
  intent: OrderIntent;
  order: Order;
  /**
   * "bar": filled by processBarOpen — the bar model, or a quote-model fallback.
   * "arrival": quote model, to be priced when it reaches the market.
   * "resting": quote model, a limit waiting for a trade through its price.
   */
  stage: "bar" | "arrival" | "resting";
  /** Shares filled so far; a resting limit fills piecewise. */
  filledQty: number;
  /** When a resting limit reached the market. */
  liveAt?: number;
  /** When a resting DAY order expires: the close of its regular session. GTC orders have none. */
  expiresAt?: number;
  /** Quote-model context copied onto the order's fills. */
  attribution?: Pick<Fill, "arrivalBid" | "arrivalAsk" | "decisionMid">;
  /** Why a quote-model order is being priced by the bar model. */
  fallbackReason?: string;
}

/**
 * When a resting order placed live at `liveAt` expires: GTC never (within a
 * run); DAY — and anything else that rests — at the close of its regular session.
 */
function sessionExpiry(timeInForce: TimeInForce, liveAt: number): number | undefined {
  return timeInForce === "gtc" ? undefined : regularSessionCloseAfter(liveAt);
}

/** When a decision takes effect: its fill or expiry, its arrival when resting, the decision itself on fallback. */
function decisionTs(decision: ArrivalDecision, submittedAt: number): number {
  if (decision.kind === "fallback") return submittedAt;
  if (decision.kind === "rest") return decision.liveAt;
  return decision.ts;
}

/** An arriving order's decision, ready to publish at `ts`. */
export interface ArrivalPlan {
  entry: QueuedIntent;
  decision: ArrivalDecision | { kind: "fallback"; reason: "quote_data_unavailable" };
  ts: number;
}

/** A resting limit's fill for one minute, ready to publish at `ts`. */
export interface RestingPlan {
  entry: QueuedIntent;
  ts: number;
  qty: number;
}

/** A resting order reaching the end of its session, ready to publish at `ts`. */
export interface ExpiryPlan {
  entry: QueuedIntent;
  ts: number;
}

/** Counts and costs describing how a run's orders were priced. */
export interface ExecutionReport extends ExecutionConfig {
  fills: { quote: number; trade: number; bar: number };
  /** Quote-model orders priced by the bar model, by reason. */
  fallbacks: Record<string, number>;
  /** IOC/FOK limits that were not marketable on arrival. */
  expiredUnmarketable: number;
  /** Resting DAY orders that reached the regular-session close unfilled. */
  expiredAtClose: number;
  /** Minutes a resting limit could not be checked because trades were unavailable. */
  tradeDataUnavailable: number;
  /** Notional-weighted cost of crossing the spread on quote fills, vs the arrival mid (bps). */
  avgSpreadCostBps: number | null;
  /** Notional-weighted move of the mid between decision and arrival, against the order (bps). */
  avgDelayCostBps: number | null;
}

export class SimulatedExecutionSink implements IExecutionSink {
  private readonly pending: Map<Symbol, QueuedIntent[]> = new Map();
  private readonly fillModel: FillModelConfig;
  private readonly stats = {
    fills: { quote: 0, trade: 0, bar: 0 },
    fallbacks: {} as Record<string, number>,
    expiredUnmarketable: 0,
    expiredAtClose: 0,
    tradeDataUnavailable: 0,
    costNotional: 0,
    spreadCostBpsNotional: 0,
    delayNotional: 0,
    delayCostBpsNotional: 0,
  };

  /**
   * @param eventBus - EventBus to publish fill events onto
   * @param symbolState - SymbolStateManager for current market prices
   * @param mode - Execution mode (backtest or replay)
   * @param slippageBps - Legacy slippage (overridden by fillModel.slippageBps if provided)
   * @param commissionPerShare - Legacy commission (overridden by fillModel.commissionPerShare)
   * @param fillModel - Optional partial fill-model override
   * @param execution - How orders are priced; the quote model needs plan/apply calls from the engine
   */
  constructor(
    private readonly eventBus: EventBus,
    private readonly symbolState: SymbolStateManager,
    private readonly mode: ExecutionMode,
    slippageBps = 5,
    commissionPerShare = 0.005,
    fillModel?: Partial<FillModelConfig>,
    private readonly execution: ExecutionConfig = DEFAULT_EXECUTION,
  ) {
    // Legacy ctor compatibility: when no explicit fillModel override is
    // supplied, the sink behaves like the prior revision — no half-spread,
    // no volume cap, no partial fills. Callers that want the new modeling
    // depth must opt in by passing a fillModel argument (BacktestEngine does).
    const legacy = fillModel === undefined;
    this.fillModel = legacy
      ? {
          ...DEFAULT_FILL_MODEL,
          slippageBps,
          commissionPerShare,
          halfSpreadBps: 0,
          volumeParticipationCap: 1,
          allowPartialFills: false,
        }
      : {
          ...DEFAULT_FILL_MODEL,
          slippageBps,
          commissionPerShare,
          ...fillModel,
        };

    // Subscribe BEFORE the Orchestrator's BAR_RECEIVED handler so queued
    // intents fill at the new bar's open price prior to strategies seeing
    // the bar. EventBus dispatches handlers in registration order.
    this.eventBus.on("BAR_RECEIVED", (e) => {
      const ev = e as { payload: Bar };
      this.processBarOpen(ev.payload);
    });
  }

  /** Returns the effective fill model in use (after defaults + overrides). */
  getFillModel(): FillModelConfig {
    return { ...this.fillModel };
  }

  /**
   * Submits an intent. The order is created in "submitted" state with zero
   * fills and queued for execution on the next bar's open (or via flushPending),
   * or, under the quote model, for pricing when it reaches the market.
   */
  async submitOrder(intent: OrderIntent): Promise<Order> {
    const ts = intent.ts;

    const order: Order = {
      id: intent.id,
      brokerOrderId: `sim_${intent.id}`,
      intentId: intent.id,
      strategyId: intent.strategyId,
      symbol: intent.symbol,
      side: intent.side,
      qty: intent.qty,
      filledQty: 0,
      avgFillPrice: undefined,
      orderType: intent.orderType,
      limitPrice: intent.limitPrice,
      stopPrice: intent.stopPrice,
      timeInForce: intent.timeInForce,
      status: "submitted",
      submittedAt: ts,
      updatedAt: ts,
      fills: [],
      runId: intent.runId,
      signalId: intent.signalId,
      clientOrderId: buildClientOrderId(intent.id, intent.runId),
      decisionPrice: intent.decisionPrice,
    };

    const list = this.pending.get(intent.symbol) ?? [];
    list.push({ intent, order, stage: this.execution.model === "quote" ? "arrival" : "bar", filledQty: 0 });
    this.pending.set(intent.symbol, list);

    this.eventBus.publish({
      id: newId(),
      type: "ORDER_SUBMITTED",
      ts,
      mode: this.mode,
      payload: order,
    });

    return order;
  }

  /**
   * Drains the bar-model intents queued for the given symbol, filling each
   * through the fill model against the new bar. Quote-model orders still
   * waiting to arrive, or resting, stay queued.
   *
   * An order fills only against a bar that ends after it was placed. A bar
   * that completed before the decision — another symbol's bar published later
   * in the same batch, or arriving later in the same live minute — would fill
   * it at a price from before the strategy decided.
   */
  processBarOpen(bar: Bar): void {
    const queue = this.pending.get(bar.symbol);
    if (!queue || queue.length === 0) return;
    const end = barEndMs(bar);
    const due = queue.filter((q) => q.stage === "bar" && end > q.order.submittedAt);
    if (due.length === 0) return;
    this.pending.set(bar.symbol, queue.filter((q) => !due.includes(q)));
    for (const { intent, order, fallbackReason } of due) {
      this._fillWithModel(intent, order, bar, fallbackReason);
    }
  }

  // ------------------------------------------------------------------
  // Quote model
  // ------------------------------------------------------------------

  /** True when quote-model orders are waiting to be priced on arrival. */
  hasArrivals(): boolean {
    return this._entries("arrival").length > 0;
  }

  /** True when quote-model limits are resting. */
  hasResting(): boolean {
    return this._entries("resting").length > 0;
  }

  /**
   * Prices every order waiting to reach the market, fetching the quotes each
   * needs, without publishing anything. Apply the plans in order with
   * applyArrival(), setting the simulated clock to each plan's ts first.
   * A failed quote fetch makes that order fall back to the bar model.
   */
  async planArrivals(source: HistoricalTickSource): Promise<ArrivalPlan[]> {
    const windows = new Map<string, Promise<Quote[]>>();
    const plans: ArrivalPlan[] = [];
    for (const entry of this._entries("arrival")) {
      const submittedAt = entry.order.submittedAt;
      const { startMs, endMs } = arrivalWindow(submittedAt, this.execution);
      const key = `${entry.intent.symbol}|${startMs}|${endMs}`;
      if (!windows.has(key)) windows.set(key, source.quotes(entry.intent.symbol, startMs, endMs));
      let quotes: Quote[];
      try {
        quotes = await windows.get(key)!;
      } catch (err) {
        logger.warn("SimulatedExecutionSink: quotes unavailable — pricing the order with the bar model", {
          symbol: entry.intent.symbol, at: msToIso(submittedAt), err: String(err),
        });
        plans.push({ entry, decision: { kind: "fallback", reason: "quote_data_unavailable" }, ts: submittedAt });
        continue;
      }
      const decision = decideArrival(entry.order, submittedAt, quotes, this.execution);
      plans.push({ entry, decision, ts: decisionTs(decision, submittedAt) });
    }
    return plans.sort((a, b) => a.ts - b.ts);
  }

  /** Publishes one arrival plan. The caller has set the simulated clock to plan.ts. */
  applyArrival(plan: ArrivalPlan): void {
    const { entry, decision } = plan;
    if (!this._isQueued(entry)) return; // canceled since it was planned
    if (decision.kind === "fallback") {
      entry.stage = "bar";
      entry.fallbackReason = decision.reason;
      this.stats.fallbacks[decision.reason] = (this.stats.fallbacks[decision.reason] ?? 0) + 1;
      return;
    }
    const attribution = {
      arrivalBid: decision.arrival.bidPrice,
      arrivalAsk: decision.arrival.askPrice,
      ...(decision.decision ? { decisionMid: decision.decision.midPrice } : {}),
    };
    if (decision.kind === "rest") {
      entry.stage = "resting";
      entry.liveAt = decision.liveAt;
      entry.expiresAt = sessionExpiry(entry.order.timeInForce, decision.liveAt);
      entry.attribution = attribution;
      return;
    }
    this._dequeue(entry);
    if (decision.kind === "expire") {
      this.stats.expiredUnmarketable++;
      this.eventBus.publish({ id: newId(), type: "ORDER_EXPIRED", ts: decision.ts, mode: this.mode, orderId: entry.order.id });
      return;
    }
    const qty = entry.order.qty;
    this._recordQuoteCosts(entry.order.side, qty * decision.price, decision.price, decision.arrival, decision.decision);
    this._publishFill(entry, qty, decision.price, decision.ts, { source: "quote", ...attribution }, true);
  }

  /**
   * For resting limits on the symbols of one completed minute (`bars`), plans
   * fills from regular-session trades printing through each limit during that
   * minute. Trades are fetched only when the bar's range reached through the
   * limit; a minute whose trades cannot be fetched is skipped and counted.
   */
  async planResting(bars: readonly Bar[], source: HistoricalTickSource): Promise<RestingPlan[]> {
    const plans: RestingPlan[] = [];
    for (const bar of bars) {
      if (!regularSessionHours.isOpen(bar.ts)) continue;
      for (const entry of this.pending.get(bar.symbol) ?? []) {
        if (entry.stage !== "resting") continue;
        const plan = await this._planRestingMinute(entry, bar, source);
        if (plan) plans.push(plan);
      }
    }
    return plans.sort((a, b) => a.ts - b.ts);
  }

  /** One resting limit against one completed minute of its symbol. */
  private async _planRestingMinute(entry: QueuedIntent, bar: Bar, source: HistoricalTickSource): Promise<RestingPlan | null> {
    const limit = entry.order.limitPrice!;
    const minuteEnd = barEndMs(bar);
    const liveAt = entry.liveAt ?? entry.order.submittedAt;
    // Nothing printed through the limit this minute if the bar never got there.
    const reached = entry.order.side === "buy" ? bar.low < limit : bar.high > limit;
    const expired = entry.expiresAt !== undefined && bar.ts >= entry.expiresAt;
    if (liveAt >= minuteEnd || !reached || expired) return null;

    const fromMs = Math.max(liveAt, bar.ts);
    try {
      const trades = await source.trades(bar.symbol, fromMs, minuteEnd);
      const fill = restingLimitFill(entry.order.side, limit, entry.order.qty - entry.filledQty, fromMs, trades);
      return fill ? { entry, ts: fill.ts, qty: fill.qty } : null;
    } catch (err) {
      this.stats.tradeDataUnavailable++;
      logger.warn("SimulatedExecutionSink: trades unavailable — resting limit not checked this minute", {
        symbol: bar.symbol, minute: bar.isoTs, err: String(err),
      });
      return null;
    }
  }

  /** True when some queued order expires at a session close. */
  hasExpiring(): boolean {
    for (const queue of this.pending.values()) {
      if (queue.some((q) => q.expiresAt !== undefined)) return true;
    }
    return false;
  }

  /**
   * Queued orders whose session closed at or before `nowMs`, in the order they
   * expired. Apply each with applyExpiry() at its own ts.
   */
  planExpiries(nowMs: number): ExpiryPlan[] {
    const plans: ExpiryPlan[] = [];
    for (const queue of this.pending.values()) {
      for (const entry of queue) {
        if (entry.expiresAt !== undefined && entry.expiresAt <= nowMs) plans.push({ entry, ts: entry.expiresAt });
      }
    }
    return plans.sort((a, b) => a.ts - b.ts);
  }

  /** Publishes one expiry. The caller has set the simulated clock to plan.ts. */
  applyExpiry(plan: ExpiryPlan): void {
    const { entry, ts } = plan;
    if (!this._isQueued(entry)) return;
    this._dequeue(entry);
    this.stats.expiredAtClose++;
    this.eventBus.publish({ id: newId(), type: "ORDER_EXPIRED", ts, mode: this.mode, orderId: entry.order.id });
  }

  /** Publishes one resting-limit fill. The caller has set the simulated clock to plan.ts. */
  applyResting(plan: RestingPlan): void {
    const { entry, qty, ts } = plan;
    if (!this._isQueued(entry) || entry.stage !== "resting") return;
    const complete = entry.filledQty + qty >= entry.order.qty;
    if (complete) this._dequeue(entry);
    this._publishFill(entry, qty, entry.order.limitPrice!, ts, { source: "trade", ...entry.attribution }, complete);
  }

  /** How this run's orders were priced: the execution config plus counts and costs. */
  executionReport(): ExecutionReport {
    const s = this.stats;
    return {
      ...this.execution,
      fills: { ...s.fills },
      fallbacks: { ...s.fallbacks },
      expiredUnmarketable: s.expiredUnmarketable,
      expiredAtClose: s.expiredAtClose,
      tradeDataUnavailable: s.tradeDataUnavailable,
      avgSpreadCostBps: s.costNotional > 0 ? s.spreadCostBpsNotional / s.costNotional : null,
      avgDelayCostBps: s.delayNotional > 0 ? s.delayCostBpsNotional / s.delayNotional : null,
    };
  }

  private _entries(stage: QueuedIntent["stage"]): QueuedIntent[] {
    const out: QueuedIntent[] = [];
    for (const queue of this.pending.values()) {
      for (const q of queue) if (q.stage === stage) out.push(q);
    }
    return out;
  }

  private _isQueued(entry: QueuedIntent): boolean {
    return (this.pending.get(entry.intent.symbol) ?? []).includes(entry);
  }

  private _dequeue(entry: QueuedIntent): void {
    const queue = this.pending.get(entry.intent.symbol) ?? [];
    this.pending.set(entry.intent.symbol, queue.filter((q) => q !== entry));
  }

  /** Accumulates notional-weighted spread and delay costs, signed against the order. */
  private _recordQuoteCosts(side: "buy" | "sell", notional: number, price: number, arrival: Quote, decision: Quote | null): void {
    const sign = side === "buy" ? 1 : -1;
    const arrivalMid = arrival.midPrice;
    this.stats.costNotional += notional;
    this.stats.spreadCostBpsNotional += (sign * (price - arrivalMid) / arrivalMid) * 10_000 * notional;
    if (decision) {
      this.stats.delayNotional += notional;
      this.stats.delayCostBpsNotional += (sign * (arrivalMid - decision.midPrice) / decision.midPrice) * 10_000 * notional;
    }
  }

  /** Publishes a fill of `qty` at `price`: the order's last piece as ORDER_FILLED, otherwise a partial. */
  private _publishFill(
    entry: QueuedIntent,
    qty: number,
    price: number,
    ts: number,
    attribution: Partial<Fill>,
    complete: boolean,
  ): void {
    entry.filledQty += qty;
    const source = attribution.source ?? "bar";
    this.stats.fills[source]++;
    const fill: Fill = {
      id: newId(),
      orderId: entry.intent.id,
      symbol: entry.intent.symbol,
      side: entry.intent.side,
      qty,
      price,
      notional: qty * price,
      commission: qty * this.fillModel.commissionPerShare,
      ts,
      isoTs: msToIso(ts),
      ...attribution,
    };
    if (complete) {
      this.eventBus.publish({ id: newId(), type: "ORDER_FILLED", ts, mode: this.mode, orderId: entry.order.id, fill });
    } else {
      this.eventBus.publish({
        id: newId(), type: "ORDER_PARTIAL_FILL", ts, mode: this.mode, orderId: entry.order.id,
        fill, remainingQty: entry.order.qty - entry.filledQty,
      });
    }
  }

  /**
   * Drains queued intents for the given symbol at the latest mid price. Used
   * by replay/quote-driven flows that don't emit bars. Returns the number of
   * orders processed.
   */
  flushPending(symbol: Symbol): number {
    const queue = this.pending.get(symbol);
    if (!queue || queue.length === 0) return 0;
    this.pending.set(symbol, []);
    const symState = this.symbolState.get(symbol);
    const refPrice = symState?.latestMid ?? null;
    const ts =
      symState?.latestQuote?.ts ??
      symState?.latestTrade?.ts ??
      symState?.latestBar?.ts ??
      nowMs();
    for (const { intent, order } of queue) {
      this._fillAtFlush(intent, order, refPrice, ts);
    }
    return queue.length;
  }

  /** Returns the count of queued intents (for diagnostics/tests). */
  pendingCount(symbol?: Symbol): number {
    if (symbol) return this.pending.get(symbol)?.length ?? 0;
    let total = 0;
    for (const q of this.pending.values()) total += q.length;
    return total;
  }

  /**
   * Cancels a queued simulated order. Accepts either the broker order id
   * (e.g. "sim_<intentId>") or the internal order id directly. If found,
   * publishes ORDER_CANCELED and removes the intent from the queue so it
   * will not fill on the next bar. Returns true if a queued order was found.
   */
  async cancelOrder(brokerOrderId: string): Promise<void> {
    const normalized = brokerOrderId.startsWith("sim_")
      ? brokerOrderId.slice(4)
      : brokerOrderId;

    for (const [symbol, queue] of this.pending) {
      const idx = queue.findIndex(
        (q) => q.order.id === normalized || q.order.brokerOrderId === brokerOrderId,
      );
      if (idx === -1) continue;
      const [{ order }] = queue.splice(idx, 1);
      this.pending.set(symbol, queue);
      this.eventBus.publish({
        id: newId(),
        type: "ORDER_CANCELED",
        ts: nowMs(),
        mode: this.mode,
        orderId: order.id,
        reason: "Canceled via SimulatedExecutionSink",
      });
      return;
    }
    // No-op if the order is not queued — it has already filled, expired, or
    // was rejected before this call.
  }

  /**
   * Terminal cleanup for any intents still queued at the end of a backtest.
   * Each pending intent is expired via ORDER_EXPIRED.
   *
   * @returns Number of intents expired.
   */
  expireAllPending(): number {
    let expired = 0;
    for (const [symbol, queue] of this.pending) {
      if (queue.length === 0) continue;
      for (const { order } of queue) {
        const ts = order.updatedAt;
        this.eventBus.publish({
          id: newId(),
          type: "ORDER_EXPIRED",
          ts,
          mode: this.mode,
          orderId: order.id,
        });
        expired++;
      }
      this.pending.set(symbol, []);
    }
    if (expired > 0) {
      logger.info("SimulatedExecutionSink: expired pending intents at terminal drain", { expired });
    }
    return expired;
  }

  // ------------------------------------------------------------------
  // Private
  // ------------------------------------------------------------------

  /** Runs the configured fill model against a bar and emits fill/reject events. */
  private _fillWithModel(intent: OrderIntent, order: Order, bar: Bar, fallbackReason?: string): void {
    const decision = evaluateFill(intent, bar, this.fillModel);
    const ts = bar.ts;
    // Under the quote model every fill says what priced it; bar-model runs stay as they were.
    const attribution: Partial<Fill> = this.execution.model === "quote"
      ? { source: "bar", ...(fallbackReason ? { fallbackReason } : {}) }
      : {};

    if (decision.outcome === "rejected" || decision.fillPrice === null) {
      order.status = "rejected";
      order.updatedAt = ts;
      order.closedAt = ts;
      logger.warn("SimulatedExecutionSink: order rejected by fill model", {
        symbol: intent.symbol,
        side: intent.side,
        qty: intent.qty,
        reason: decision.reason,
      });
      this.eventBus.publish({
        id: newId(),
        type: "ORDER_REJECTED",
        ts,
        mode: this.mode,
        orderId: order.id,
        reason: decision.reason ?? "Rejected by fill model",
      });
      return;
    }

    const fill: Fill = {
      id: newId(),
      orderId: intent.id,
      symbol: intent.symbol,
      side: intent.side,
      qty: decision.filledQty,
      price: decision.fillPrice,
      notional: decision.filledQty * decision.fillPrice,
      commission: decision.filledQty * this.fillModel.commissionPerShare,
      ts,
      isoTs: msToIso(ts),
      ...attribution,
    };
    this.stats.fills.bar++;

    if (decision.outcome === "partial") {
      this.eventBus.publish({
        id: newId(),
        type: "ORDER_PARTIAL_FILL",
        ts,
        mode: this.mode,
        orderId: order.id,
        fill,
        remainingQty: decision.remainingQty,
      });
      // IOC: the unfilled remainder cannot be requeued. Mark the order as
      // expired (the orchestrator will transition it to a terminal state).
      if (intent.timeInForce === "ioc" || intent.timeInForce === "fok") {
        this.eventBus.publish({
          id: newId(),
          type: "ORDER_EXPIRED",
          ts,
          mode: this.mode,
          orderId: order.id,
        });
      }
      return;
    }

    this.eventBus.publish({
      id: newId(),
      type: "ORDER_FILLED",
      ts,
      mode: this.mode,
      orderId: order.id,
      fill,
    });
  }

  /**
   * Legacy mid-based fill path used by `flushPending` (quote-driven flows).
   * Simpler than the bar fill model — no volume cap or spread synthesis since
   * the mid price already comes from a fresh quote.
   */
  private _fillAtFlush(
    intent: OrderIntent,
    order: Order,
    refPrice: number | null | undefined,
    ts: number,
  ): void {
    if (refPrice == null || !Number.isFinite(refPrice) || refPrice <= 0) {
      order.status = "rejected";
      order.updatedAt = ts;
      order.closedAt = ts;
      logger.warn("SimulatedExecutionSink: rejecting flush order, no valid reference price", {
        symbol: intent.symbol,
        side: intent.side,
        qty: intent.qty,
      });
      this.eventBus.publish({
        id: newId(),
        type: "ORDER_REJECTED",
        ts,
        mode: this.mode,
        orderId: order.id,
        reason: "No valid reference price available for simulated fill",
      });
      return;
    }
    const slippageFactor = this.fillModel.slippageBps / 10_000;
    const fillPrice =
      intent.side === "buy"
        ? refPrice * (1 + slippageFactor)
        : refPrice * (1 - slippageFactor);
    const fill: Fill = {
      id: newId(),
      orderId: intent.id,
      symbol: intent.symbol,
      side: intent.side,
      qty: intent.qty,
      price: fillPrice,
      notional: intent.qty * fillPrice,
      commission: intent.qty * this.fillModel.commissionPerShare,
      ts,
      isoTs: msToIso(ts),
    };
    this.eventBus.publish({
      id: newId(),
      type: "ORDER_FILLED",
      ts,
      mode: this.mode,
      orderId: order.id,
      fill,
    });
  }
}
