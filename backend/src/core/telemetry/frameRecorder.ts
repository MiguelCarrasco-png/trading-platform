/**
 * core/telemetry/frameRecorder.ts
 *
 * Bounded, append-only NDJSON recorder for inbound market-data frames, plus
 * the matching reader. A recording is what processing and strategy replay run
 * on, so it keeps the raw frame text, its receive clocks and its connection
 * epoch — never a re-serialized normalized event.
 *
 * Bounded by construction: a fixed-capacity in-memory queue drained by one
 * async writer, size-rotated segments, a total byte cap and a free-disk floor.
 * When a limit is hit the recorder drops (never blocks the event loop), counts
 * every dropped record, notes the dropped frame-sequence interval, and marks
 * the dataset incomplete. Recording is optional research data: its failure
 * never touches trading.
 *
 * Crash semantics (documented contract):
 *   queued   — accepted into memory; lost on crash.
 *   written  — handed to the OS (stream write); usually survives a process
 *              crash, not a power loss.
 *   durable  — only segments listed in recording-index.json with a sha256,
 *              written by close(), are complete and verified.
 * A crash can leave a final partial line; the reader reports it as
 * truncatedTail and stops there. Corrupt lines elsewhere are counted.
 *
 * Only inbound frames are observed (the adapter never shows observers the
 * outbound auth frame). As a second guard, any frame that looks like it carries
 * a key or secret, or contains a configured secret value, is replaced by a
 * redaction marker.
 *
 * Inputs:  InboundFrame / StreamLifecycleEvent from the market-data adapter.
 * Outputs: <dir>/frames-NNNNNN.ndjson segments and <dir>/recording-index.json.
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { createHash, type Hash } from "crypto";
import { CLOCK_DOMAIN_ID } from "./clock";
import type { InboundFrame, MarketDataObserver, StreamLifecycleEvent } from "./latencyProbe";

export const RECORDING_FORMAT = "shpe-md-recording/1";
export const RECORDING_INDEX_FILE = "recording-index.json";

export interface RecorderLimits {
  /** Records waiting for the writer. */
  maxQueueRecords: number;
  /** Bytes waiting for the writer. */
  maxQueueBytes: number;
  /** A segment is rotated before exceeding this size. */
  maxSegmentBytes: number;
  /** Recording stops (and drops) once this many bytes are written. */
  maxTotalBytes: number;
  /** Recording stops when the filesystem has less than this free. */
  minFreeBytes: number;
}

export const DEFAULT_RECORDER_LIMITS: RecorderLimits = {
  maxQueueRecords: 50_000,
  maxQueueBytes: 64 * 1024 * 1024,
  maxSegmentBytes: 64 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  minFreeBytes: 1024 * 1024 * 1024,
};

export type RecorderState = "idle" | "open" | "stopped_disk_cap" | "stopped_low_disk" | "failed" | "closed";

export interface RecordingGap {
  first_seq: number;
  last_seq: number;
  count: number;
  reason: string;
}

export interface RecorderStats {
  state: RecorderState;
  failure: string | null;
  frames_received: number;
  lifecycle_received: number;
  records_written: number;
  records_dropped: number;
  records_redacted: number;
  bytes_written: number;
  queue_high_water_records: number;
  queue_high_water_bytes: number;
  gaps: RecordingGap[];
  gaps_truncated: number;
  /** False whenever anything observed was not written. */
  complete: boolean;
}

export interface SegmentInfo {
  file: string;
  bytes: number;
  records: number;
  sha256: string;
  first_seq: number | null;
  last_seq: number | null;
}

export interface RecordingIndex {
  format: string;
  run_id: string;
  clock_domain_id: string;
  created_wall_ms: number;
  closed_wall_ms: number;
  segments: SegmentInfo[];
  stats: RecorderStats;
  crash_semantics: string;
  limitations: string[];
}

