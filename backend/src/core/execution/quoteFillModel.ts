/**
 * core/execution/quoteFillModel.ts
 *
 * Quote-based fill simulation for backtests: prices each order against the
 * real quotes and trades around it instead of a synthetic spread on the next
 * bar's open. Pure functions; SimulatedExecutionSink supplies the data.
 *
 *   - An order reaches the market `latencyMs` after the strategy decided.
 *     It trades against the quote prevailing then — the last one at or before
 *     arrival, if no older than `quoteLookbackMs` — or else the first quote
 *     within `maxQuoteWaitMs` after arrival.
 *   - Marketable orders (market, or a limit at or through the touch) fill in
 *     full at the touch: buys at the ask, sells at the bid, a limit never worse
 *     than its price. Displayed size and queue position are not modelled.
 *   - A non-marketable limit expires if IOC/FOK, otherwise rests. A resting
 *     limit fills only when a regular-session trade prints strictly through
 *     its price, at the limit, up to the size printed through it (conservative:
 *     a touch is not a fill).
 *   - No usable quote, or an order type this model does not price (stops),
 *     falls back to the bar model; the fill records why.
 *
 * Inputs:  Order fields, decision time, quotes or trades, ExecutionConfig.
 * Outputs: Fill / rest / expire / fallback decisions.
 */

import type { HistoricalFeed, Quote, Trade } from "../../types/market";
import type { OrderSide, OrderType, TimeInForce } from "../../types/common";

/** How a backtest prices its orders. */
export interface ExecutionConfig {
  /** "bar": next bar's open with a synthetic spread (FillModelConfig). "quote": real quotes and trades. */
  model: "bar" | "quote";
  /** Decision-to-market delay assumed for every order (ms). Calibrate against paper fills. */
  latencyMs: number;
  /** How old the last quote before arrival may be and still count as prevailing (ms). */
  quoteLookbackMs: number;
  /** How long after arrival to wait for a first quote when none is prevailing (ms). */
  maxQuoteWaitMs: number;
  /** Adverse slippage added to the quoted price for impact or unmodelled costs (bps). */
  extraSlippageBps: number;
  /** Feed the quotes and trades come from; fills happen against the consolidated book. */
  feed: HistoricalFeed;
}

export const DEFAULT_EXECUTION: ExecutionConfig = {
  model: "bar",
  latencyMs: 250,
  quoteLookbackMs: 5_000,
  maxQuoteWaitMs: 5_000,
  extraSlippageBps: 0,
  feed: "sip",
};

/**
 * Fills of a quote-model order must land before the next minute's decision,
 * so the delay plus the wait for a quote is capped well inside a minute.
 */
const MAX_ARRIVAL_SPAN_MS = 30_000;

/** Defaults merged with a partial override. */
export function resolveExecution(override?: Partial<ExecutionConfig> | null): ExecutionConfig {
  return { ...DEFAULT_EXECUTION, ...override };
}

/**
 * The execution setting to store on a queued backtest, from a request body's
 * `execution` field. Bar model (or nothing sent) → undefined, so such configs
 * keep the same fingerprint; quote model → fully resolved, so equivalent
 * requests share one. Throws with a client-facing message when invalid.
 */
export function executionForConfig(requested: unknown): ExecutionConfig | undefined {
  if (requested === undefined || requested === null) return undefined;
  if (typeof requested !== "object") throw new Error("execution must be an object");
  const resolved = resolveExecution(requested as Partial<ExecutionConfig>);
  const error = validateExecution(resolved);
  if (error) throw new Error(error);
  return resolved.model === "quote" ? resolved : undefined;
}

