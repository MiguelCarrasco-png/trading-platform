/**
 * tests/core/frameRecorder.test.ts
 *
 * The bounded market-data recorder (guide §8, Ticket D): round trip with
 * hashes, documented truncated-tail handling, overflow and disk-cap
 * accounting with sequence gaps, low-disk refusal, rotation, secret
 * redaction, and immutability of an existing recording.
 */

import fs from "fs";
import os from "os";
import path from "path";
import {
  FrameRecorder,
  emptyReadReport,
  listSegments,
  readRecording,
  type RecordingRecord,
} from "../../core/telemetry/frameRecorder";
import type { InboundFrame } from "../../core/telemetry/latencyProbe";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rec-")); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const frame = (seq: number, text = `[{"T":"q","S":"SPY","bp":1,"ap":2,"bs":1,"as":1,"t":"2026-03-10T14:30:00Z","n":${seq}}]`): InboundFrame =>
  ({ epoch: 1, seq, rxWallMs: 1_000 + seq, rxMonoNs: BigInt(seq) * 1_000_000n, text });

async function readAll(dir: string): Promise<{ records: RecordingRecord[]; report: ReturnType<typeof emptyReadReport> }> {
  const report = emptyReadReport();
  const records: RecordingRecord[] = [];
  for await (const r of readRecording(dir, report)) records.push(r);
  return { records, report };
}

