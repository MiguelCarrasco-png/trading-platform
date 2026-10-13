/**
 * core/telemetry/orderPathTiming.ts
 *
 * Decorators that time the order path without changing it:
 *
 *   JournaledExecutionSink(TimedExecutionSink(broker), TimedOrderJournal(journal))
 *
 * The journal decorator measures the awaited durable write that must succeed
 * before an order is sent (the fail-closed rule in journaledExecution.ts is
 * untouched — a journal error is re-thrown). The sink decorator marks
 * submit_start immediately before the broker client is invoked and
 * response_complete when it returns a mapped Order. Neither is the wire send or
 * the exchange arrival time: DNS, TLS and client queues sit inside the span.
 *
 * attachOrderLifecycle() listens for order updates and applied fills. Register
 * it AFTER Orchestrator.start(): the bus calls handlers in registration order,
 * so the probe then observes a fill after the orchestrator has applied it.
 *
 * Inputs:  An inner OrderJournal / IExecutionSink and an OrderPathProbe.
 * Outputs: The same results and errors as the inner objects; timings on the probe.
 */

import type { EventBus } from "../engine/eventBus";
import type { IExecutionSink } from "../execution/IExecutionSink";
import type { OrderJournal } from "../execution/journaledExecution";
import type { OrderPathProbe } from "./latencyProbe";
import type { Order, OrderIntent } from "../../types/orders";
import type { UUID } from "../../types/common";
import type {
  OrderCanceledEvent,
  OrderExpiredEvent,
  OrderFilledEvent,
  OrderPartialFillEvent,
  OrderRejectedEvent,
  OrderSubmittedEvent,
} from "../../types/events";

/** Short, bounded error label for counters (never the message, which may hold ids). */
export function errorClass(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name && err.name !== "Error" ? err.name : "Error";
    return name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) || "Error";
  }
  return "NonError";
}

export class TimedOrderJournal implements OrderJournal {
  constructor(private readonly inner: OrderJournal, private readonly probe: OrderPathProbe) {}

  async recordPending(intent: OrderIntent): Promise<void> {
    const start = this.probe.now();
    try {
      await this.inner.recordPending(intent);
    } catch (err) {
      this.probe.journal(intent.id, start, this.probe.now(), `failed_${errorClass(err)}`);
      throw err;
    }
    this.probe.journal(intent.id, start, this.probe.now(), "ok");
  }

  recordSendFailed(intentId: UUID, reason: string): Promise<void> {
    return this.inner.recordSendFailed(intentId, reason);
  }
}

export class TimedExecutionSink implements IExecutionSink {
  constructor(private readonly inner: IExecutionSink, private readonly probe: OrderPathProbe) {}

  async submitOrder(intent: OrderIntent): Promise<Order> {
    this.probe.submitStart(intent.id, this.probe.now());
    try {
      const order = await this.inner.submitOrder(intent);
      this.probe.submitEnd(intent.id, this.probe.now(), "ok");
      return order;
    } catch (err) {
      this.probe.submitEnd(intent.id, this.probe.now(), `error_${errorClass(err)}`);
      throw err;
    }
  }

  cancelOrder(brokerOrderId: string): Promise<void> {
    return this.inner.cancelOrder(brokerOrderId);
  }
}

/**
 * Observes order updates and applied fills. Call after Orchestrator.start().
 * @returns a function that detaches the listeners
 */
export function attachOrderLifecycle(bus: EventBus, probe: OrderPathProbe): () => void {
  const submitted = (e: OrderSubmittedEvent): void => probe.orderUpdate(e.payload.id, "submitted", probe.now());
  const partial = (e: OrderPartialFillEvent): void => {
    const ns = probe.now();
    probe.orderUpdate(e.orderId, "partial_fill", ns);
    probe.fillApplied(e.orderId, ns, false);
  };
  const filled = (e: OrderFilledEvent): void => {
    const ns = probe.now();
    probe.orderUpdate(e.orderId, "filled", ns);
    probe.fillApplied(e.orderId, ns, true);
  };
  const canceled = (e: OrderCanceledEvent): void => probe.orderUpdate(e.orderId, "canceled", probe.now());
  const rejected = (e: OrderRejectedEvent): void => probe.orderUpdate(e.orderId, "rejected", probe.now());
  const expired = (e: OrderExpiredEvent): void => probe.orderUpdate(e.orderId, "expired", probe.now());

  bus.on<OrderSubmittedEvent>("ORDER_SUBMITTED", submitted);
  bus.on<OrderPartialFillEvent>("ORDER_PARTIAL_FILL", partial);
  bus.on<OrderFilledEvent>("ORDER_FILLED", filled);
  bus.on<OrderCanceledEvent>("ORDER_CANCELED", canceled);
  bus.on<OrderRejectedEvent>("ORDER_REJECTED", rejected);
  bus.on<OrderExpiredEvent>("ORDER_EXPIRED", expired);

  return () => {
    bus.off<OrderSubmittedEvent>("ORDER_SUBMITTED", submitted);
    bus.off<OrderPartialFillEvent>("ORDER_PARTIAL_FILL", partial);
    bus.off<OrderFilledEvent>("ORDER_FILLED", filled);
    bus.off<OrderCanceledEvent>("ORDER_CANCELED", canceled);
    bus.off<OrderRejectedEvent>("ORDER_REJECTED", rejected);
    bus.off<OrderExpiredEvent>("ORDER_EXPIRED", expired);
  };
}
