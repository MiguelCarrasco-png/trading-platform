/**
 * bench/capture.ts
 *
 * `bench capture`: live shadow. Opens ONE Alpaca market-data stream with the
 * configured data keys, records every inbound frame, and runs the production
 * processing path (adapter → orchestrator → risk → journal) against a null
 * sink: strategies decide, intents are risk-checked and journaled in memory,
 * and nothing is sent to a broker. fetch() is disabled after the manifest is
 * collected, so no REST order call is possible from this process.
 *
 * Stream ownership: Alpaca's free plan allows one data connection per account.
 * The command refuses to start without --confirm-stream-owner, which asserts
 * that no other process (e.g. the local paper-trading runtime) is using these
 * keys right now, or that the keys are your own personal data keys.
 *
 * Outside the regular session the run is labelled a protocol test — it says
 * nothing about market-hours load. The `test` feed (FAKEPACA) is always a
 * protocol test.
 *
 * Inputs:  --symbols, --duration-min, --confirm-stream-owner, feed/strategy options.
 * Outputs: artifacts/latency/<run-id>/ with recording/, metrics, manifest, report.
 */

import { env } from "../config/env";
import { LatencyProbe } from "../core/telemetry/latencyProbe";
import { ResourceMonitor } from "../core/telemetry/resourceMonitor";
import { FrameRecorder } from "../core/telemetry/frameRecorder";
import { regularSessionHours } from "../core/market/marketHours";
import { NORMALIZER_VERSION } from "../adapters/alpaca/normalizer";
import { RunArtifacts, defaultArtifactsBase, knownSecretValues, newRunId } from "./artifacts";
import { buildManifest, invalidate } from "./manifest";
import { buildBenchEngine } from "./engine";
import { BENCH_STRATEGY_NAMES, benchStrategyVersion, type BenchStrategyName } from "./strategies";
import { finishRun, guardNetwork } from "./commands";
import { Args, ArgError } from "./args";
import type { MetricsFile } from "./report";

const FEEDS: Record<string, string> = {
  iex: "wss://stream.data.alpaca.markets/v2/iex",
  sip: "wss://stream.data.alpaca.markets/v2/sip",
  test: "wss://stream.data.alpaca.markets/v2/test",
};

