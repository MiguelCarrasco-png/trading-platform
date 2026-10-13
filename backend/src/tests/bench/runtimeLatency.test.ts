/**
 * tests/bench/runtimeLatency.test.ts
 *
 * The opt-in runtime instrumentation (LATENCY_PROBE=1) end to end without a
 * broker: it prepares an immutable run directory, instruments a real adapter /
 * orchestrator / journaled sink, and on stop writes metrics, traces, the
 * manifest and a report — while orders still flow exactly as before.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { env } from "../../config/env";
import { RuntimeLatency } from "../../runtime/latencyInstrumentation";
import { EventBus } from "../../core/engine/eventBus";
import { AlpacaMarketDataAdapter } from "../../adapters/alpaca/marketData";
import { JournaledExecutionSink } from "../../core/execution/journaledExecution";
import { InMemoryOrderJournal, NullExecutionSink } from "../../bench/sinks";
import type { OrderIntent } from "../../types/orders";

let tmp: string;
const original = { dir: env.latencyProbeDir, record: env.latencyRecord };
const mutableEnv = env as unknown as Record<string, unknown>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-"));
  mutableEnv.latencyProbeDir = path.join(tmp, "run");
  mutableEnv.latencyRecord = true;
});
afterEach(() => {
  mutableEnv.latencyProbeDir = original.dir;
  mutableEnv.latencyRecord = original.record;
  fs.rmSync(tmp, { recursive: true, force: true });
});

it("instruments a runtime's own stream and order path, and writes its artifacts on stop", async () => {
  const latency = new RuntimeLatency("paper", "sim");
  await latency.prepare();
  const dir = path.join(tmp, "run");
  expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(false); // written at stop, with the final state

  const bus = new EventBus();
  const adapter = new AlpacaMarketDataAdapter(bus, "paper", latency.adapterOptions());
  const inner = new NullExecutionSink(bus, "paper");
  const sink = new JournaledExecutionSink(latency.wrapSink(inner), latency.wrapJournal(new InMemoryOrderJournal()));
  latency.start(bus);

  adapter.ingestFrame(JSON.stringify([{ T: "q", S: "SPY", bp: 500, ap: 500.02, bs: 2, as: 1, t: new Date().toISOString() }]));
  const intent = { id: "i-1", strategyId: "s", symbol: "SPY", side: "buy", qty: 1, orderType: "market", timeInForce: "ioc", ts: 1 } as OrderIntent;
  const order = await sink.submitOrder(intent);
  expect(order.id).toBe("i-1");
  expect(inner.submitted).toBe(1);

  latency.export();
  expect(JSON.parse(fs.readFileSync(path.join(dir, "metrics.json"), "utf8")).kind).toBe("runtime");
  await latency.stop();

  for (const f of ["manifest.json", "metrics.json", "trace-sample.ndjson", "decision-report.md", "latency-summary.csv", "recording/recording-index.json"]) {
    expect(fs.existsSync(path.join(dir, f))).toBe(true);
  }
  const metrics = JSON.parse(fs.readFileSync(path.join(dir, "metrics.json"), "utf8"));
  expect(metrics.probe.counters["events.quote"]).toBe(1);
  expect(metrics.probe.histograms["order.journal_ns"].count).toBe(1);
  expect(metrics.recorder.records_written).toBeGreaterThanOrEqual(1);
});

it("refuses to reuse an existing output directory but never throws into the runtime", async () => {
  fs.mkdirSync(path.join(tmp, "run"));
  const latency = new RuntimeLatency("paper", "sim");
  await expect(latency.prepare()).resolves.toBeUndefined();
  latency.export(); // no artifacts: a no-op, not an error
  await expect(latency.stop()).resolves.toBeUndefined();
});