export type RecordingRecord =
  | { v: 1; type: "header"; format: string; run_id: string; segment: number; clock_domain_id: string; created_wall_ms: number }
  | { v: 1; type: "frame"; epoch: number; seq: number; rx_wall_ms: number; rx_mono_ns: string; data: string }
  | { v: 1; type: "lifecycle"; epoch: number; kind: string; rx_wall_ms: number; rx_mono_ns: string; detail?: Record<string, unknown> }
  | { v: 1; type: "gap"; first_seq: number; last_seq: number; count: number; reason: string }
  | { v: 1; type: "redacted"; epoch: number; seq: number; rx_wall_ms: number; rx_mono_ns: string };

export type FrameRecord = Extract<RecordingRecord, { type: "frame" }>;

/** Filesystem free-space probe, injectable for tests. */
export type FreeSpaceProbe = (dir: string) => Promise<number | null>;

const defaultFreeSpace: FreeSpaceProbe = async (dir) => {
  try {
    const st = await fs.promises.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
};

const SECRET_SHAPE = /"(?:secret|key|secret_key|key_id)"\s*:/i;
const MAX_GAPS = 1_000;
const FREE_SPACE_CHECK_EVERY = 5_000;

interface QueuedLine {
  line: string;
  seq: number | null;
}

export class FrameRecorder implements MarketDataObserver {
  private state: RecorderState = "idle";
  private failure: string | null = null;
  private queue: QueuedLine[] = [];
  private queueBytes = 0;
  private pumping = false;
  private pumpDone: Promise<void> = Promise.resolve();

  private stream: fs.WriteStream | null = null;
  private hash: Hash | null = null;
  private segmentIndex = 0;
  private segmentBytes = 0;
  private segmentRecords = 0;
  private segmentFirstSeq: number | null = null;
  private segmentLastSeq: number | null = null;
  private readonly segments: SegmentInfo[] = [];

  private framesReceived = 0;
  private lifecycleReceived = 0;
  private recordsWritten = 0;
  private recordsDropped = 0;
  private recordsRedacted = 0;
  private bytesWritten = 0;
  private highWaterRecords = 0;
  private highWaterBytes = 0;
  private readonly gaps: RecordingGap[] = [];
  private gapsTruncated = 0;
  /** A drop interval not yet written into the file as a gap record. */
  private pendingGap: RecordingGap | null = null;
  private readonly createdWallMs = Date.now();
  private readonly limits: RecorderLimits;
  private readonly secretValues: string[];
  private readonly freeSpace: FreeSpaceProbe;

  constructor(
    readonly dir: string,
    private readonly runId: string,
    options: { limits?: Partial<RecorderLimits>; secretValues?: string[]; freeSpace?: FreeSpaceProbe } = {},
  ) {
    this.limits = { ...DEFAULT_RECORDER_LIMITS, ...options.limits };
    this.secretValues = (options.secretValues ?? []).filter((v) => v.length >= 8);
    this.freeSpace = options.freeSpace ?? defaultFreeSpace;
  }

  /** Creates the directory and first segment. Refuses an existing recording. */
  async open(): Promise<void> {
    if (this.state !== "idle") throw new Error(`FrameRecorder.open: already ${this.state}`);
    await fs.promises.mkdir(this.dir, { recursive: true });
    if (fs.existsSync(path.join(this.dir, RECORDING_INDEX_FILE)) || fs.existsSync(this._segmentPath(1))) {
      throw new Error(`FrameRecorder.open: ${this.dir} already holds a recording; recordings are immutable`);
    }
    const free = await this.freeSpace(this.dir);
    if (free !== null && free < this.limits.minFreeBytes) {
      throw new Error(`FrameRecorder.open: only ${free} bytes free (< ${this.limits.minFreeBytes})`);
    }
    this.state = "open";
    this._openSegment();
  }

  onFrame(frame: InboundFrame): void {
    this.framesReceived++;
    let line: string;
    if (this._looksSecret(frame.text)) {
      this.recordsRedacted++;
      line = JSON.stringify({
        v: 1, type: "redacted", epoch: frame.epoch, seq: frame.seq,
        rx_wall_ms: frame.rxWallMs, rx_mono_ns: frame.rxMonoNs.toString(),
      }) + "\n";
    } else {
      line = JSON.stringify({
        v: 1, type: "frame", epoch: frame.epoch, seq: frame.seq,
        rx_wall_ms: frame.rxWallMs, rx_mono_ns: frame.rxMonoNs.toString(), data: frame.text,
      }) + "\n";
    }
    this._enqueue(line, frame.seq);
  }

  onLifecycle(event: StreamLifecycleEvent): void {
    this.lifecycleReceived++;
    this._enqueue(JSON.stringify({
      v: 1, type: "lifecycle", epoch: event.epoch, kind: event.kind,
      rx_wall_ms: event.wallMs, rx_mono_ns: event.monoNs.toString(),
      ...(event.detail ? { detail: event.detail } : {}),
    }) + "\n", null);
  }

  stats(): RecorderStats {
    return {
      state: this.state,
      failure: this.failure,
      frames_received: this.framesReceived,
      lifecycle_received: this.lifecycleReceived,
      records_written: this.recordsWritten,
      records_dropped: this.recordsDropped,
      records_redacted: this.recordsRedacted,
      bytes_written: this.bytesWritten,
      queue_high_water_records: this.highWaterRecords,
      queue_high_water_bytes: this.highWaterBytes,
      gaps: [...this.gaps],
      gaps_truncated: this.gapsTruncated,
      complete: this.recordsDropped === 0 && this.failure === null,
    };
  }

  /** Drains the queue, finalizes the last segment and writes recording-index.json. */
  async close(): Promise<RecordingIndex> {
    if (this.state === "idle") throw new Error("FrameRecorder.close: never opened");
    await this.pumpDone;
    this._flushPendingGapIntoQueue();
    if (this.queue.length > 0 && this.state === "open") await this._drainAll();
    await this._closeSegment();
    if (this.state === "open") this.state = "closed";
    const index: RecordingIndex = {
      format: RECORDING_FORMAT,
      run_id: this.runId,
      clock_domain_id: CLOCK_DOMAIN_ID,
      created_wall_ms: this.createdWallMs,
      closed_wall_ms: Date.now(),
      segments: [...this.segments],
      stats: this.stats(),
      crash_semantics:
        "Segments listed here were flushed and hashed at close. A recording without this index " +
        "was interrupted; its last line may be partial (reader reports truncatedTail).",
      limitations: [
        "Accounts only for frames this process received; it cannot prove the provider stream was complete.",
        "rx_mono_ns values are comparable only within clock_domain_id.",
      ],
    };
    await fs.promises.writeFile(path.join(this.dir, RECORDING_INDEX_FILE), JSON.stringify(index, null, 2) + "\n");
    return index;
  }

  // ------------------------------------------------------------------
  // Private
  // ------------------------------------------------------------------

  private _looksSecret(text: string): boolean {
    if (SECRET_SHAPE.test(text)) return true;
    for (const v of this.secretValues) if (text.includes(v)) return true;
    return false;
  }

  private _enqueue(line: string, seq: number | null): void {
    const bytes = Buffer.byteLength(line);
    const overCapacity =
      this.queue.length >= this.limits.maxQueueRecords || this.queueBytes + bytes > this.limits.maxQueueBytes;
    if (this.state !== "open" || overCapacity) {
      this._drop(seq, this.state === "open" ? "queue_overflow" : this.state);
      return;
    }
    this._flushPendingGapIntoQueue();
    this.queue.push({ line, seq });
    this.queueBytes += bytes;
    if (this.queue.length > this.highWaterRecords) this.highWaterRecords = this.queue.length;
    if (this.queueBytes > this.highWaterBytes) this.highWaterBytes = this.queueBytes;
    if (!this.pumping) {
      this.pumping = true;
      this.pumpDone = this._drainAll();
    }
  }

  private _drop(seq: number | null, reason: string): void {
    this.recordsDropped++;
    if (seq === null) return;
    const g = this.pendingGap;
    if (g && g.reason === reason && seq === g.last_seq + 1) {
      g.last_seq = seq;
      g.count++;
      return;
    }
    if (g) this._closeGap(g);
    this.pendingGap = { first_seq: seq, last_seq: seq, count: 1, reason };
  }

  private _closeGap(g: RecordingGap): void {
    if (this.gaps.length < MAX_GAPS) this.gaps.push({ ...g });
    else this.gapsTruncated++;
  }

  /** Writes the interval that was dropped as a gap record before the next accepted record. */
  private _flushPendingGapIntoQueue(): void {
    const g = this.pendingGap;
    if (!g) return;
    this.pendingGap = null;
    this._closeGap(g);
    if (this.state !== "open") return;
    const line = JSON.stringify({ v: 1, type: "gap", ...g }) + "\n";
    this.queue.push({ line, seq: null });
    this.queueBytes += Buffer.byteLength(line);
  }

  private async _drainAll(): Promise<void> {
    try {
      while (this.queue.length > 0 && this.state === "open") {
        const item = this.queue.shift()!;
        const bytes = Buffer.byteLength(item.line);
        this.queueBytes -= bytes;
        if (this.bytesWritten + bytes > this.limits.maxTotalBytes) {
          this._stop("stopped_disk_cap", item.seq);
          break;
        }
        if (this.segmentBytes > 0 && this.segmentBytes + bytes > this.limits.maxSegmentBytes) {
          await this._closeSegment();
          const free = await this.freeSpace(this.dir);
          if (free !== null && free < this.limits.minFreeBytes) {
            this._stop("stopped_low_disk", item.seq);
            break;
          }
          this._openSegment();
        }
        await this._write(item);
        if (this.recordsWritten % FREE_SPACE_CHECK_EVERY === 0) {
          const free = await this.freeSpace(this.dir);
          if (free !== null && free < this.limits.minFreeBytes) this._stop("stopped_low_disk", null);
        }
      }
    } catch (err) {
      this.failure = err instanceof Error ? err.message : String(err);
      this._stop("failed", null);
    } finally {
      this.pumping = false;
    }
  }

  private async _write(item: QueuedLine): Promise<void> {
    const stream = this.stream!;
    const bytes = Buffer.byteLength(item.line);
    const ok = stream.write(item.line);
    this.hash!.update(item.line, "utf8");
    this.segmentBytes += bytes;
    this.segmentRecords++;
    this.bytesWritten += bytes;
    this.recordsWritten++;
    if (item.seq !== null) {
      if (this.segmentFirstSeq === null) this.segmentFirstSeq = item.seq;
      this.segmentLastSeq = item.seq;
    }
    if (!ok) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = (): void => { stream.off("error", onError); resolve(); };
        const onError = (e: Error): void => { stream.off("drain", onDrain); reject(e); };
        stream.once("drain", onDrain);
        stream.once("error", onError);
      });
    }
    if (this.failure) throw new Error(this.failure);
  }

  /** Stops recording: everything queued, and everything that arrives later, is a counted drop. */
  private _stop(state: RecorderState, firstSeq: number | null): void {
    if (this.state === "open") this.state = state;
    if (firstSeq !== null) this._drop(firstSeq, state);
    for (const item of this.queue) this._drop(item.seq, state);
    this.queue = [];
    this.queueBytes = 0;
  }

  private _segmentPath(i: number): string {
    return path.join(this.dir, `frames-${String(i).padStart(6, "0")}.ndjson`);
  }

  private _openSegment(): void {
    this.segmentIndex++;
    this.segmentBytes = 0;
    this.segmentRecords = 0;
    this.segmentFirstSeq = null;
    this.segmentLastSeq = null;
    this.hash = createHash("sha256");
    const stream = fs.createWriteStream(this._segmentPath(this.segmentIndex), { flags: "wx" });
    stream.on("error", (err) => {
      this.failure = err.message;
      this._stop("failed", null);
    });
    this.stream = stream;
    const header = JSON.stringify({
      v: 1, type: "header", format: RECORDING_FORMAT, run_id: this.runId,
      segment: this.segmentIndex, clock_domain_id: CLOCK_DOMAIN_ID, created_wall_ms: Date.now(),
    }) + "\n";
    stream.write(header);
    this.hash.update(header, "utf8");
    this.segmentBytes += Buffer.byteLength(header);
    this.bytesWritten += Buffer.byteLength(header);
  }

  private async _closeSegment(): Promise<void> {
    const stream = this.stream;
    if (!stream || !this.hash) return;
    this.stream = null;
    await new Promise<void>((resolve) => {
      if (stream.destroyed) return resolve();
      stream.end(() => resolve());
      stream.once("error", () => resolve());
    });
    this.segments.push({
      file: path.basename(this._segmentPath(this.segmentIndex)),
      bytes: this.segmentBytes,
      records: this.segmentRecords,
      sha256: this.hash.digest("hex"),
      first_seq: this.segmentFirstSeq,
      last_seq: this.segmentLastSeq,
    });
    this.hash = null;
  }
}