export async function captureCommand(args: Args): Promise<string> {
  const symbols = args.list("symbols");
  const durationMin = args.num("duration-min", undefined, { min: 0.1, max: 8 * 60 });
  const feed = args.choice("feed", ["env", "iex", "sip", "test"] as const, "env");
  const confirm = args.bool("confirm-stream-owner");
  const record = !args.bool("no-record");
  const maxRecordMb = args.num("max-record-mb", 2048, { min: 1 });
  const minFreeMb = args.num("min-free-mb", 1024, { min: 0 });
  const strategyName = args.choice<BenchStrategyName>("strategy", BENCH_STRATEGY_NAMES, "quote_imbalance");
  const strategyCount = args.num("strategy-count", 1, { min: 1, max: 500, integer: true });
  const sample = args.num("sample", 0.01, { min: 0, max: 1 });
  const detail = args.choice("detail", ["frame", "stage"] as const, "frame");
  const deadlineMs = args.num("deadline-ms", 10, { min: 0 });
  const invalidData = args.choice("invalid-data", ["pass", "quarantine"] as const, env.marketDataInvalidPolicy);
  const progressS = args.num("progress-s", 60, { min: 5 });
  const base = args.optStr("out") ?? defaultArtifactsBase();
  args.assertAllUsed();

  if (!confirm) {
    throw new ArgError(
      "Live capture opens a market-data stream with ALPACA_DATA_KEY. Alpaca's free plan allows one data stream " +
      "per account, so a second one disconnects the first (or is refused). Stop other consumers of these keys " +
      "(e.g. the local paper-trading runtime) or use your own data keys, then pass --confirm-stream-owner.",
    );
  }
  if (!env.alpacaDataKey || !env.alpacaDataSecret) {
    throw new ArgError("ALPACA_DATA_KEY / ALPACA_DATA_SECRET (or ALPACA_API_KEY / ALPACA_API_SECRET) must be set for capture");
  }
  const url = feed === "env" ? env.alpacaDataStreamUrl : FEEDS[feed];
  const inSession = regularSessionHours.isOpen(Date.now());
  const protocolTest = feed === "test" || /\/v2\/test$/.test(url) || !inSession;

  const runId = newRunId("capture");
  const artifacts = RunArtifacts.create(runId, base);
  const manifest = await buildManifest({
    runId, command: "capture", argv: args.argv, storageDir: artifacts.dir,
    run: {
      mode: "live shadow", feed: url, symbols, duration_min: durationMin,
      market_session: inSession ? "regular session" : "outside regular session",
      label: protocolTest ? "protocol test — not market-hours load" : "market-hours live shadow",
      strategy: { name: strategyName, count: strategyCount, version: benchStrategyVersion(strategyName) },
      sink: "null (orders expire unfilled; no broker)", journal: "in-memory", invalid_data: invalidData,
      instrumentation: { sample_probability: sample, detail }, deadline_ms: deadlineMs, normalizer_version: NORMALIZER_VERSION,
      recording: record ? { max_mb: maxRecordMb, min_free_mb: minFreeMb } : "disabled",
      broker_orders_submitted: "none (null sink; fetch disabled)",
      stream_owner_confirmed: true,
    },
  });
  if (protocolTest) invalidate(manifest, "protocol test (outside regular session or test feed): not comparable as market load");

  const net = guardNetwork();
  const monitor = new ResourceMonitor();
  const probe = new LatencyProbe({
    runId, detail, sampleProbability: sample, normalizationVersion: NORMALIZER_VERSION,
    deadlinesMs: { "order.receive_to_submit_ns": deadlineMs, "frame.receive_to_done_ns": deadlineMs },
  });
  const recorder = record
    ? new FrameRecorder(artifacts.path("recording"), runId, {
        secretValues: knownSecretValues(),
        limits: { maxTotalBytes: maxRecordMb * 1024 * 1024, minFreeBytes: minFreeMb * 1024 * 1024 },
      })
    : null;
  if (recorder) await recorder.open();
  const engine = buildBenchEngine({
    strategy: { name: strategyName, count: strategyCount, symbols },
    sink: "null", invalidData, probe, observers: recorder ? [recorder] : [], mode: "paper", adapterUrl: url,
  });

  const metrics: MetricsFile = {
    schema_version: 1, kind: "capture", synthetic: false,
    input_label: `${protocolTest ? "protocol test" : "live shadow"} ${url} ${symbols.join(",")}`,
    probe: null, replay_runs: [], resources: null, recorder: null, paper: null, notes: [],
  };
  let stopReason = "duration elapsed";
  monitor.start();
  try {
    console.log(`[bench capture] ${runId}: connecting to ${url} for ${durationMin} min (${symbols.join(",")})…`);
    await engine.adapter.connect();
    engine.adapter.subscribe(symbols);

    await new Promise<void>((resolve) => {
      const started = Date.now();
      const deadline = started + durationMin * 60_000;
      const onSignal = (): void => { stopReason = "interrupted (signal)"; finish(); };
      const progress = setInterval(() => {
        const s = probe.snapshot();
        console.log(`[bench capture] ${Math.round((Date.now() - started) / 1000)}s: frames ${s.counters["frames.received"] ?? 0}, quotes ${s.counters["events.quote"] ?? 0}, trades ${s.counters["events.trade"] ?? 0}, bars ${s.counters["events.bar"] ?? 0}, reconnects ${s.counters["lifecycle.reconnect_scheduled"] ?? 0}${recorder ? `, recorded ${recorder.stats().records_written} (dropped ${recorder.stats().records_dropped})` : ""}`);
        if (recorder && recorder.stats().state !== "open") { stopReason = `recorder ${recorder.stats().state}`; finish(); }
        try { artifacts.writeJson("metrics.partial.json", { ...metrics, probe: s }); } catch { /* best effort */ }
      }, progressS * 1000);
      const timer = setTimeout(finish, deadline - Date.now());
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      function finish(): void {
        clearInterval(progress);
        clearTimeout(timer);
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        resolve();
      }
    });
  } finally {
    engine.adapter.disconnect();
    engine.stop();
    await new Promise((r) => setTimeout(r, 50));
    if (recorder) {
      const index = await recorder.close();
      metrics.recorder = index.stats;
      if (!index.stats.complete) invalidate(manifest, "recording incomplete (drops or recorder failure)");
    }
    monitor.stop();
    net.restore();
  }
  manifest.run["stop_reason"] = stopReason;
  manifest.run["network_calls_blocked"] = net.calls();
  manifest.run["acknowledged_subscription"] = probe.snapshot().last_subscription_ack;
  manifest.run["decisions"] = engine.decisions.summary();
  if (!probe.snapshot().last_subscription_ack) invalidate(manifest, "no subscription acknowledgement received");
  finishRun(artifacts, manifest, metrics, probe, monitor);
  console.log(`[bench capture] stopped: ${stopReason}`);
  return artifacts.dir;
}
