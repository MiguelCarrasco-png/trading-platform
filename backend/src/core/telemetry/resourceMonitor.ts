/**
 * core/telemetry/resourceMonitor.ts
 *
 * Low-overhead process health sampler for benchmark runs: event-loop delay
 * and utilization, process CPU, memory, GC pauses, container CPU throttling
 * (Linux cgroup v2), and wall-vs-monotonic clock anchors.
 *
 * CPU is reported as a percentage of ONE core: a saturated event loop shows
 * ~100% here while a two-vCPU host's aggregate utilization reads only ~50%.
 *
 * Every sample stores a (wall, monotonic) anchor pair. When the wall clock
 * moves by a materially different amount than the monotonic clock between two
 * samples, the wall clock was stepped; that sample interval is recorded as a
 * clock discontinuity and runs should be split there for external-age analysis.
 *
 * Event-loop delay comes from perf_hooks.monitorEventLoopDelay, a timer-based
 * sampler that records the whole interval between its timer firings. The
 * configured resolution is subtracted, so the reported figure is delay BEYOND
 * the timer's schedule. On Windows the OS timer tick (~15.6 ms) dominates that
 * figure; measure event-loop delay on Linux.
 *
 * Inputs:  Sampling interval and bounds.
 * Outputs: samples() rows for resource-timeseries.csv; summary() for metrics.json.
 */

import fs from "fs";
import { monitorEventLoopDelay, performance, PerformanceObserver, constants, type IntervalHistogram, type EventLoopUtilization } from "perf_hooks";

export interface ResourceSample {
  wall_ms: number;
  mono_ns: string;
  elapsed_ms: number;
  event_loop_delay_p50_ms: number | null;
  event_loop_delay_p99_ms: number | null;
  event_loop_delay_max_ms: number | null;
  event_loop_utilization: number;
  cpu_user_ms: number;
  cpu_system_ms: number;
  cpu_pct_of_one_core: number;
  rss_mb: number;
  heap_used_mb: number;
  heap_total_mb: number;
  external_mb: number;
  gc_count: number;
  gc_major_count: number;
  gc_pause_ms: number;
  gc_pause_max_ms: number;
  cgroup_throttled_periods: number | null;
  cgroup_throttled_ms: number | null;
}

export interface ClockDiscontinuity {
  at_wall_ms: number;
  wall_delta_ms: number;
  mono_delta_ms: number;
  jump_ms: number;
}

export interface ResourceSummary {
  samples: number;
  interval_ms: number;
  event_loop_resolution_ms: number;
  platform: string;
  /** Set when the platform's timers make event-loop delay unreliable. */
  timer_caveat: string | null;
  event_loop_delay_ms: { p50: number | null; p90: number | null; p99: number | null; max: number | null; mean: number | null };
  event_loop_utilization_mean: number | null;
  cpu_pct_of_one_core_mean: number | null;
  cpu_pct_of_one_core_max: number | null;
  rss_mb_max: number | null;
  heap_used_mb_max: number | null;
  rss_mb_growth: number | null;
  gc_major_count: number;
  gc_pause_ms_total: number;
  gc_pause_ms_max: number;
  cgroup_throttled_ms_total: number | null;
  clock_discontinuities: ClockDiscontinuity[];
  samples_dropped: number;
}

export interface ResourceMonitorOptions {
  intervalMs?: number;
  /** Bound on retained samples (oldest dropped and counted). */
  maxSamples?: number;
  /** perf_hooks event-loop sampling interval in ms. */
  resolutionMs?: number;
  /** A wall step larger than this between samples is a clock discontinuity. */
  clockJumpThresholdMs?: number;
}

const MB = 1024 * 1024;
const NS_PER_MS = 1e6;
const WINDOWS_TIMER_CAVEAT =
  "Windows timer granularity (~15.6 ms) dominates event-loop delay and paced replay timing on this host; use Linux for these measurements.";

function readCgroupThrottle(): { periods: number; usec: number } | null {
  try {
    const text = fs.readFileSync("/sys/fs/cgroup/cpu.stat", "utf8");
    const get = (k: string): number | null => {
      const m = new RegExp(`^${k} (\\d+)$`, "m").exec(text);
      return m ? Number(m[1]) : null;
    };
    const periods = get("nr_throttled");
    const usec = get("throttled_usec");
    return periods === null || usec === null ? null : { periods, usec };
  } catch {
    return null;
  }
}

