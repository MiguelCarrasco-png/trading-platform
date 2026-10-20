/**
 * core/live/strategyDiagnostics.ts
 *
 * Tells the person who launched a strategy when it is running but not doing
 * what they expect. A strategy that throws is already handled (logged, counted,
 * auto-disabled); these are the silent cases:
 *
 *   - An order was blocked (risk check, no capital) or rejected by the broker.
 *     These were only saved to the database; nothing reached the terminal.
 *   - A symbol never produces data (typo, not on the feed) or stops producing it.
 *     The orchestrator skips such a strategy without a word.
 *
 * Everything is observe-only: it subscribes to the event bus and polls the
 * registry on a slow timer, so it adds nothing to the per-event trading path.
 * Log lines are rate-limited, and the notable ones are also written as run
 * events so they appear in the run page's timeline.
 */

import { logger } from "../../utils/logger";
import type { EventBus } from "../engine/eventBus";
import type { MarketHours } from "../market/marketHours";
import type { SymbolStateManager } from "../state/symbolState";
import type { IStrategy } from "../../strategies/base/strategy";
import type {
  CapitalUnavailableEvent,
  OrderExpiredEvent,
  OrderRejectedEvent,
  RiskRejectedEvent,
} from "../../types/events";
import type { MarketEventKind } from "../../types/market";

export interface RegisteredStrategy {
  /** Registry key: the strategy_runs id for a launched run. */
  key: string;
  /** Set when the key is a strategy_runs id, so run events can be recorded. */
  runId?: string;
  strategy: IStrategy;
}

export interface KnownOrder {
  strategyId: string;
  runId?: string;
  symbol: string;
  side: string;
  qty: number;
}

export interface StrategyDiagnosticsDeps {
  eventBus: EventBus;
  symbolState: SymbolStateManager;
  /** The strategies currently registered with the orchestrator. */
  strategies: () => Iterable<RegisteredStrategy>;
  /** The same session hours the risk engine uses; the data watchdog is silent while closed. */
  marketHours: MarketHours;
  /** Appends to the run's event timeline. */
  recordRunEvent: (runId: string, type: string, detail: string) => void;
  lookupOrder?: (orderId: string) => KnownOrder | null | undefined;
  now?: () => number;
}

export interface StrategyDiagnosticsOptions {
  /** How often the data watchdog runs. */
  tickMs: number;
  /** No (new) data for this long, while the market is open, is reported. */
  noDataMs: number;
  /** A repeated block is logged once per window, with a count of the rest. */
  logWindowMs: number;
}

const DEFAULTS: StrategyDiagnosticsOptions = { tickMs: 30_000, noDataMs: 300_000, logWindowMs: 60_000 };

/** Bounds the "already told the timeline" set; clearing it only re-announces. */
const MAX_REMEMBERED = 5_000;

interface Throttled {
  windowStart: number;
  suppressed: number;
  /** Describes the suppressed events when the summary is written. */
  label: string;
}

interface Watch {
  lastTotal: number;
  changedAt: number;
  state: "ok" | "no_data" | "stale";
}

export class StrategyDiagnostics {
  private readonly options: StrategyDiagnosticsOptions;
  private readonly now: () => number;
  private readonly throttles = new Map<string, Throttled>();
  private readonly announced = new Set<string>();
  private readonly watches = new Map<string, Watch>();
  private timer: NodeJS.Timeout | null = null;

  private readonly onRiskRejected = (e: RiskRejectedEvent): void => this.blocked(e);
  private readonly onCapital = (e: CapitalUnavailableEvent): void => this.noCapital(e);
  private readonly onOrderRejected = (e: OrderRejectedEvent): void => this.orderRejected(e);
  private readonly onOrderExpired = (e: OrderExpiredEvent): void => this.orderExpired(e);

