/**
 * core/execution/liveQuoteFills.ts
 *
 * The quote model on live market data, for a sim runtime that streams quotes
 * and trades. The pricing rules are the backtest's (quoteFillModel.ts),
 * applied as the data arrives:
 *   - an order trades against the live quote prevailing when it reaches the
 *     market, latencyMs after the decision, or the first quote within the
 *     wait after that; with neither, the bar model prices it
 *   - a resting limit fills on live trades printing through its price
 *   - a stop triggers on a live trade at or through it, and is priced from
 *     the quote prevailing at the trigger
 *   - a DAY order expires at the regular-session close
 *
 * Ticks reach this process a little after their timestamps, so an arrival is
 * priced only once `settleMs` has passed since the moment it depends on.
 *
 * Inputs:  QUOTE_RECEIVED and TRADE_RECEIVED events; a SimulatedExecutionSink
 *          built with the same quote-model ExecutionConfig.
 * Outputs: Fills and expiries, published by the sink.
 */

import { logger } from "../../utils/logger";
import { nowMs } from "../../utils/time";
import type { EventBus } from "../engine/eventBus";
import type { HistoricalTickSource } from "../backtest/tickSource";
import type { SimulatedExecutionSink } from "./simulatedExecution";
import { DEFAULT_EXECUTION, resolveExecution, validateExecution, type ExecutionConfig } from "./quoteFillModel";
import type { HistoricalFeed, Quote, Trade } from "../../types/market";
import type { QuoteReceivedEvent, TradeReceivedEvent } from "../../types/events";

/** How long a tick may take to reach this process after its timestamp. */
const DEFAULT_SETTLE_MS = 250;
/** How often waiting arrivals and session closes are checked. */
const DEFAULT_INTERVAL_MS = 100;
/** Ticks kept beyond the span an order's pricing reads, in case the event loop falls behind. */
const BUFFER_SLACK_MS = 20_000;

/**
 * The recent quotes and trades of each symbol, read like historical ticks.
 * Ticks normally arrive in time order; one that does not is put in its place.
 */
export class LiveTickBuffer implements HistoricalTickSource {
  private readonly quoteLists = new Map<string, Quote[]>();
  private readonly tradeLists = new Map<string, Trade[]>();

  /**
   * @param feed - Feed the live stream carries
   * @param horizonMs - How far back from now ticks must stay readable
   * @param now - Clock the horizon is measured from
   */
  constructor(
    readonly feed: HistoricalFeed,
    private readonly horizonMs: number,
    private readonly now: () => number = nowMs,
  ) {}

  addQuote(quote: Quote): void {
    this._insert(this.quoteLists, quote);
  }

  addTrade(trade: Trade): void {
    this._insert(this.tradeLists, trade);
  }

  async quotes(symbol: string, startMs: number, endMs: number): Promise<Quote[]> {
    return between(this.quoteLists.get(symbol), startMs, endMs);
  }

  async trades(symbol: string, startMs: number, endMs: number): Promise<Trade[]> {
    return between(this.tradeLists.get(symbol), startMs, endMs);
  }

  private _insert<T extends Quote | Trade>(lists: Map<string, T[]>, tick: T): void {
    let list = lists.get(tick.symbol);
    if (!list) {
      list = [];
      lists.set(tick.symbol, list);
    }
    let i = list.length;
    while (i > 0 && list[i - 1].ts > tick.ts) i--;
    list.splice(i, 0, tick);
    // Trimmed in bulk once the oldest tick is a whole horizon past due, so the
    // cost per tick stays constant on average.
    const keepFrom = this.now() - this.horizonMs;
    if (list[0].ts < keepFrom - this.horizonMs) list.splice(0, firstAtOrAfter(list, keepFrom));
  }
}

/** Index of the first tick at or after `ms` in a list in time order. */
function firstAtOrAfter(list: readonly { ts: number }[], ms: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].ts < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function between<T extends { ts: number }>(list: T[] | undefined, startMs: number, endMs: number): T[] {
  return list ? list.slice(firstAtOrAfter(list, startMs), firstAtOrAfter(list, endMs)) : [];
}

/**
 * How a sim runtime prices orders. Streaming live data, it uses the quote
 * model on the stream's quotes and trades unless asked for the bar model; a
 * replay has bars only.
 */
export function simExecution(options: {
  streaming: boolean;
  model: "quote" | "bar";
  latencyMs: number;
  /** The live stream's URL, which decides whose book the quotes are from. */
  streamUrl: string;
}): ExecutionConfig {
  if (!options.streaming || options.model === "bar") return DEFAULT_EXECUTION;
  const execution = resolveExecution({
    model: "quote",
    latencyMs: options.latencyMs,
    feed: /\/sip$/.test(options.streamUrl) ? "sip" : "iex",
  });
  const error = validateExecution(execution);
  if (error) throw new Error(`Sim execution: ${error}`);
  return execution;
}

export interface LiveQuoteFillsOptions {
  /** How long a tick may take to arrive after its timestamp (ms). */
  settleMs?: number;
  /** How often waiting arrivals and session closes are checked (ms). */
  intervalMs?: number;
  now?: () => number;
}

export class LiveQuoteFills {
  private readonly ticks: LiveTickBuffer;
  private readonly settleMs: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private settling: Promise<void> | null = null;
  private again = false;

  /**
   * Subscribes at once: build it before the Orchestrator, so the fills a
   * trade causes are published before strategies see that trade.
   */
  constructor(
    eventBus: EventBus,
    private readonly sink: SimulatedExecutionSink,
    execution: ExecutionConfig,
    options: LiveQuoteFillsOptions = {},
  ) {
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? nowMs;
    const readSpanMs = execution.quoteLookbackMs + execution.latencyMs + execution.maxQuoteWaitMs + this.settleMs;
    this.ticks = new LiveTickBuffer(execution.feed, readSpanMs + BUFFER_SLACK_MS, this.now);
    eventBus.on<QuoteReceivedEvent>("QUOTE_RECEIVED", (e) => this.ticks.addQuote(e.payload));
    eventBus.on<TradeReceivedEvent>("TRADE_RECEIVED", (e) => this._onTrade(e.payload));
  }

  /** Starts checking waiting arrivals and session closes on a timer. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.settle().catch((err) => logger.error("LiveQuoteFills: settling orders failed", { err: String(err) }));
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.info("LiveQuoteFills: stopped", { report: this.sink.executionReport() });
  }

  /**
   * Expires the orders whose session has closed and prices the arrivals that
   * have settled. One pass runs at a time; a call during a pass gets another
   * pass after it.
   */
  settle(): Promise<void> {
    if (this.settling) {
      this.again = true;
      return this.settling;
    }
    this.settling = this._settleUntilCaughtUp().finally(() => {
      this.settling = null;
    });
    return this.settling;
  }

  private async _settleUntilCaughtUp(): Promise<void> {
    do {
      this.again = false;
      const now = this.now();
      for (const plan of this.sink.planExpiries(now)) this.sink.applyExpiry(plan);
      if (this.sink.hasArrivals()) {
        for (const plan of await this.sink.planArrivals(this.ticks, now - this.settleMs)) this.sink.applyArrival(plan);
      }
    } while (this.again);
  }

  private _onTrade(trade: Trade): void {
    this.ticks.addTrade(trade);
    for (const plan of this.sink.planRestingTrade(trade)) this.sink.applyResting(plan);
  }
}