export class ResourceMonitor {
  private readonly intervalMs: number;
  private readonly maxSamples: number;
  private readonly resolutionMs: number;
  private readonly clockJumpThresholdMs: number;
  private readonly rows: ResourceSample[] = [];
  private readonly discontinuities: ClockDiscontinuity[] = [];
  private samplesDropped = 0;
  private timer: NodeJS.Timeout | null = null;
  private intervalHist: IntervalHistogram | null = null;
  private wholeRunHist: IntervalHistogram | null = null;
  private gcObserver: PerformanceObserver | null = null;
  private lastElu: EventLoopUtilization | null = null;
  private lastCpu: NodeJS.CpuUsage | null = null;
  private lastMonoNs = 0n;
  private lastWallMs = 0;
  private startMonoNs = 0n;
  private gcCount = 0;
  private gcMajor = 0;
  private gcPauseMs = 0;
  private gcPauseMaxMs = 0;
  private gcTotalMajor = 0;
  private gcTotalPauseMs = 0;
  private gcMaxPauseMs = 0;
  private lastThrottle: { periods: number; usec: number } | null = null;
  private throttledTotalMs: number | null = null;

  constructor(options: ResourceMonitorOptions = {}) {
    this.intervalMs = options.intervalMs ?? 1_000;
    this.maxSamples = options.maxSamples ?? 86_400;
    this.resolutionMs = options.resolutionMs ?? 10;
    this.clockJumpThresholdMs = options.clockJumpThresholdMs ?? 50;
  }