/** Returns a message describing the first invalid field, or null when valid. */
export function validateExecution(cfg: ExecutionConfig): string | null {
  if (cfg.model !== "bar" && cfg.model !== "quote") return 'execution.model must be "bar" or "quote"';
  if (cfg.feed !== "sip" && cfg.feed !== "iex") return 'execution.feed must be "sip" or "iex"';
  const nonNegative: (keyof ExecutionConfig)[] = ["latencyMs", "quoteLookbackMs", "maxQuoteWaitMs", "extraSlippageBps"];
  for (const key of nonNegative) {
    const value = cfg[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return `execution.${key} must be a number >= 0`;
  }
  if (cfg.quoteLookbackMs > 60_000) return "execution.quoteLookbackMs must be at most 60000";
  if (cfg.latencyMs + cfg.maxQuoteWaitMs > MAX_ARRIVAL_SPAN_MS) {
    return `execution.latencyMs + execution.maxQuoteWaitMs must be at most ${MAX_ARRIVAL_SPAN_MS}`;
  }
  if (cfg.extraSlippageBps > 1_000) return "execution.extraSlippageBps must be at most 1000";
  return null;
}

/** The order fields the model reads. */
export interface PricedOrder {
  side: OrderSide;
  orderType: OrderType;
  timeInForce: TimeInForce;
  limitPrice?: number;
}

/** Why an order fell back to the bar model. */
export type FallbackReason = "no_quote" | "quote_data_unavailable" | "unsupported_order_type";

export type ArrivalDecision =
  | { kind: "fill"; price: number; ts: number; arrival: Quote; decision: Quote | null }
  | { kind: "expire"; ts: number; arrival: Quote; decision: Quote | null }
  | { kind: "rest"; liveAt: number; arrival: Quote; decision: Quote | null }
  | { kind: "fallback"; reason: FallbackReason };

/** The [start, end) window of quotes an order decided at `submittedAt` needs. */
export function arrivalWindow(submittedAt: number, cfg: ExecutionConfig): { startMs: number; endMs: number } {
  return {
    startMs: submittedAt - cfg.quoteLookbackMs,
    endMs: submittedAt + cfg.latencyMs + cfg.maxQuoteWaitMs + 1,
  };
}

/** A quote with both sides present and not crossed. */
export function isUsableQuote(q: Quote): boolean {
  return q.bidPrice > 0 && q.askPrice > 0 && q.askPrice >= q.bidPrice
    && Number.isFinite(q.bidPrice) && Number.isFinite(q.askPrice);
}

/** Last usable quote at or before `ts`, if it is no older than `maxAgeMs`. `quotes` in time order. */
export function prevailingQuote(quotes: readonly Quote[], ts: number, maxAgeMs: number): Quote | null {
  for (let i = quotes.length - 1; i >= 0; i--) {
    const q = quotes[i];
    if (q.ts > ts || !isUsableQuote(q)) continue;
    return ts - q.ts <= maxAgeMs ? q : null;
  }
  return null;
}

/**
 * Prices an order when it reaches the market.
 * @param order - Side, type, time in force and limit
 * @param submittedAt - When the strategy decided (simulated ms)
 * @param quotes - Quotes covering arrivalWindow(submittedAt), in time order
 */
export function decideArrival(
  order: PricedOrder,
  submittedAt: number,
  quotes: readonly Quote[],
  cfg: ExecutionConfig,
): ArrivalDecision {
  // Market orders and limits are priced here; stops (and a limit without a price) are not.
  const limit = order.orderType === "limit" ? order.limitPrice : undefined;
  const priced = order.orderType === "market" || (limit !== undefined && Number.isFinite(limit));
  if (!priced) return { kind: "fallback", reason: "unsupported_order_type" };

  const liveAt = submittedAt + cfg.latencyMs;
  const decision = prevailingQuote(quotes, submittedAt, cfg.quoteLookbackMs);
  const arrival = prevailingQuote(quotes, liveAt, cfg.quoteLookbackMs)
    ?? quotes.find((q) => q.ts > liveAt && q.ts <= liveAt + cfg.maxQuoteWaitMs && isUsableQuote(q))
    ?? null;
  if (!arrival) return { kind: "fallback", reason: "no_quote" };

  const ts = Math.max(liveAt, arrival.ts);
  const price = marketablePrice(order.side, arrival, limit, cfg.extraSlippageBps);
  if (price !== null) return { kind: "fill", price, ts, arrival, decision };
  if (order.timeInForce === "ioc" || order.timeInForce === "fok") {
    return { kind: "expire", ts, arrival, decision };
  }
  return { kind: "rest", liveAt, arrival, decision };
}

/**
 * The fill price at the touch — buys at the ask, sells at the bid, plus any
 * extra slippage but never worse than a limit — or null when a limit is not
 * marketable against this quote.
 */
function marketablePrice(side: OrderSide, quote: Quote, limit: number | undefined, extraSlippageBps: number): number | null {
  const isBuy = side === "buy";
  const touch = isBuy ? quote.askPrice : quote.bidPrice;
  if (limit !== undefined && (isBuy ? touch > limit : touch < limit)) return null;
  const slip = extraSlippageBps / 10_000;
  const price = isBuy ? touch * (1 + slip) : touch * (1 - slip);
  if (limit === undefined) return price;
  return isBuy ? Math.min(price, limit) : Math.max(price, limit);
}

/**
 * Size a resting limit gets from trades printing strictly through its price,
 * at or after `fromMs`, and the time of the first such print.
 * @param trades - Trades in time order (already limited to the regular session)
 * @returns null when nothing printed through the limit
 */
export function restingLimitFill(
  side: OrderSide,
  limitPrice: number,
  remainingQty: number,
  fromMs: number,
  trades: readonly Trade[],
): { ts: number; qty: number } | null {
  let ts: number | null = null;
  let printed = 0;
  for (const t of trades) {
    if (t.ts < fromMs) continue;
    const through = side === "buy" ? t.price < limitPrice : t.price > limitPrice;
    if (!through) continue;
    ts ??= t.ts;
    printed += t.size;
    if (printed >= remainingQty) break;
  }
  return ts === null ? null : { ts, qty: Math.min(printed, remainingQty) };
}
