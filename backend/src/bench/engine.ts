/**
 * bench/engine.ts
 *
 * Assembles the production processing path for a benchmark, with order
 * submission replaced by a sink that cannot reach a broker:
 *
 *   frame → AlpacaMarketDataAdapter (parse, normalize, validate)
 *         → EventBus → Orchestrator (state, evaluate, risk, reservation)
 *         → JournaledExecutionSink(journal → Null | Simulated sink)
 *
 * Every component except the journal and sink is the real class the trading
 * runtime uses. The engine never calls connect(): frames enter through
 * adapter.ingestFrame(), the same code the socket callback runs.
 *
 * DecisionLog records the synchronous decision stream (signals, intents, risk
 * outcomes) without ids or wall times, so two runs over the same input can be
 * compared by checksum. Fills are hashed separately as a sorted multiset
 * because their timing depends on the asynchronous journal.
 *
 * Inputs:  BenchEngineOptions.
 * Outputs: BenchEngine handle (ingest, stop, decision log, components).
 */

import { createHash } from "crypto";
import { EventBus } from "../core/engine/eventBus";
import { Orchestrator } from "../core/engine/orchestrator";
import { SymbolStateManager } from "../core/state/symbolState";
import { PortfolioStateManager } from "../core/state/portfolioState";
import { OrderStateManager } from "../core/state/orderState";
import { RiskEngine } from "../core/risk/riskEngine";
import { ExecutionEngine } from "../core/execution/executionEngine";
import { JournaledExecutionSink } from "../core/execution/journaledExecution";
import { SimulatedExecutionSink } from "../core/execution/simulatedExecution";
import { AlpacaMarketDataAdapter } from "../adapters/alpaca/marketData";
import { TimedExecutionSink, TimedOrderJournal, attachOrderLifecycle } from "../core/telemetry/orderPathTiming";
import { NullExecutionSink, InMemoryOrderJournal, type InMemoryJournalOptions } from "./sinks";
import { buildBenchStrategies, type BenchStrategySpec } from "./strategies";
import { newId } from "../utils/ids";
import { nowMs } from "../utils/time";
import type { LatencyProbe, MarketDataObserver } from "../core/telemetry/latencyProbe";
import type { FrameRecord } from "../core/telemetry/frameRecorder";
import type { IExecutionSink } from "../core/execution/IExecutionSink";
import type { RiskConfig } from "../types/risk";
import type { ExecutionMode } from "../types/common";
import type { IStrategy } from "../strategies/base/strategy";
import type {
  CapitalUnavailableEvent,
  OrderFilledEvent,
  OrderIntentCreatedEvent,
  OrderPartialFillEvent,
  RiskRejectedEvent,
  StrategySignalCreatedEvent,
} from "../types/events";

export type BenchSinkKind = "null" | "sim";

export interface BenchEngineOptions {
  strategy: BenchStrategySpec;
  sink: BenchSinkKind;
  journal?: InMemoryJournalOptions;
  invalidData?: "pass" | "quarantine";
  /** Omit for the uninstrumented ("disabled") configuration. */
  probe?: LatencyProbe;
  observers?: MarketDataObserver[];
  initialCapital?: number;
  risk?: Partial<RiskConfig>;
  /** Event mode label. "replay" for recorded/synthetic input, "paper" for live shadow. */
  mode?: ExecutionMode;
  /** Market-data stream URL, for live shadow capture (replay never connects). */
  adapterUrl?: string;
}

/** Canonical, id-free record of what the engine decided. */
export class DecisionLog {
  readonly lines: string[] = [];
  private readonly fills: string[] = [];
  signals = 0;
  intents = 0;
  riskRejections = new Map<string, number>();
  capitalUnavailable = 0;

  attach(bus: EventBus): void {
    bus.on<StrategySignalCreatedEvent>("STRATEGY_SIGNAL_CREATED", (e) => {
      this.signals++;
      const p = e.payload;
      this.lines.push(`S|${p.strategyType}|${p.symbol}|${p.direction}|${p.qty}|${p.triggerLabel ?? ""}`);
    });
    bus.on<OrderIntentCreatedEvent>("ORDER_INTENT_CREATED", (e) => {
      this.intents++;
      const p = e.payload;
      this.lines.push(`I|${p.symbol}|${p.side}|${p.qty}|${p.orderType}|${p.timeInForce}`);
    });
    bus.on<RiskRejectedEvent>("RISK_REJECTED", (e) => {
      const check = e.failedCheck ?? "UNKNOWN";
      this.riskRejections.set(check, (this.riskRejections.get(check) ?? 0) + 1);
      this.lines.push(`R|${e.rejectedIntent?.symbol ?? ""}|${check}`);
    });
    bus.on<CapitalUnavailableEvent>("CAPITAL_UNAVAILABLE", () => {
      this.capitalUnavailable++;
      this.lines.push("C");
    });
    const onFill = (e: OrderFilledEvent | OrderPartialFillEvent): void => {
      this.fills.push(`F|${e.fill.symbol}|${e.fill.side}|${e.fill.qty}|${e.fill.price.toFixed(6)}`);
    };
    bus.on<OrderFilledEvent>("ORDER_FILLED", onFill);
    bus.on<OrderPartialFillEvent>("ORDER_PARTIAL_FILL", onFill);
  }