describe("FrameRecorder", () => {
  it("round-trips frames and lifecycle records with verified segment hashes", async () => {
    const rec = new FrameRecorder(tmp, "run-1", { limits: { minFreeBytes: 0 } });
    await rec.open();
    rec.onLifecycle({ kind: "authenticated", epoch: 1, wallMs: 1, monoNs: 5n });
    for (let i = 1; i <= 100; i++) rec.onFrame(frame(i));
    const index = await rec.close();
    expect(index.stats.complete).toBe(true);
    expect(index.stats.records_written).toBe(101);
    const { records, report } = await readAll(tmp);
    const frames = records.filter((r): r is Extract<RecordingRecord, { type: "frame" }> => r.type === "frame");
    expect(frames.map((f) => f.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(frames[41].data).toBe(frame(42).text);
    expect(frames[41].rx_mono_ns).toBe("42000000");
    expect(records.some((r) => r.type === "lifecycle" && r.kind === "authenticated")).toBe(true);
    expect(report.hashMismatches).toEqual([]);
    expect(report.truncatedTail).toBe(false);
  });

  it("reports a truncated final record (interrupted capture) and keeps everything before it", async () => {
    const rec = new FrameRecorder(tmp, "run-2", { limits: { minFreeBytes: 0 } });
    await rec.open();
    for (let i = 1; i <= 10; i++) rec.onFrame(frame(i));
    await rec.close();
    fs.rmSync(path.join(tmp, "recording-index.json"));
    const seg = path.join(tmp, listSegments(tmp)[0]);
    fs.appendFileSync(seg, '{"v":1,"type":"frame","epoch":1,"seq":11,"rx_wa');
    const { records, report } = await readAll(tmp);
    expect(report.truncatedTail).toBe(true);
    expect(report.corruptLines).toBe(0);
    expect(records.filter((r) => r.type === "frame")).toHaveLength(10);
  });

  it("counts a corrupt line that is not the final one", async () => {
    const rec = new FrameRecorder(tmp, "run-3", { limits: { minFreeBytes: 0 } });
    await rec.open();
    rec.onFrame(frame(1));
    await rec.close();
    const seg = path.join(tmp, listSegments(tmp)[0]);
    const lines = fs.readFileSync(seg, "utf8").split("\n");
    lines.splice(1, 0, "{oops");
    fs.writeFileSync(seg, lines.join("\n"));
    const { report } = await readAll(tmp);
    expect(report.corruptLines).toBe(1);
    expect(report.hashMismatches).toHaveLength(1); // the file no longer matches its index
  });

  it("drops on queue overflow without blocking, counts it, and writes the gap interval", async () => {
    const rec = new FrameRecorder(tmp, "run-4", { limits: { minFreeBytes: 0, maxQueueRecords: 5 } });
    await rec.open();
    for (let i = 1; i <= 50; i++) rec.onFrame(frame(i)); // synchronous burst: the writer cannot drain
    const index = await rec.close();
    expect(index.stats.records_dropped).toBeGreaterThan(0);
    expect(index.stats.complete).toBe(false);
    expect(index.stats.gaps.length).toBeGreaterThan(0);
    const g = index.stats.gaps[0];
    expect(g.reason).toBe("queue_overflow");
    expect(g.last_seq - g.first_seq + 1).toBe(g.count);
    const { records } = await readAll(tmp);
    const written = records.filter((r) => r.type === "frame").length;
    expect(written + index.stats.records_dropped).toBe(50);
    expect(records.some((r) => r.type === "gap")).toBe(true);
  });

  it("stops at the total byte cap and accounts for everything after it", async () => {
    const rec = new FrameRecorder(tmp, "run-5", { limits: { minFreeBytes: 0, maxTotalBytes: 2_000 } });
    await rec.open();
    for (let i = 1; i <= 40; i++) {
      rec.onFrame(frame(i));
      await new Promise((r) => setImmediate(r));
    }
    const index = await rec.close();
    expect(index.stats.state).toBe("stopped_disk_cap");
    expect(index.stats.bytes_written).toBeLessThanOrEqual(2_000);
    // Segment headers are not records; every observed frame is either written or a counted drop.
    expect(index.stats.records_written + index.stats.records_dropped).toBe(40);
    expect(index.stats.complete).toBe(false);
  });

  it("refuses to start below the free-disk floor and stops when space runs low", async () => {
    const tooFull = new FrameRecorder(tmp, "run-6", { limits: { minFreeBytes: 10_000 }, freeSpace: async () => 100 });
    await expect(tooFull.open()).rejects.toThrow(/bytes free/);

    let free = 1e9;
    const dir = path.join(tmp, "b");
    const rec = new FrameRecorder(dir, "run-7", { limits: { minFreeBytes: 10_000, maxSegmentBytes: 600 }, freeSpace: async () => free });
    await rec.open();
    for (let i = 1; i <= 5; i++) { rec.onFrame(frame(i)); await new Promise((r) => setImmediate(r)); }
    free = 10;
    for (let i = 6; i <= 30; i++) { rec.onFrame(frame(i)); await new Promise((r) => setImmediate(r)); }
    const index = await rec.close();
    expect(index.stats.state).toBe("stopped_low_disk");
    expect(index.stats.records_dropped).toBeGreaterThan(0);
  });

  it("rotates segments by size and reads them back in order", async () => {
    const rec = new FrameRecorder(tmp, "run-8", { limits: { minFreeBytes: 0, maxSegmentBytes: 1_000 } });
    await rec.open();
    for (let i = 1; i <= 40; i++) { rec.onFrame(frame(i)); await new Promise((r) => setImmediate(r)); }
    const index = await rec.close();
    expect(index.segments.length).toBeGreaterThan(3);
    for (const s of index.segments) expect(s.bytes).toBeLessThanOrEqual(1_000);
    const { records, report } = await readAll(tmp);
    expect(records.filter((r) => r.type === "frame").map((r) => (r as { seq: number }).seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(report.hashMismatches).toEqual([]);
  });

  it("never writes a frame that looks like it carries credentials", async () => {
    const rec = new FrameRecorder(tmp, "run-9", { limits: { minFreeBytes: 0 }, secretValues: ["PKSUPERSECRETVALUE"] });
    await rec.open();
    rec.onFrame(frame(1, '[{"action":"auth","key":"abc","secret":"def"}]'));
    rec.onFrame(frame(2, '[{"T":"error","msg":"bad key PKSUPERSECRETVALUE"}]'));
    rec.onFrame(frame(3));
    const index = await rec.close();
    expect(index.stats.records_redacted).toBe(2);
    const text = listSegments(tmp).map((f) => fs.readFileSync(path.join(tmp, f), "utf8")).join("");
    expect(text).not.toContain("PKSUPERSECRETVALUE");
    expect(text).not.toContain('"secret"');
  });

  it("refuses to overwrite an existing recording", async () => {
    const rec = new FrameRecorder(tmp, "run-10", { limits: { minFreeBytes: 0 } });
    await rec.open();
    await rec.close();
    await expect(new FrameRecorder(tmp, "run-11", { limits: { minFreeBytes: 0 } }).open()).rejects.toThrow(/immutable/);
  });
});
