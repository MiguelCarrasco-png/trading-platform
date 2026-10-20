/**
 * adapters/localfs/fileTickCache.ts
 *
 * TickCache on local disk, under MARKET_DATA_DIR (default .local/marketdata,
 * which git ignores). Each fetched window is one file of raw Alpaca records,
 * one JSON object per line:
 *
 *   {root}/{feed}/{kind}/{SYMBOL}/{YYYY-MM-DD}/{startMs}-{endMs}.jsonl
 *
 * The window is the file name, so coverage needs no separate index. A file is
 * written under a temporary name and renamed into place, so a crash or a
 * concurrent writer never leaves a partial window that looks complete. JSON
 * lines keep the data readable from Python (pandas.read_json(..., lines=True)).
 *
 * Inputs:  Windows of raw records to store; windows to read back.
 * Outputs: Records in time order for windows the stored files cover.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { DAY_MS, utcDay, utcDaysInRange } from "../../core/backtest/barCache";
import { windowsCover, type TickCache, type TickWindow } from "../../core/backtest/tickCache";
import { rfc3339ToNanos } from "../../utils/time";
import { logger } from "../../utils/logger";
import type { HistoricalFeed, RawTick, TickKind } from "../../types/market";

interface StoredWindow extends TickWindow {
  file: string;
}

const WINDOW_FILE = /^(\d+)-(\d+)\.jsonl$/;

export class FileTickCache implements TickCache {
  private readonly root: string;
  /** Day directory → windows on disk, loaded on first use and kept current by write(). */
  private readonly index = new Map<string, StoredWindow[]>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async read(kind: TickKind, feed: HistoricalFeed, symbol: string, startMs: number, endMs: number): Promise<RawTick[] | null> {
    // A window is filed under the day it starts, so look one day back for any
    // window that crosses midnight UTC into this range.
    const windows: StoredWindow[] = [];
    for (const day of utcDaysInRange(startMs - DAY_MS, endMs)) {
      for (const w of await this._windows(this._dir(kind, feed, symbol, day))) {
        if (w.endMs > startMs && w.startMs < endMs) windows.push(w);
      }
    }
    if (!windowsCover(windows, startMs, endMs)) return null;

    const seen = new Set<string>();
    const records: RawTick[] = [];
    for (const w of windows) {
      let text: string;
      try {
        text = await fs.readFile(w.file, "utf8");
      } catch (err) {
        logger.warn("FileTickCache: window file unreadable — treating the range as uncached", { file: w.file, err: String(err) });
        return null;
      }
      for (const line of text.split("\n")) {
        if (line.length === 0 || seen.has(line)) continue;
        let record: RawTick;
        try {
          record = JSON.parse(line) as RawTick;
        } catch {
          logger.warn("FileTickCache: corrupt record — treating the range as uncached", { file: w.file });
          return null;
        }
        const ms = Date.parse(record.t);
        if (ms < startMs || ms >= endMs) continue;
        // Overlapping windows hold the same records; keep one of each.
        seen.add(line);
        records.push(record);
      }
    }
    return sortByTime(records);
  }

  async write(
    kind: TickKind, feed: HistoricalFeed, symbol: string, startMs: number, endMs: number, records: RawTick[],
  ): Promise<void> {
    const dir = this._dir(kind, feed, symbol, utcDay(startMs));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${startMs}-${endMs}.jsonl`);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
    await fs.rename(tmp, file);
    const known = this.index.get(dir);
    if (known && !known.some((w) => w.file === file)) known.push({ startMs, endMs, file });
  }

  private _dir(kind: TickKind, feed: HistoricalFeed, symbol: string, day: string): string {
    return path.join(this.root, feed, kind, symbol.replace(/[^A-Za-z0-9._-]/g, "_"), day);
  }

  private async _windows(dir: string): Promise<StoredWindow[]> {
    const known = this.index.get(dir);
    if (known) return known;
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      // No directory yet: nothing cached for this day.
    }
    const windows: StoredWindow[] = [];
    for (const name of names) {
      const match = WINDOW_FILE.exec(name);
      if (match) windows.push({ startMs: Number(match[1]), endMs: Number(match[2]), file: path.join(dir, name) });
    }
    this.index.set(dir, windows);
    return windows;
  }
}

/** Orders records by their full-precision timestamp; ties keep their order. */
export function sortByTime<T extends { t: string }>(records: T[]): T[] {
  const keyed = records.map((r) => ({ r, ns: rfc3339ToNanos(r.t) }));
  keyed.sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0));
  return keyed.map((k) => k.r);
}