  decisionChecksum(): string {
    return createHash("sha256").update(this.lines.join("\n")).digest("hex");
  }

  fillChecksum(): string {
    return createHash("sha256").update([...this.fills].sort().join("\n")).digest("hex");
  }

  get fillCount(): number {
    return this.fills.length;
  }

  summary(): Record<string, unknown> {
    return {
      signals: this.signals,
      intents: this.intents,
      risk_rejections: Object.fromEntries(this.riskRejections),
      capital_unavailable: this.capitalUnavailable,
      fills: this.fills.length,
      decision_checksum: this.decisionChecksum(),
      fill_checksum: this.fillChecksum(),
    };
  }
}

export interface BenchEngine {
  bus: EventBus;
  adapter: AlpacaMarketDataAdapter;
  orchestrator: Orchestrator;
  journal: InMemoryOrderJournal;
  nullSink: NullExecutionSink | null;
  simSink: SimulatedExecutionSink | null;
  strategies: IStrategy[];
  decisions: DecisionLog;
  /** Feeds one recorded frame through the adapter's socket-callback path. */
  ingest(frame: FrameRecord): void;
  stop(): void;
}

export function buildBenchEngine(opts: BenchEngineOptions): BenchEngine {
  const mode = opts.mode ?? "replay";
  const bus = new EventBus();
  const decisions = new DecisionLog();
  decisions.attach(bus);

  const symbolState = new SymbolStateManager();
  const portfolioState = new PortfolioStateManager(opts.initialCapital ?? 100_000);
  const orderState = new OrderStateManager();
  // Market-hours gating is left unset (as in replay analysis): the input decides the session.
  const riskEngine = new RiskEngine(opts.risk ?? {});

  // The simulated sink subscribes to bars in its constructor, ahead of the
  // orchestrator, so a queued order fills before strategies see the new bar.
  // For quotes it is flushed at the next quote for the symbol, i.e. at the
  // last price observable when the order "arrived".
  let simSink: SimulatedExecutionSink | null = null;
  let nullSink: NullExecutionSink | null = null;
  let brokerSink: IExecutionSink;
  if (opts.sink === "sim") {
    simSink = new SimulatedExecutionSink(bus, symbolState, mode, 5, 0.005, {});
    const sim = simSink;
    bus.on("QUOTE_RECEIVED", (e) => { sim.flushPending((e as { payload: { symbol: string } }).payload.symbol); });
    brokerSink = sim;
  } else {
    nullSink = new NullExecutionSink(bus, mode);
    brokerSink = nullSink;
  }

  const probe = opts.probe;
  const journal = new InMemoryOrderJournal(opts.journal ?? {});
  const sink = new JournaledExecutionSink(
    probe ? new TimedExecutionSink(brokerSink, probe) : brokerSink,
    probe ? new TimedOrderJournal(journal, probe) : journal,
    (intent, err) => bus.publish({
      id: newId(), type: "RISK_REJECTED", ts: nowMs(), mode,
      strategyId: intent.strategyId, reason: err.message,
      failedCheck: "JOURNAL_UNAVAILABLE", rejectedIntent: intent,
    }),
  );

  const orchestrator = new Orchestrator(
    bus, symbolState, portfolioState, orderState, riskEngine, new ExecutionEngine(sink), mode,
    { maxConsecutiveErrors: 5, ...(probe ? { probe } : {}) },
  );
  const strategies = buildBenchStrategies(opts.strategy);
  for (const s of strategies) orchestrator.registerStrategy(s);
  orchestrator.start();
  const detachLifecycle = probe ? attachOrderLifecycle(bus, probe) : null;

  const adapter = new AlpacaMarketDataAdapter(bus, mode, {
    url: opts.adapterUrl,
    probe,
    observers: opts.observers,
    invalidData: opts.invalidData ?? "pass",
  });

  return {
    bus, adapter, orchestrator, journal, nullSink, simSink, strategies, decisions,
    ingest(frame: FrameRecord): void {
      adapter.ingestFrame(frame.data, frame.epoch, frame.seq, frame.rx_wall_ms);
    },
    stop(): void {
      detachLifecycle?.();
      orchestrator.stop();
      adapter.disconnect();
    },
  };
}
