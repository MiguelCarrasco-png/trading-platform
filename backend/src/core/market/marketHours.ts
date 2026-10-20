/**
 * core/market/marketHours.ts
 *
 * Whether the equity market is open, for the risk engine's MARKET_CLOSED check.
 * A market order sent while the market is closed sits at the broker until the
 * open and fills at whatever price the open brings — never what the strategy
 * saw when it decided.
 *
 *   - regularSessionHours: NYSE regular session (09:30–16:00 America/New_York,
 *     weekdays). No holiday calendar, so it errs towards "open" on holidays.
 *   - AlpacaClockHours: follows Alpaca's /v2/clock, which knows holidays and
 *     early closes. Refreshed in the background; between refreshes it trusts the
 *     last reported window and falls back to the regular session past it.
 *   - alwaysOpen: for replayed sessions, whose bars are already in-session.
 */

import { logger } from "../../utils/logger";

export interface MarketHours {
  isOpen(ts: number): boolean;
}

export const alwaysOpen: MarketHours = { isOpen: () => true };

const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const OPEN_MINUTE = 9 * 60 + 30;
const CLOSE_MINUTE = 16 * 60;

export const regularSessionHours: MarketHours = {
  isOpen(ts: number): boolean {
    const parts = Object.fromEntries(NY_PARTS.formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
    if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    return minute >= OPEN_MINUTE && minute < CLOSE_MINUTE;
  },
};

const NY_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** New York wall-clock fields of an instant. */
function nyFields(ts: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const p = Object.fromEntries(NY_DATE.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

/** The instant at a New York wall-clock time on a calendar date (month 1-12; day may overflow). */
function nyWallTimeToMs(year: number, month: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Offset of New York from UTC at that instant; checked twice so a guess on
  // the far side of a DST switch still lands on the right wall time.
  const offsetAt = (utcMs: number) => {
    const f = nyFields(utcMs);
    return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) - utcMs;
  };
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

/**
 * The end of the regular session a DAY order placed at `ts` lives in: 16:00
 * New York time that day if it is a weekday not yet past the close, otherwise
 * the next weekday's. No holiday or early-close calendar, as in
 * regularSessionHours: a holiday's "close" passes with no bars after it.
 */
export function regularSessionCloseAfter(ts: number): number {
  const { year, month, day } = nyFields(ts);
  for (let offset = 0; offset < 8; offset++) {
    const weekday = new Date(Date.UTC(year, month - 1, day + offset)).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const close = nyWallTimeToMs(year, month, day + offset, 16, 0);
    if (close > ts) return close;
  }
  throw new Error(`no regular-session close found after ${new Date(ts).toISOString()}`);
}

export interface AlpacaClock {
  is_open: boolean;
  next_open: string;
  next_close: string;
}

export class AlpacaClockHours implements MarketHours {
  private open: boolean | null = null;
  /** Until when `open` holds: the next close while open, the next open while closed. */
  private validUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly fetchClock: () => Promise<AlpacaClock>,
    private readonly fallback: MarketHours = regularSessionHours,
  ) {}

  isOpen(ts: number): boolean {
    if (this.open !== null && ts < this.validUntil) return this.open;
    return this.fallback.isOpen(ts);
  }

  async refresh(): Promise<void> {
    try {
      const clock = await this.fetchClock();
      this.open = clock.is_open;
      this.validUntil = new Date(clock.is_open ? clock.next_close : clock.next_open).getTime();
    } catch (err) {
      logger.warn("AlpacaClockHours: clock refresh failed — using the regular session", { err: String(err) });
    }
  }

  /** Refreshes now, then every `intervalMs`. */
  async start(intervalMs = 60_000): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