// ------------------------------------------------------------------
// Reader
// ------------------------------------------------------------------

export interface RecordingReadReport {
  index: RecordingIndex | null;
  segmentsRead: number;
  records: number;
  /** The final line of the final segment was incomplete (an interrupted recording). */
  truncatedTail: boolean;
  /** Unparseable lines that were not the final line. */
  corruptLines: number;
  /** Segments whose sha256 did not match the index. */
  hashMismatches: string[];
}

/** Segment files of a recording, in order. */
export function listSegments(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => /^frames-\d{6}\.ndjson$/.test(f)).sort();
}

/**
 * Streams every record of a recording in written order. The report is filled
 * in as reading progresses and is final once iteration completes.
 */
export async function* readRecording(dir: string, report: RecordingReadReport): AsyncGenerator<RecordingRecord> {
  const indexPath = path.join(dir, RECORDING_INDEX_FILE);
  report.index = fs.existsSync(indexPath)
    ? (JSON.parse(await fs.promises.readFile(indexPath, "utf8")) as RecordingIndex)
    : null;
  const files = listSegments(dir);
  if (files.length === 0) throw new Error(`readRecording: no frames-*.ndjson segments in ${dir}`);
  const expected = new Map((report.index?.segments ?? []).map((s) => [s.file, s.sha256]));

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    const lastSegment = fi === files.length - 1;
    const hash = createHash("sha256");
    const input = fs.createReadStream(path.join(dir, file));
    input.on("data", (chunk) => hash.update(chunk));
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    let pending: string | null = null;
    for await (const line of rl) {
      if (pending !== null) {
        const rec = parseLine(pending);
        if (rec) { report.records++; yield rec; } else report.corruptLines++;
      }
      pending = line;
    }
    if (pending !== null && pending !== "") {
      const rec = parseLine(pending);
      if (rec) {
        report.records++;
        yield rec;
      } else if (lastSegment) {
        report.truncatedTail = true;
      } else {
        report.corruptLines++;
      }
    }
    report.segmentsRead++;
    const want = expected.get(file);
    if (want && want !== hash.digest("hex")) report.hashMismatches.push(file);
  }
}

export function emptyReadReport(): RecordingReadReport {
  return { index: null, segmentsRead: 0, records: 0, truncatedTail: false, corruptLines: 0, hashMismatches: [] };
}

function parseLine(line: string): RecordingRecord | null {
  try {
    const rec = JSON.parse(line) as RecordingRecord;
    return rec && rec.v === 1 && typeof rec.type === "string" ? rec : null;
  } catch {
    return null;
  }
}
