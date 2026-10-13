/**
 * bench/processingReplay.ts
 *
 * Processing replay: delivers recorded (or synthetic) frames to a BenchEngine
 * in their original receive order and measures how fast the application
 * processes them.
 *
 * Pacing:
 *   - "paced": frame i is scheduled at start + (its recorded receive offset ÷
 *     speed); burst windows divide the offset further. speed 1 is real time.
 *   - "max": no schedule; the next frame is delivered as soon as the previous
 *     one returns. Measures capacity, not latency under realistic arrival.
 *
 * Measurements (driver-level, independent of any probe, so the uninstrumented
 * configuration is measured the same way):
 *   - generator lateness = delivered − scheduled. Large values mean the
 *     consumer (or the generator sharing its CPU) fell behind.
 *   - frame processing = callback return − delivery.
 *   - scheduled-to-done = callback return − scheduled. This includes time spent
 *     waiting behind earlier frames, so a saturated run cannot hide backlog
 *     (coordinated omission).
 *
 * Clock: the application's nowMs() is stepped to each frame's recorded receive
 * wall time (a simulated clock), so cooldowns and stale-quote checks see the
 * recording's time and repeated runs decide identically. This runs only in a
 * process that has not locked its clock for live trading — the benchmark CLI
 * is its own process — and is refused otherwise.
 *
 * Inputs:  Frames (iterable or async iterable of recording records), engine, pacing.
 * Outputs: ProcessingReplayResult.
 */

import { setImmediate as setImmediateP, setTimeout as setTimeoutP } from "timers/promises";
import { Histogram } from "../core/telemetry/histogram";
import { summarizeHistogram, type LatencySummary, type LatencyProbe } from "../core/telemetry/latencyProbe";
import { setClockOverride, isClockLockedForLive } from "../utils/time";
import type { RecordingRecord } from "../core/telemetry/frameRecorder";
import type { BenchEngine } from "./engine";

export interface BurstWindow {
  /** Recording-time offset where the window starts, ms. */
  startOffsetMs: number;
  durationMs: number;
  /** Extra speed-up inside the window (2 = twice as fast as the base speed). */
  speedMultiplier: number;
}

export type PacingOptions =
  | { mode: "max" }
  | { mode: "paced"; speed: number; bursts?: BurstWindow[] };

export interface ProcessingReplayOptions {
  engine: BenchEngine;
  probe?: LatencyProbe;
  pacing: PacingOptions;
  /** Frames delivered before measurement starts. */
  warmupFrames?: number;
  /** Per-frame scheduled-to-done deadline, ms. */
  deadlineMs?: number;
  /** Step the application clock to recorded receive time. Default true. */
  stepClock?: boolean;
  /** Stop after this many frames. */
  maxFrames?: number;
  /** In max mode, yield to the event loop every N frames so async order work runs. Default 1. */
  yieldEvery?: number;
  /** Time to let in-flight async order work settle at the end, ms. */
  settleMs?: number;
}

export interface ProcessingReplayResult {
  pacing: PacingOptions;
  frames_delivered: number;
  frames_measured: number;
  lifecycle_records: number;
  gap_records: number;
  redacted_records: number;
  epochs: number[];
  wall_elapsed_ms: number;
  measured_elapsed_ms: number;
  throughput_frames_per_s: number | null;
  generator_lateness: LatencySummary;
  frame_processing: LatencySummary;
  scheduled_to_done: LatencySummary;
  deadline_ms: number | null;
  deadline_misses: number;
  late_frames_over_1ms: number;
  histograms: {
    generator_lateness_ns: ReturnType<Histogram["toJSON"]>;
    frame_processing_ns: ReturnType<Histogram["toJSON"]>;
    scheduled_to_done_ns: ReturnType<Histogram["toJSON"]>;
  };
  decisions: Record<string, unknown>;
  input_incomplete: boolean;
}

export class ReplayClockLockedError extends Error {
  constructor() {
    super("Refusing to replay: this process has locked its clock for live/paper trading. Run the benchmark in its own process.");
    this.name = "ReplayClockLockedError";
  }
}

/** Maps a recording offset to a schedule offset under base speed and burst windows. */
export function scheduleOffsetNs(offsetNs: bigint, speed: number, bursts: BurstWindow[] = []): bigint {
  if (speed <= 0) throw new Error("speed must be > 0");
  const t = Number(offsetNs) / 1e6; // ms
  // Integrate 1/speed(t') over [0, t]: base rate everywhere, multiplied inside windows.
  let scaledMs = t / speed;
  for (const w of bursts) {
    const overlap = Math.max(0, Math.min(t, w.startOffsetMs + w.durationMs) - w.startOffsetMs);
    if (overlap > 0 && w.speedMultiplier > 0) scaledMs -= overlap / speed - overlap / (speed * w.speedMultiplier);
  }
  return BigInt(Math.round(scaledMs * 1e6));
}

// Sleep with a timer only when the wait is long compared with the OS timer
// tick; spin on setImmediate for the rest. Windows ticks every ~15.6 ms.
const TIMER_SLACK_NS = process.platform === "win32" ? 20_000_000n : 2_000_000n;
const TIMER_MARGIN_NS = process.platform === "win32" ? 17_000_000n : 1_500_000n;

