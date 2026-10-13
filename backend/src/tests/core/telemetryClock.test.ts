/**
 * tests/core/telemetryClock.test.ts
 *
 * Timestamp precision and clock-domain rules for latency measurement:
 * sub-millisecond provider digits survive parsing, durations never mix clock
 * domains, and the fast parser agrees with the general one.
 */

import {
  ClockDomainError,
  CLOCK_DOMAIN_ID,
  durationNs,
  msToEpochNs,
  parseRfc3339Parts,
  parseRfc3339ToEpochNs,
  stampMono,
} from "../../core/telemetry/clock";
import { seededRandom } from "../../bench/random";

describe("parseRfc3339ToEpochNs", () => {
  it("keeps all nine fractional digits exactly", () => {
    expect(parseRfc3339ToEpochNs("2024-01-15T14:30:00.123456789Z")).toBe(1705329000123456789n);
  });

  it("distinguishes timestamps that differ only after the third fractional digit", () => {
    const a = parseRfc3339ToEpochNs("2026-03-10T14:30:00.199123456Z")!;
    const b = parseRfc3339ToEpochNs("2026-03-10T14:30:00.199123999Z")!;
    expect(b - a).toBe(543n);
    // Date drops them: the reason this parser exists.
    expect(Date.parse("2026-03-10T14:30:00.199123456Z")).toBe(Date.parse("2026-03-10T14:30:00.199123999Z"));
  });

  it("scales short fractions and truncates beyond nine digits", () => {
    expect(parseRfc3339ToEpochNs("2024-01-15T14:30:00.1Z")! % 1_000_000_000n).toBe(100_000_000n);
    expect(parseRfc3339ToEpochNs("2024-01-15T14:30:00.1234567891234Z")! % 1_000_000_000n).toBe(123_456_789n);
    expect(parseRfc3339ToEpochNs("2024-01-15T14:30:00Z")).toBe(msToEpochNs(Date.UTC(2024, 0, 15, 14, 30)));
  });

  it("applies numeric offsets", () => {
    expect(parseRfc3339ToEpochNs("2024-01-15T09:30:00.5-05:00")).toBe(parseRfc3339ToEpochNs("2024-01-15T14:30:00.5Z"));
    expect(parseRfc3339ToEpochNs("2024-01-15T16:00:00+01:30")).toBe(parseRfc3339ToEpochNs("2024-01-15T14:30:00Z"));
  });

  it.each([
    "not-a-time", "", "2024-02-30T00:00:00Z", "2024-13-01T00:00:00Z", "2024-01-15T24:00:00Z",
    "2024-01-15T14:30:00.Z", "2024-01-15T14:30:00.12a4Z", "2024-01-15 14:30", "2024-01-15T14:30:00",
  ])("rejects %p", (bad) => {
    expect(parseRfc3339ToEpochNs(bad)).toBeNull();
    expect(parseRfc3339Parts(bad)).toBeNull();
  });

  it("fast path agrees with the general path across many timestamps", () => {
    const rand = seededRandom(7);
    for (let i = 0; i < 2_000; i++) {
      const ms = Date.UTC(2020, 0, 1) + Math.floor(rand() * 2e11);
      const digits = 1 + Math.floor(rand() * 9);
      const frac = String(Math.floor(rand() * 10 ** digits)).padStart(digits, "0");
      const zulu = new Date(ms).toISOString().replace(/\.\d{3}Z$/, `.${frac}Z`);
      const lower = zulu.replace("Z", "z"); // lower-case z takes the general path
      expect(parseRfc3339ToEpochNs(zulu)).toBe(parseRfc3339ToEpochNs(lower));
    }
  });

  it("splits into exact millisecond and sub-millisecond parts", () => {
    const p = parseRfc3339Parts("2026-03-10T14:30:00.199123456Z")!;
    expect(p.epochMs).toBe(Date.UTC(2026, 2, 10, 14, 30, 0, 199));
    expect(p.subMsNs).toBe(123_456);
  });
});

describe("monotonic durations", () => {
  it("subtracts readings from the same clock domain as integers", () => {
    const a = stampMono();
    const b = { domain: CLOCK_DOMAIN_ID, ns: a.ns + 9_007_199_254_740_993n }; // beyond 2^53
    expect(durationNs(a, b)).toBe(9_007_199_254_740_993n);
  });

  it("refuses to subtract readings from different processes or boots", () => {
    const a = stampMono();
    const b = { domain: "other-host:boot:1:abc", ns: a.ns + 1n };
    expect(() => durationNs(a, b)).toThrow(ClockDomainError);
  });
});
