/**
 * bench/strategies.ts
 *
 * Strategies used only by the benchmark, plus a factory that also builds the
 * platform's registered strategies for load tests.
 *
 *   null            — reads the triggering symbol's state and returns null.
 *                     Measures dispatch and evaluation overhead alone.
 *   quote_imbalance — a fixed, versioned, quote-reactive rule (below). It is a
 *                     workload and a delay-sensitivity subject, NOT a claimed
 *                     edge; its results may well be negative after costs.
 *   minute_reversal, pairs_trading — the platform's own implementations.
 *
 * Bench strategy types are cast into StrategyType deliberately: they never
 * reach the database or the API, and getStrategyPriority gives them the
 * default priority.
 *
 * Inputs:  BenchStrategySpec.
 * Outputs: IStrategy instances.
 */

import { BaseStrategy, type EvaluationContext } from "../strategies/base/strategy";
import { STRATEGY_FACTORY } from "../config/strategyDefaults";
import { DEFAULT_PAIRS_CONFIG } from "../strategies/pairs/pairsConfig";
import { nowMs } from "../utils/time";
import { newId } from "../utils/ids";
import type { IStrategy } from "../strategies/base/strategy";
import type { BaseStrategyConfig, SignalDirection, StrategySignal, StrategyType } from "../types/strategy";
import type { Quote } from "../types/market";

export type BenchStrategyName = "none" | "null" | "quote_imbalance" | "minute_reversal" | "pairs_trading";

export const BENCH_STRATEGY_NAMES: BenchStrategyName[] = ["none", "null", "quote_imbalance", "minute_reversal", "pairs_trading"];

export interface BenchStrategySpec {
  name: BenchStrategyName;
  /** Independent instances to register (scales evaluation work). */
  count: number;
  symbols: string[];
  /** Strategy-specific overrides. */
  params?: Record<string, unknown>;
}

function baseConfig(type: string, symbols: string[], name: string): BaseStrategyConfig {
  return {
    id: newId(),
    name,
    type: type as StrategyType,
    symbols: [...symbols],
    rollingWindowMs: 60_000,
    maxPositionSizeUsd: 10_000,
    cooldownMs: 0,
    enabled: true,
  };
}

/** Evaluates and returns nothing. */
export class NullStrategy extends BaseStrategy {
  readonly type = "bench_null" as StrategyType;
  static readonly VERSION = 1;
  readonly version = NullStrategy.VERSION;
  touched = 0;

  evaluate(context: EvaluationContext): StrategySignal | null {
    if (!this.isActive) return null;
    if (context.symbolState.get(context.symbol)?.latestQuote) this.touched++;
    return null;
  }
}

export interface QuoteImbalanceParams {
  /** |imbalance| at or above which the strategy acts. Imbalance = (bs−as)/(bs+as). */
  imbalanceThreshold: number;
  /** Shares per order. */
  qty: number;
  /** Largest absolute position, in shares. */
  maxPositionQty: number;
  /** Close an open position after this long, ms. */
  maxHoldMs: number;
}

export const DEFAULT_QUOTE_IMBALANCE_PARAMS: QuoteImbalanceParams = {
  imbalanceThreshold: 0.6,
  qty: 1,
  maxPositionQty: 1,
  maxHoldMs: 30_000,
};

/**
 * Quote-imbalance rule, version 1. On each NEW usable quote of a symbol:
 *   - holding longer than maxHoldMs → close the position;
 *   - imbalance ≥ +threshold and position < max → buy (close a short first);
 *   - imbalance ≤ −threshold and position > −max → sell (close a long first).
 * Unusable quotes (non-positive or crossed sides) are ignored. One decision per
 * quote: trades and bars re-evaluate but act only on a quote not yet seen.
 */
export class QuoteImbalanceStrategy extends BaseStrategy {
  readonly type = "bench_quote_imbalance" as StrategyType;
  static readonly VERSION = 1;
  readonly version = QuoteImbalanceStrategy.VERSION;
  readonly params: QuoteImbalanceParams;
  private readonly lastQuote = new Map<string, Quote>();
  private readonly openedAt = new Map<string, number>();

