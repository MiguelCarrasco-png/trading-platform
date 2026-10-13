/**
 * tests/bench/reportAndSafety.test.ts
 *
 * Reporting honesty and command safety:
 *   - a report with insufficient data says so instead of declaring a result
 *   - delay verdicts follow the predeclared criterion
 *   - artifacts never overwrite a run and never contain configured secrets
 *   - unknown or missing flags fail; live commands refuse without their
 *     explicit confirmations, before any network call
 */

import fs from "fs";
import os from "os";
import path from "path";
import { RunArtifacts, SecretLeakError, assertNoSecrets, newRunId } from "../../bench/artifacts";
import { buildReport, judgeDelay, parseCsv, type MetricsFile } from "../../bench/report";
import { Histogram } from "../../core/telemetry/histogram";
import { Args, ArgError } from "../../bench/args";
import { guardNetwork } from "../../bench/commands";
import { captureCommand } from "../../bench/capture";
import { paperCommand } from "../../bench/paperProbe";
import { delayCommand } from "../../bench/commands";
import { buildManifest } from "../../bench/manifest";
import type { ProbeSnapshot } from "../../core/telemetry/latencyProbe";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-")); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function histOf(values: number[]): ReturnType<Histogram["toJSON"]> {
  const h = new Histogram();
  values.forEach((v) => h.record(v));
  return h.toJSON();
}

function metricsWith(histograms: Record<string, ReturnType<Histogram["toJSON"]>>, synthetic = false): MetricsFile {
  const probe = { histograms, counters: {}, lifecycle: [], sampling: { probability: 0, traces_total: 0, traces_sampled: 0, traces_retained: 0, open_trace_evictions: 0, intent_evictions: 0 } } as unknown as ProbeSnapshot;
  return { schema_version: 1, kind: "test", synthetic, input_label: "test", probe, replay_runs: [], resources: null, recorder: null, paper: null, notes: [] };
}

describe("report", () => {
  it("says 'insufficient' or 'not measured' rather than inventing percentiles", () => {
    const run = RunArtifacts.create("r1", tmp, []);
    run.writeJson("metrics.json", metricsWith({
      "order.receive_to_submit_ns": histOf(Array.from({ length: 12 }, (_, i) => (i + 1) * 1e6)),
      "frame.parse_ns": histOf(Array.from({ length: 500 }, (_, i) => i * 1_000)),
    }));
    const { markdown, summaryRows } = buildReport(run);
    expect(markdown).toMatch(/Application receive-to-submit \| 12 \| insufficient \(n<20\)/);
    expect(markdown).toMatch(/Required journal wait \| 0 \| not measured/);
    expect(markdown).toMatch(/Frame parse \| 500 \| [\d.]+ \| [\d.]+ \| n<1000/);
    expect(markdown).toMatch(/target is \*\*not established\*\*/);
    const parse = summaryRows.find((r) => r.metric === "frame.parse_ns")!;
    expect(parse.p99_ms).toBeNull();
    expect(parse.p95_ms).not.toBeNull();
  });

  it("labels synthetic input prominently", () => {
    const run = RunArtifacts.create("r2", tmp, []);
    run.writeJson("metrics.json", metricsWith({}, true));
    expect(buildReport(run).markdown).toMatch(/Synthetic input/);
  });

  it("judges delay sensitivity only by the written criterion", () => {
    const row = (delay: number, net: number, n: number, se: number): Record<string, string> => ({
      split: "evaluation", cost_scenario: "base", seed: "1", delay_ms: String(delay),
      net_pnl_flattened: String(net), round_trips: String(n), per_trade_pnl_stderr: String(se),
    });
    expect(judgeDelay([row(0, 5, 10, 0.1)])).toMatch(/Insufficient sample/);
    expect(judgeDelay([row(0, -3, 100, 0.01), row(100, -4, 100, 0.01)])).toMatch(/Revisit the strategy/);
    expect(judgeDelay([row(0, 50, 100, 0.1), row(100, 30, 100, 0.1), row(250, 5, 100, 0.1)]))
      .toMatch(/between 100 and 250 ms/);
    expect(judgeDelay([row(0, 50, 100, 0.1), row(2000, 40, 100, 0.1)])).toMatch(/not the binding constraint/);
  });

  it("parses its own CSV output, including quoted cells", () => {
    expect(parseCsv('a,b\n1,"x, ""y"""\n')).toEqual([{ a: "1", b: 'x, "y"' }]);
  });
});