  start(): void {
    if (this.timer) return;
    this.intervalHist = monitorEventLoopDelay({ resolution: this.resolutionMs });
    this.wholeRunHist = monitorEventLoopDelay({ resolution: this.resolutionMs });
    this.intervalHist.enable();
    this.wholeRunHist.enable();
    this.gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.gcCount++;
        this.gcPauseMs += entry.duration;
        if (entry.duration > this.gcPauseMaxMs) this.gcPauseMaxMs = entry.duration;
        if (entry.duration > this.gcMaxPauseMs) this.gcMaxPauseMs = entry.duration;
        this.gcTotalPauseMs += entry.duration;
        const kind = (entry as unknown as { detail?: { kind?: number } }).detail?.kind;
        if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) {
          this.gcMajor++;
          this.gcTotalMajor++;
        }
      }
    });
    try {
      this.gcObserver.observe({ entryTypes: ["gc"] });
    } catch {
      this.gcObserver = null; // GC entries unavailable on this runtime
    }
    this.lastElu = performance.eventLoopUtilization();
    this.lastCpu = process.cpuUsage();
    this.startMonoNs = this.lastMonoNs = process.hrtime.bigint();
    this.lastWallMs = Date.now();
    this.lastThrottle = readCgroupThrottle();
    if (this.lastThrottle) this.throttledTotalMs = 0;
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Takes one sample now. Called by the timer; callable directly for a final sample. */
  sample(): ResourceSample | null {
    if (!this.intervalHist || !this.lastElu || !this.lastCpu) return null;
    const monoNow = process.hrtime.bigint();
    const wallNow = Date.now();
    const monoDeltaMs = Number(monoNow - this.lastMonoNs) / NS_PER_MS;
    const wallDeltaMs = wallNow - this.lastWallMs;
    const jump = wallDeltaMs - monoDeltaMs;
    if (Math.abs(jump) > this.clockJumpThresholdMs) {
      this.discontinuities.push({ at_wall_ms: wallNow, wall_delta_ms: wallDeltaMs, mono_delta_ms: monoDeltaMs, jump_ms: jump });
    }

    const elu = performance.eventLoopUtilization(this.lastElu);
    this.lastElu = performance.eventLoopUtilization();
    const cpu = process.cpuUsage(this.lastCpu);
    this.lastCpu = process.cpuUsage();
    const mem = process.memoryUsage();
    const h = this.intervalHist;
    const hasDelay = h.count > 0;
    const beyond = (ns: number): number => Math.max(0, ns / NS_PER_MS - this.resolutionMs);
    const throttle = readCgroupThrottle();
    let throttledPeriods: number | null = null;
    let throttledMs: number | null = null;
    if (throttle && this.lastThrottle) {
      throttledPeriods = throttle.periods - this.lastThrottle.periods;
      throttledMs = (throttle.usec - this.lastThrottle.usec) / 1000;
      this.throttledTotalMs = (this.throttledTotalMs ?? 0) + throttledMs;
    }
    this.lastThrottle = throttle;

    const row: ResourceSample = {
      wall_ms: wallNow,
      mono_ns: monoNow.toString(),
      elapsed_ms: Number(monoNow - this.startMonoNs) / NS_PER_MS,
      event_loop_delay_p50_ms: hasDelay ? beyond(h.percentile(50)) : null,
      event_loop_delay_p99_ms: hasDelay ? beyond(h.percentile(99)) : null,
      event_loop_delay_max_ms: hasDelay ? beyond(h.max) : null,
      event_loop_utilization: elu.utilization,
      cpu_user_ms: cpu.user / 1000,
      cpu_system_ms: cpu.system / 1000,
      cpu_pct_of_one_core: monoDeltaMs > 0 ? ((cpu.user + cpu.system) / 1000 / monoDeltaMs) * 100 : 0,
      rss_mb: mem.rss / MB,
      heap_used_mb: mem.heapUsed / MB,
      heap_total_mb: mem.heapTotal / MB,
      external_mb: mem.external / MB,
      gc_count: this.gcCount,
      gc_major_count: this.gcMajor,
      gc_pause_ms: this.gcPauseMs,
      gc_pause_max_ms: this.gcPauseMaxMs,
      cgroup_throttled_periods: throttledPeriods,
      cgroup_throttled_ms: throttledMs,
    };
    h.reset();
    this.gcCount = 0;
    this.gcMajor = 0;
    this.gcPauseMs = 0;
    this.gcPauseMaxMs = 0;
    this.lastMonoNs = monoNow;
    this.lastWallMs = wallNow;

    if (this.rows.length >= this.maxSamples) {
      this.rows.shift();
      this.samplesDropped++;
    }
    this.rows.push(row);
    return row;
  }

  stop(): void {
    if (!this.timer) return;
    this.sample();
    clearInterval(this.timer);
    this.timer = null;
    this.intervalHist?.disable();
    this.wholeRunHist?.disable();
    this.gcObserver?.disconnect();
  }

  samples(): ResourceSample[] {
    return [...this.rows];
  }

  summary(): ResourceSummary {
    const rows = this.rows;
    const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const max = (xs: number[]): number | null => (xs.length ? Math.max(...xs) : null);
    const w = this.wholeRunHist;
    const hasDelay = !!w && w.count > 0;
    const beyond = (ns: number): number => Math.max(0, ns / NS_PER_MS - this.resolutionMs);
    return {
      samples: rows.length,
      interval_ms: this.intervalMs,
      event_loop_resolution_ms: this.resolutionMs,
      platform: process.platform,
      timer_caveat: process.platform === "win32" ? WINDOWS_TIMER_CAVEAT : null,
      event_loop_delay_ms: {
        p50: hasDelay ? beyond(w!.percentile(50)) : null,
        p90: hasDelay ? beyond(w!.percentile(90)) : null,
        p99: hasDelay ? beyond(w!.percentile(99)) : null,
        max: hasDelay ? beyond(w!.max) : null,
        mean: hasDelay ? beyond(w!.mean) : null,
      },
      event_loop_utilization_mean: mean(rows.map((r) => r.event_loop_utilization)),
      cpu_pct_of_one_core_mean: mean(rows.map((r) => r.cpu_pct_of_one_core)),
      cpu_pct_of_one_core_max: max(rows.map((r) => r.cpu_pct_of_one_core)),
      rss_mb_max: max(rows.map((r) => r.rss_mb)),
      heap_used_mb_max: max(rows.map((r) => r.heap_used_mb)),
      rss_mb_growth: rows.length >= 2 ? rows[rows.length - 1].rss_mb - rows[0].rss_mb : null,
      gc_major_count: this.gcTotalMajor,
      gc_pause_ms_total: this.gcTotalPauseMs,
      gc_pause_ms_max: this.gcMaxPauseMs,
      cgroup_throttled_ms_total: this.throttledTotalMs,
      clock_discontinuities: [...this.discontinuities],
      samples_dropped: this.samplesDropped,
    };
  }
}