  constructor(config: BaseStrategyConfig, params: Partial<QuoteImbalanceParams> = {}) {
    super(config);
    this.params = { ...DEFAULT_QUOTE_IMBALANCE_PARAMS, ...params };
  }

  evaluate(context: EvaluationContext): StrategySignal | null {
    if (!this.isActive) return null;
    const { symbol } = context;
    const q = context.symbolState.get(symbol)?.latestQuote;
    if (!q || this.lastQuote.get(symbol) === q) return null;
    this.lastQuote.set(symbol, q);
    if (!(q.bidPrice > 0) || !(q.askPrice > 0) || q.bidPrice > q.askPrice) return null;

    const position = context.portfolioState.getPosition(symbol)?.qty ?? 0;
    const now = nowMs();
    if (position === 0) this.openedAt.delete(symbol);
    else if (!this.openedAt.has(symbol)) this.openedAt.set(symbol, now);

    const { imbalanceThreshold, qty, maxPositionQty, maxHoldMs } = this.params;
    const opened = this.openedAt.get(symbol);
    let direction: SignalDirection | null = null;
    let label = "";
    let orderQty = qty;
    if (position !== 0 && opened !== undefined && now - opened >= maxHoldMs) {
      direction = position > 0 ? "close_long" : "close_short";
      orderQty = Math.abs(position);
      label = "max_hold_exit";
    } else if (q.imbalance >= imbalanceThreshold && position < maxPositionQty) {
      direction = position < 0 ? "close_short" : "long";
      orderQty = position < 0 ? Math.abs(position) : qty;
      label = "bid_heavy";
    } else if (q.imbalance <= -imbalanceThreshold && position > -maxPositionQty) {
      direction = position > 0 ? "close_long" : "short";
      orderQty = position > 0 ? position : qty;
      label = "ask_heavy";
    }
    if (!direction) return null;
    return this.buildSignal({
      symbol,
      direction,
      qty: orderQty,
      triggerValue: q.imbalance,
      triggerLabel: label,
      meta: { bid: q.bidPrice, ask: q.askPrice, quoteTs: q.isoTs },
    });
  }
}

/** Builds `spec.count` independent instances of the named strategy. */
export function buildBenchStrategies(spec: BenchStrategySpec): IStrategy[] {
  const out: IStrategy[] = [];
  for (let i = 0; i < spec.count; i++) {
    switch (spec.name) {
      case "none":
        return [];
      case "null":
        out.push(new NullStrategy(baseConfig("bench_null", spec.symbols, `bench null ${i}`)));
        break;
      case "quote_imbalance":
        out.push(new QuoteImbalanceStrategy(
          baseConfig("bench_quote_imbalance", spec.symbols, `bench quote imbalance ${i}`),
          spec.params as Partial<QuoteImbalanceParams>,
        ));
        break;
      case "minute_reversal":
        out.push(STRATEGY_FACTORY.minute_reversal({ symbols: spec.symbols, ...(spec.params ?? {}) }));
        break;
      case "pairs_trading": {
        if (spec.symbols.length < 2) throw new Error("pairs_trading needs two symbols");
        const [leg1Symbol, leg2Symbol] = spec.symbols;
        out.push(STRATEGY_FACTORY.pairs_trading({
          ...DEFAULT_PAIRS_CONFIG,
          id: newId(),
          name: `bench pairs ${i}`,
          type: "pairs_trading",
          symbols: [leg1Symbol, leg2Symbol],
          leg1Symbol,
          leg2Symbol,
          enabled: true,
          ...(spec.params ?? {}),
        }));
        break;
      }
      default:
        throw new Error(`Unknown bench strategy "${String(spec.name)}" (expected ${BENCH_STRATEGY_NAMES.join(", ")})`);
    }
  }
  return out;
}

/** Versions of the strategies a spec builds, for the manifest. */
export function benchStrategyVersion(name: BenchStrategyName): number | null {
  switch (name) {
    case "null": return NullStrategy.VERSION;
    case "quote_imbalance": return QuoteImbalanceStrategy.VERSION;
    default: {
      const s = name === "none" ? null : buildBenchStrategies({ name, count: 1, symbols: ["AAA", "BBB"] })[0];
      return s?.version ?? null;
    }
  }
}