describe("artifacts", () => {
  it("never overwrites an existing run directory", () => {
    RunArtifacts.create("same", tmp, []);
    expect(() => RunArtifacts.create("same", tmp, [])).toThrow();
  });

  it("refuses to write anything containing a configured secret", () => {
    const run = RunArtifacts.create("s", tmp, ["SUPER-SECRET-KEY-123"]);
    expect(() => run.writeJson("x.json", { note: "token SUPER-SECRET-KEY-123" })).toThrow(SecretLeakError);
    expect(fs.existsSync(run.path("x.json"))).toBe(false);
    expect(() => assertNoSecrets("fine", ["SUPER-SECRET-KEY-123"], "y")).not.toThrow();
  });

  it("builds a manifest from an allowlist that never includes credentials", async () => {
    const m = await buildManifest({ runId: newRunId("t"), command: "test", argv: [], run: {} });
    const text = JSON.stringify(m);
    for (const key of ["ALPACA_API_KEY", "ALPACA_API_SECRET", "ALPACA_DATA_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "DATABASE_URL"]) {
      expect(Object.keys(m.environment)).not.toContain(key);
      const v = process.env[key];
      if (v && v.length >= 8) expect(text).not.toContain(v);
    }
    expect(m.clock["clock_domain_id"]).toBeDefined();
  });
});

describe("command safety", () => {
  it("rejects unknown flags and missing required values", () => {
    const a = new Args(["fixture", "--duration-s", "10", "--typo-flag", "3"]);
    a.num("duration-s", 1);
    expect(() => a.assertAllUsed()).toThrow(/--typo-flag/);
    expect(() => new Args(["replay"]).str("recording")).toThrow(ArgError);
    expect(new Args(["x", "--flag", "--n=4"]).bool("flag")).toBe(true);
    expect(new Args(["x", "--n=4"]).num("n")).toBe(4);
  });

  it("live capture refuses without --confirm-stream-owner, before any network call", async () => {
    const net = guardNetwork();
    try {
      await expect(captureCommand(new Args(["capture", "--symbols", "SPY", "--duration-min", "1", "--out", tmp])))
        .rejects.toThrow(/--confirm-stream-owner/);
      expect(net.calls()).toBe(0);
      expect(fs.readdirSync(tmp)).toEqual([]);
    } finally {
      net.restore();
    }
  });

  it("the paper probe refuses without its confirmations, before any network call", async () => {
    const net = guardNetwork();
    try {
      const base = ["paper", "--symbol", "SPY", "--max-orders", "2", "--max-notional-usd", "1000", "--out", tmp];
      await expect(paperCommand(new Args(base))).rejects.toThrow(/--confirm-paper-orders/);
      await expect(paperCommand(new Args([...base, "--confirm-paper-orders", "--max-orders", "40"]))).rejects.toThrow(ArgError);
      // EXECUTION_TARGET defaults to sim, which the probe refuses.
      if ((process.env.EXECUTION_TARGET ?? "sim") !== "alpaca-paper") {
        await expect(paperCommand(new Args([...base, "--confirm-paper-orders"]))).rejects.toThrow(/EXECUTION_TARGET/);
      }
      expect(net.calls()).toBe(0);
    } finally {
      net.restore();
    }
  });

  it("the delay command needs a plan and refuses the evaluation split without confirmation", async () => {
    await expect(delayCommand(new Args(["delay", "--synthetic", "--out", tmp]))).rejects.toThrow(/--plan/);
    const planPath = path.join(tmp, "plan.json");
    fs.writeFileSync(planPath, "{}");
    await expect(delayCommand(new Args(["delay", "--plan", planPath, "--synthetic", "--split", "evaluation", "--out", tmp])))
      .rejects.toThrow(/--confirm-evaluation-split/);
  });
});
