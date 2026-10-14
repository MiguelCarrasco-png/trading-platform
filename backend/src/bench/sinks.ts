/**
 * bench/sinks.ts
 *
 * Order-path stand-ins for benchmark runs that must not reach a broker.
 *
 *   NullExecutionSink — accepts an order and immediately expires it unfilled
 *     (an IOC that found nothing). It holds no broker client, so it CANNOT
 *     submit anything: there is no code path from here to the network. The
 *     expiry releases the capital reservation, keeping long runs in steady state.
 *   InMemoryOrderJournal — the durable-journal contract (recordPending must
 *     throw if it could not record) with configurable latency and failures, so
 *     journal wait and fail-closed behaviour can be exercised without Supabase.
 *
 * Inputs:  OrderIntents from the JournaledExecutionSink.
 * Outputs: ORDER_SUBMITTED + ORDER_EXPIRED events; counts.
 */

import { newId } from "../utils/ids";
import { buildClientOrderId } from "../core/ledger/clientOrderId";
import type { EventBus } from "../core/engine/eventBus";
import type { IExecutionSink } from "../core/execution/IExecutionSink";
import type { OrderJournal } from "../core/execution/journaledExecution";
import type { Order, OrderIntent } from "../types/orders";
import type { ExecutionMode, UUID } from "../types/common";

export class NullExecutionSink implements IExecutionSink {
  submitted = 0;

  constructor(private readonly eventBus: EventBus, private readonly mode: ExecutionMode = "replay") {}

  async submitOrder(intent: OrderIntent): Promise<Order> {
    this.submitted++;
    const ts = intent.ts;
    const order: Order = {
      id: intent.id,
      brokerOrderId: `null_${intent.id}`,
      intentId: intent.id,
      strategyId: intent.strategyId,
      symbol: intent.symbol,
      side: intent.side,
      qty: intent.qty,
      filledQty: 0,
      orderType: intent.orderType,
      limitPrice: intent.limitPrice,
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
    this.eventBus.publish({ id: newId(), type: "ORDER_SUBMITTED", ts, mode: this.mode, payload: order });
    this.eventBus.publish({ id: newId(), type: "ORDER_EXPIRED", ts, mode: this.mode, orderId: order.id });
    return order;
  }

  async cancelOrder(): Promise<void> {
    /* nothing rests here */
  }
}

export interface InMemoryJournalOptions {
  /** Simulated write latency, ms. 0 resolves on the next microtask. */
  latencyMs?: number;
  /** Fail every Nth write (1 = every write). */
  failEvery?: number;
}

export class InMemoryOrderJournal implements OrderJournal {
  readonly pending = new Set<UUID>();
  readonly sendFailed = new Map<UUID, string>();
  writes = 0;
  failures = 0;

  constructor(private readonly options: InMemoryJournalOptions = {}) {}

  async recordPending(intent: OrderIntent): Promise<void> {
    this.writes++;
    const latency = this.options.latencyMs ?? 0;
    if (latency > 0) await new Promise((r) => setTimeout(r, latency));
    else await Promise.resolve();
    const every = this.options.failEvery;
    if (every && every > 0 && this.writes % every === 0) {
      this.failures++;
      throw new Error("simulated journal outage");
    }
    this.pending.add(intent.id);
  }

  async recordSendFailed(intentId: UUID, reason: string): Promise<void> {
    this.sendFailed.set(intentId, reason);
  }
}