async function waitUntil(targetNs: bigint): Promise<void> {
  for (;;) {
    const remaining = targetNs - process.hrtime.bigint();
    if (remaining <= 0n) return;
    if (remaining > TIMER_SLACK_NS) await setTimeoutP(Number(remaining - TIMER_MARGIN_NS) / 1e6);
    else await setImmediateP();
  }
}

export async function runProcessingReplay(
  frames: Iterable<RecordingRecord> | AsyncIterable<RecordingRecord>,
  opts: ProcessingReplayOptions,
): Promise<ProcessingReplayResult> {
  const stepClock = opts.stepClock ?? true;
  if (stepClock && isClockLockedForLive()) throw new ReplayClockLockedError();

  const warmup = opts.warmupFrames ?? 0;
  const deadlineNs = opts.deadlineMs !== undefined ? opts.deadlineMs * 1e6 : null;
  const yieldEvery = Math.max(1, opts.yieldEvery ?? 1);
  const lateness = new Histogram();
  const processing = new Histogram();
  const schedToDone = new Histogram();
  const epochs = new Set<number>();
  let delivered = 0;
  let measured = 0;
  let lifecycle = 0;
  let gaps = 0;
  let redacted = 0;
  let deadlineMisses = 0;
  let lateOver1ms = 0;
  let simWallMs = 0;
  let firstMono: bigint | null = null;
  let measureStartNs: bigint | null = null;

  if (stepClock) setClockOverride(() => simWallMs);
  const startNs = process.hrtime.bigint() + 1_000_000n;
  let lastDoneNs = startNs;
  try {
    for await (const rec of frames as AsyncIterable<RecordingRecord>) {
      if (rec.type === "lifecycle") {
        lifecycle++;
        opts.probe?.count(`recorded_lifecycle.${rec.kind}`);
        continue;
      }
      if (rec.type === "gap") {
        gaps++;
        opts.probe?.count("recorded_gaps", rec.count);
        continue;
      }
      if (rec.type === "redacted") {
        redacted++;
        continue;
      }
      if (rec.type !== "frame") continue;
      if (opts.maxFrames !== undefined && delivered >= opts.maxFrames) break;

      const recMono = BigInt(rec.rx_mono_ns);
      if (firstMono === null) firstMono = recMono;
      let scheduledNs: bigint;
      if (opts.pacing.mode === "paced") {
        const offset = recMono > firstMono ? recMono - firstMono : 0n;
        scheduledNs = startNs + scheduleOffsetNs(offset, opts.pacing.speed, opts.pacing.bursts);
        await waitUntil(scheduledNs);
      } else {
        scheduledNs = process.hrtime.bigint();
      }

      if (stepClock) simWallMs = rec.rx_wall_ms;
      epochs.add(rec.epoch);
      const deliveredNs = process.hrtime.bigint();
      opts.engine.ingest(rec);
      const doneNs = process.hrtime.bigint();
      lastDoneNs = doneNs;
      delivered++;

      if (delivered > warmup) {
        if (measureStartNs === null) measureStartNs = deliveredNs;
        measured++;
        const late = deliveredNs - scheduledNs;
        lateness.record(late > 0n ? late : 0n);
        if (late > 1_000_000n) lateOver1ms++;
        processing.record(doneNs - deliveredNs);
        const s2d = doneNs - scheduledNs;
        schedToDone.record(s2d > 0n ? s2d : 0n);
        if (deadlineNs !== null && Number(s2d) > deadlineNs) deadlineMisses++;
      }
      if (opts.pacing.mode === "max" && delivered % yieldEvery === 0) await setImmediateP();
    }
    // Let in-flight journal/sink promises settle before reading results.
    await setTimeoutP(opts.settleMs ?? 20);
  } finally {
    if (stepClock) setClockOverride(null);
  }

  const wallElapsedNs = lastDoneNs - startNs;
  const measuredElapsedNs = measureStartNs !== null ? lastDoneNs - measureStartNs : 0n;
  return {
    pacing: opts.pacing,
    frames_delivered: delivered,
    frames_measured: measured,
    lifecycle_records: lifecycle,
    gap_records: gaps,
    redacted_records: redacted,
    epochs: [...epochs].sort((a, b) => a - b),
    wall_elapsed_ms: Number(wallElapsedNs) / 1e6,
    measured_elapsed_ms: Number(measuredElapsedNs) / 1e6,
    throughput_frames_per_s: measuredElapsedNs > 0n ? measured / (Number(measuredElapsedNs) / 1e9) : null,
    generator_lateness: summarizeHistogram(lateness),
    frame_processing: summarizeHistogram(processing),
    scheduled_to_done: summarizeHistogram(schedToDone),
    deadline_ms: opts.deadlineMs ?? null,
    deadline_misses: deadlineMisses,
    late_frames_over_1ms: lateOver1ms,
    histograms: {
      generator_lateness_ns: lateness.toJSON(),
      frame_processing_ns: processing.toJSON(),
      scheduled_to_done_ns: schedToDone.toJSON(),
    },
    decisions: opts.engine.decisions.summary(),
    input_incomplete: gaps > 0 || redacted > 0,
  };
}
