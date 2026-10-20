jest.mock('../../config/env', () => ({ env: { logLevel: 'error' } }));

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileTickCache, sortByTime } from '../../adapters/localfs/fileTickCache';
import { windowsCover } from '../../core/backtest/tickCache';

const T = Date.parse('2026-10-07T14:00:00Z');
const at = (offsetMs: number, extraNanos = '') =>
  new Date(T + offsetMs).toISOString().replace('Z', `${extraNanos}Z`);

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'tick-cache-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('windowsCover', () => {
  it('needs the union of windows to span the whole range', () => {
    expect(windowsCover([{ startMs: 0, endMs: 10 }], 2, 8)).toBe(true);
    expect(windowsCover([{ startMs: 5, endMs: 10 }, { startMs: 0, endMs: 5 }], 0, 10)).toBe(true);
    expect(windowsCover([{ startMs: 0, endMs: 4 }, { startMs: 5, endMs: 10 }], 0, 10)).toBe(false);
    expect(windowsCover([], 0, 10)).toBe(false);
    expect(windowsCover([], 5, 5)).toBe(true);
  });
});

describe('FileTickCache', () => {
  it('reads back exactly the records of a window it stored', async () => {
    const cache = new FileTickCache(root);
    const records = [{ t: at(1_000), bp: 1 }, { t: at(2_000), bp: 2 }];
    await cache.write('quotes', 'sip', 'SPY', T, T + 5_000, records);

    expect(await cache.read('quotes', 'sip', 'SPY', T, T + 5_000)).toEqual(records);
    expect(await cache.read('quotes', 'sip', 'SPY', T + 1_500, T + 5_000)).toEqual([records[1]]);
  });

  it('is a miss when any part of the range was never fetched, or for another feed or kind', async () => {
    const cache = new FileTickCache(root);
    await cache.write('quotes', 'sip', 'SPY', T, T + 5_000, [{ t: at(1_000) }]);
    expect(await cache.read('quotes', 'sip', 'SPY', T, T + 6_000)).toBeNull();
    expect(await cache.read('quotes', 'iex', 'SPY', T, T + 5_000)).toBeNull();
    expect(await cache.read('trades', 'sip', 'SPY', T, T + 5_000)).toBeNull();
  });

  it('serves a range from adjacent windows, a known-empty window included', async () => {
    const cache = new FileTickCache(root);
    await cache.write('trades', 'sip', 'SPY', T, T + 5_000, [{ t: at(4_000), p: 1 }]);
    await cache.write('trades', 'sip', 'SPY', T + 5_000, T + 10_000, []);
    expect(await cache.read('trades', 'sip', 'SPY', T, T + 10_000)).toEqual([{ t: at(4_000), p: 1 }]);
  });

  it('keeps one copy of a record stored by overlapping windows, in nanosecond order', async () => {
    const cache = new FileTickCache(root);
    const a = { t: at(1_000, '000700'), bp: 1 };
    const b = { t: at(1_000, '000050'), bp: 2 };
    await cache.write('quotes', 'sip', 'SPY', T, T + 2_000, [b, a]);
    await cache.write('quotes', 'sip', 'SPY', T + 500, T + 3_000, [b, a]);
    expect(await cache.read('quotes', 'sip', 'SPY', T, T + 3_000)).toEqual([b, a]);
  });

  it('finds windows written by another instance (another process) on disk', async () => {
    await new FileTickCache(root).write('quotes', 'sip', 'SPY', T, T + 5_000, [{ t: at(10) }]);
    expect(await new FileTickCache(root).read('quotes', 'sip', 'SPY', T, T + 5_000)).toEqual([{ t: at(10) }]);
  });

  it('treats a corrupt window file as uncached', async () => {
    const cache = new FileTickCache(root);
    await cache.write('quotes', 'sip', 'SPY', T, T + 5_000, [{ t: at(10) }]);
    const dir = path.join(root, 'sip', 'quotes', 'SPY', '2026-10-07');
    await fs.writeFile(path.join(dir, `${T}-${T + 5_000}.jsonl`), '{"t": broken\n');
    expect(await new FileTickCache(root).read('quotes', 'sip', 'SPY', T, T + 5_000)).toBeNull();
  });
});

describe('sortByTime', () => {
  it('orders by full precision even when trailing fraction digits are trimmed', () => {
    const recs = [{ t: '2026-10-07T14:00:00.1Z' }, { t: '2026-10-07T14:00:00Z' }, { t: '2026-10-07T14:00:00.000000001Z' }];
    expect(sortByTime(recs).map((r) => r.t)).toEqual([
      '2026-10-07T14:00:00Z', '2026-10-07T14:00:00.000000001Z', '2026-10-07T14:00:00.1Z',
    ]);
  });
});
