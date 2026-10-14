/**
 * tests/bench/processingReplay.test.ts
 *
 * Processing replay and the checked-in fixture:
 *   - every fixture expectation holds (counts, issues, epochs, sub-ms precision,
 *     shared receipt, quarantine, repeatability)
 *   - repeated runs make identical decisions
 *   - the replay clock cannot run inside a live/paper-locked process, and is
 *     always cleared afterwards
 *   - burst/backlog is visible as lateness and scheduled-to-done (coordinated
 *     omission), with bounded memory
 *   - benchmark modes cannot reach the network
 */

import { runFixtureCorrectness, guardNetwork } from "../../bench/commands";
import { buildBenchEngine, type BenchEngine } from "../../bench/engine";
import { runProcessingReplay, scheduleOffsetNs, ReplayClockLockedError } from "../../bench/processingReplay";
import { generateSyntheticFrames } from "../../bench/syntheticWorkload";
import { lockClockForLive, unlockClockForLive, nowMs } from "../../utils/time";
import type { FrameRecord } from "../../core/telemetry/frameRecorder";

afterEach(() => unlockClockForLive());

describe("checked-in fixture", () => {
  it("meets every stated expectation", async () => {
    const result = await runFixtureCorrectness();
    const failed = result.checks.filter((c) => !c.passed);
    expect(failed).toEqual([]);
    expect(result.checks.length).toBeGreaterThan(30);
  });
});

describe("processing replay", () => {
  const workload = [...generateSyntheticFrames({ symbols: ["SPY", "QQQ"], durationMs: 15_000, quotesPerSecPerSymbol: 40, tradesPerSecPerSymbol: 8, seed: 21 })];

  it("repeated runs over the same input decide identically", async () => {
    const run = async (): Promise<string> => {
      const engine = buildBenchEngine({ strategy: { name: "quote_imbalance", count: 1, symbols: ["SPY", "QQQ"] }, sink: "sim" });
      try {
        const r = await runProcessingReplay(workload, { engine, pacing: { mode: "max" } });
        return String(r.decisions["decision_checksum"]) + String(r.decisions["fill_checksum"]);
      } finally {
        engine.stop();
      }
    };
    expect(await run()).toBe(await run());
  });

  it("refuses to install the replay clock in a process locked for live trading", async () => {
    lockClockForLive("paper");
    const engine = buildBenchEngine({ strategy: { name: "null", count: 1, symbols: ["SPY"] }, sink: "null" });
    try {
      await expect(runProcessingReplay(workload, { engine, pacing: { mode: "max" } })).rejects.toBeInstanceOf(ReplayClockLockedError);
    } finally {
      engine.stop();
    }
  });

  it("restores the wall clock after a replay, even one that throws", async () => {
    const engine = buildBenchEngine({ strategy: { name: "null", count: 1, symbols: ["SPY"] }, sink: "null" });
    const boom = { ...engine, ingest: () => { throw new Error("boom"); } } as BenchEngine;
    await expect(runProcessingReplay(workload, { engine: boom, pacing: { mode: "max" } })).rejects.toThrow("boom");
    engine.stop();
    expect(Math.abs(nowMs() - Date.now())).toBeLessThan(1_000);
  });

  it("shows backlog as lateness and scheduled-to-done when the consumer is slower than arrivals", async () => {
    // 100 frames, 0.5 ms apart, each taking ~2 ms to process: a 4x overload.
    const frames: FrameRecord[] = Array.from({ length: 100 }, (_, i) => ({
      v: 1, type: "frame", epoch: 1, seq: i + 1, rx_wall_ms: 1_000 + i, rx_mono_ns: String(i * 500_000), data: "[]",
    }));
    const slow = {
      decisions: { summary: () => ({}) },
      ingest: () => { const until = process.hrtime.bigint() + 2_000_000n; while (process.hrtime.bigint() < until) { /* busy */ } },
    } as unknown as BenchEngine;
    const heapBefore = process.memoryUsage().heapUsed;
    const r = await runProcessingReplay(frames, { engine: slow, pacing: { mode: "paced", speed: 1 }, deadlineMs: 5 });
    expect(r.late_frames_over_1ms).toBeGreaterThan(50);
    expect(r.scheduled_to_done.p99_ms!).toBeGreaterThan(r.frame_processing.p99_ms! * 5);
    expect(r.deadline_misses).toBeGreaterThan(50);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(50 * 1024 * 1024);
  });

  it("maps recording offsets through speed and burst windows", () => {
    const ms = (v: number): bigint => BigInt(v) * 1_000_000n;
    expect(scheduleOffsetNs(ms(1_000), 1)).toBe(ms(1_000));
    expect(scheduleOffsetNs(ms(1_000), 10)).toBe(ms(100));
    // 1 s at 1x, but [200, 400) ms runs 4x faster: 1000 − 200 + 50 = 850 ms.
    expect(scheduleOffsetNs(ms(1_000), 1, [{ startOffsetMs: 200, durationMs: 200, speedMultiplier: 4 }])).toBe(ms(850));
    expect(scheduleOffsetNs(ms(300), 1, [{ startOffsetMs: 200, durationMs: 200, speedMultiplier: 4 }])).toBe(ms(225));
  });

  it("cannot reach the network in benchmark modes", async () => {
    const net = guardNetwork();
    try {
      await expect(fetch("https://paper-api.alpaca.markets/v2/orders")).rejects.toThrow(/disabled/);
      const engine = buildBenchEngine({ strategy: { name: "quote_imbalance", count: 1, symbols: ["SPY", "QQQ"] }, sink: "null" });
      await runProcessingReplay(workload, { engine, pacing: { mode: "max" } });
      engine.stop();
      expect(engine.nullSink!.submitted).toBeGreaterThan(0);
      expect(net.calls()).toBe(1); // only the deliberate probe call above
    } finally {
      net.restore();
    }
  });
});