  constructor(private readonly deps: StrategyDiagnosticsDeps, options: Partial<StrategyDiagnosticsOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    const { eventBus } = this.deps;
    eventBus.on<RiskRejectedEvent>("RISK_REJECTED", this.onRiskRejected);
    eventBus.on<CapitalUnavailableEvent>("CAPITAL_UNAVAILABLE", this.onCapital);
    eventBus.on<OrderRejectedEvent>("ORDER_REJECTED", this.onOrderRejected);
    eventBus.on<OrderExpiredEvent>("ORDER_EXPIRED", this.onOrderExpired);
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.options.tickMs);
      this.timer.unref();
    }
  }

  stop(): void {
    const { eventBus } = this.deps;
    eventBus.off<RiskRejectedEvent>("RISK_REJECTED", this.onRiskRejected);
    eventBus.off<CapitalUnavailableEvent>("CAPITAL_UNAVAILABLE", this.onCapital);
    eventBus.off<OrderRejectedEvent>("ORDER_REJECTED", this.onOrderRejected);
    eventBus.off<OrderExpiredEvent>("ORDER_EXPIRED", this.onOrderExpired);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------
  // Blocked and rejected orders
  // ------------------------------------------------------------------

  private blocked(e: RiskRejectedEvent): void {
    const intent = e.rejectedIntent;
    const check = e.failedCheck ?? "UNKNOWN";
    const who = this.describe(e.strategyId);
    const what = intent ? `${intent.side} ${intent.qty} ${intent.symbol}` : "an order";
    this.say(
      `block:${e.strategyId}:${check}`, "warn",
      `${who}: ${what} was blocked by risk check ${check}: ${e.reason}. It was NOT sent to the broker.`,
      `${who}: more orders blocked by ${check}`,
    );
    this.announce(intent?.runId, "BLOCKED", check, `${check}: ${e.reason}${intent ? ` (${what})` : ""}`);
  }

  private noCapital(e: CapitalUnavailableEvent): void {
    const who = this.describe(e.strategyId);
    this.say(
      `capital:${e.strategyId}`, "warn",
      `${who}: not enough unreserved capital to place an order (needs $${e.required.toFixed(2)}, ` +
        `$${e.available.toFixed(2)} available). Lower the order size or the allocation of other runs.`,
      `${who}: more orders refused for lack of capital`,
    );
    this.announce(e.runId, "BLOCKED", "CAPITAL_UNAVAILABLE", `Needed $${e.required.toFixed(2)}; $${e.available.toFixed(2)} available`);
  }

  private orderRejected(e: OrderRejectedEvent): void {
    const order = this.deps.lookupOrder?.(e.orderId);
    const who = order ? this.describe(order.strategyId) : "A strategy";
    const what = order ? `${order.side} ${order.qty} ${order.symbol}` : `order ${e.orderId}`;
    this.say(
      `rejected:${order?.strategyId ?? "?"}:${e.reason}`, "warn",
      `${who}: the broker rejected ${what}: ${e.reason}`,
      `${who}: more orders rejected by the broker`,
    );
    this.announce(order?.runId, "BLOCKED", `REJECTED:${e.reason}`, `Broker rejected ${what}: ${e.reason}`);
  }

  private orderExpired(e: OrderExpiredEvent): void {
    const order = this.deps.lookupOrder?.(e.orderId);
    if (!order) return;
    const who = this.describe(order.strategyId);
    this.say(
      `expired:${order.strategyId}`, "info",
      `${who}: ${order.side} ${order.qty} ${order.symbol} expired without filling.`,
      `${who}: more orders expired unfilled`,
    );
  }

  /** Logs at once for the first event of a kind in a window; later ones are counted. */
  private say(key: string, level: "info" | "warn", message: string, summaryLabel: string): void {
    const now = this.now();
    const entry = this.throttles.get(key);
    if (entry && now - entry.windowStart < this.options.logWindowMs) {
      entry.suppressed++;
      return;
    }
    if (entry && entry.suppressed > 0) this.flushOne(key, entry, now);
    this.throttles.set(key, { windowStart: now, suppressed: 0, label: summaryLabel });
    logger[level](message);
  }

  private flushOne(key: string, entry: Throttled, now: number): void {
    const seconds = Math.round((now - entry.windowStart) / 1000);
    logger.warn(`${entry.label}: ${entry.suppressed} more in the last ${seconds}s (repeats are summarised, not logged one by one).`);
    this.throttles.delete(key);
  }

  /** Writes the run-timeline event the first time a run hits a given problem. */
  private announce(runId: string | undefined, type: string, kind: string, detail: string): void {
    if (!runId) return;
    const key = `${runId}|${type}|${kind}`;
    if (this.announced.has(key)) return;
    if (this.announced.size >= MAX_REMEMBERED) this.announced.clear();
    this.announced.add(key);
    this.deps.recordRunEvent(runId, type, detail);
  }

  private describe(strategyId: string): string {
    for (const { strategy } of this.deps.strategies()) {
      if (strategy.id === strategyId) return `Strategy "${strategy.config.name}"`;
    }
    return `Strategy ${strategyId}`;
  }

  // ------------------------------------------------------------------
  // Data watchdog
  // ------------------------------------------------------------------

  /** One pass: flush finished log windows, then check each strategy symbol is getting data. */
  tick(): void {
    const now = this.now();
    for (const [key, entry] of this.throttles) {
      if (now - entry.windowStart >= this.options.logWindowMs && entry.suppressed > 0) this.flushOne(key, entry, now);
      else if (now - entry.windowStart >= this.options.logWindowMs) this.throttles.delete(key);
    }

    const open = this.deps.marketHours.isOpen(now);
    const live = new Set<string>();
    for (const { key, runId, strategy } of this.deps.strategies()) {
      for (const symbol of strategy.config.symbols) {
        const watchKey = `${key}|${symbol}`;
        live.add(watchKey);
        const total = this.eventTotal(symbol, strategy.triggers);
        const watch = this.watches.get(watchKey) ?? { lastTotal: total, changedAt: now, state: "ok" as const };
        this.watches.set(watchKey, watch);

        // While the market is closed silence is expected; the clock restarts at the open.
        if (!open) {
          watch.changedAt = now;
          continue;
        }
        if (total !== watch.lastTotal) {
          watch.lastTotal = total;
          watch.changedAt = now;
          if (watch.state !== "ok") this.resumed(strategy, symbol, runId);
          watch.state = "ok";
        } else if (watch.state === "ok" && now - watch.changedAt >= this.options.noDataMs) {
          watch.state = total === 0 ? "no_data" : "stale";
          this.starved(strategy, symbol, runId, total === 0, now - watch.changedAt);
        }
      }
    }
    for (const watchKey of this.watches.keys()) if (!live.has(watchKey)) this.watches.delete(watchKey);
  }

  /** Events the strategy actually decides on, so a quiet quote stream cannot hide missing bars. */
  private eventTotal(symbol: string, triggers: readonly MarketEventKind[] | undefined): number {
    const state = this.deps.symbolState.get(symbol);
    if (!state) return 0;
    const kinds = triggers ?? (["bar", "quote", "trade"] as const);
    let total = 0;
    if (kinds.includes("bar")) total += state.barCount;
    if (kinds.includes("quote")) total += state.quoteCount;
    if (kinds.includes("trade")) total += state.tradeCount;
    return total;
  }

  private starved(strategy: IStrategy, symbol: string, runId: string | undefined, never: boolean, silentMs: number): void {
    const kinds = (strategy.triggers ?? ["bar", "quote", "trade"]).join("/");
    const minutes = Math.max(1, Math.round(silentMs / 60_000));
    const detail = never
      ? `No ${kinds} data for ${symbol} since the run started (${minutes} min). Check the symbol is spelled correctly ` +
        `and available on your data feed, and that the feed is connected.`
      : `No new ${kinds} data for ${symbol} for ${minutes} min while the market is open. The feed may be disconnected, ` +
        `a replay may have finished, or the symbol may just be quiet.`;
    logger.warn(`Strategy "${strategy.config.name}": ${detail}`);
    if (runId) this.deps.recordRunEvent(runId, "NO_DATA", detail);
  }

  private resumed(strategy: IStrategy, symbol: string, runId: string | undefined): void {
    const detail = `Data for ${symbol} is flowing again.`;
    logger.info(`Strategy "${strategy.config.name}": ${detail}`);
    if (runId) this.deps.recordRunEvent(runId, "DATA_RESUMED", detail);
  }
}
