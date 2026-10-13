/**
 * tests/adapters/normalizerValidation.test.ts
 *
 * Normalization fidelity (guide §4, Ticket C): per-side quote venues and tape
 * are kept, quote sizes are documented as round lots and passed through
 * unconverted, and every reject/flag rule has a case.
 */

import {
  NORMALIZER_VERSION,
  QUOTE_SIZE_UNIT,
  normalizeQuote,
  validateRawBar,
  validateRawQuote,
  validateRawTrade,
} from "../../adapters/alpaca/normalizer";

const T = "2026-03-10T14:30:00.123456789Z";
const quote = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ T: "q", S: "SPY", bx: "V", bp: 500, bs: 3, ax: "Q", ap: 500.02, as: 2, c: ["R"], z: "B", t: T, ...over });

describe("normalizeQuote fidelity", () => {
  it("keeps bid and ask venues, tape and the raw timestamp string", () => {
    const q = normalizeQuote(quote() as never);
    expect(q.bidExchange).toBe("V");
    expect(q.askExchange).toBe("Q");
    expect(q.tape).toBe("B");
    expect(q.isoTs).toBe(T);
  });

  it("passes round-lot sizes through unconverted; ratios are unit-free", () => {
    expect(QUOTE_SIZE_UNIT).toBe("round_lots");
    const q = normalizeQuote(quote({ bs: 3, as: 1 }) as never);
    expect(q.bidSize).toBe(3);
    expect(q.askSize).toBe(1);
    const scaled = normalizeQuote(quote({ bs: 300, as: 100 }) as never);
    expect(scaled.imbalance).toBeCloseTo(q.imbalance, 12);
    expect(scaled.microPrice).toBeCloseTo(q.microPrice, 12);
  });

  it("names its version", () => {
    expect(NORMALIZER_VERSION).toMatch(/^alpaca-stock-v2\/\d+$/);
  });
});

describe("validateRawQuote", () => {
  it.each([
    [{}, null],
    [{ bs: 0 }, { code: "ZERO_SIZE", severity: "flag" }],
    [{ bp: 500.01, ap: 500.01 }, { code: "LOCKED_QUOTE", severity: "flag" }],
    [{ bp: 500.05, ap: 500 }, { code: "CROSSED_QUOTE", severity: "reject" }],
    [{ ap: 0 }, { code: "ONE_SIDED_QUOTE", severity: "reject" }],
    [{ bp: 0 }, { code: "ONE_SIDED_QUOTE", severity: "reject" }],
    [{ bp: -1, ap: -1 }, { code: "NON_POSITIVE_PRICE", severity: "reject" }],
    [{ ap: undefined }, { code: "MISSING_FIELD", severity: "reject" }],
    [{ S: "" }, { code: "MISSING_FIELD", severity: "reject" }],
    [{ t: "yesterday" }, { code: "BAD_TIMESTAMP", severity: "reject" }],
    [{ bp: Number.NaN }, { code: "NON_FINITE_PRICE", severity: "reject" }],
    [{ bs: -1 }, { code: "NEGATIVE_SIZE", severity: "reject" }],
  ])("%j → %j", (over, expected) => {
    expect(validateRawQuote(quote(over))).toEqual(expected);
  });
});

describe("validateRawTrade / validateRawBar", () => {
  const trade = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ T: "t", S: "SPY", p: 500, s: 10, i: 1, t: T, ...over });
  const bar = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ T: "b", S: "SPY", o: 500, h: 501, l: 499, c: 500.5, v: 100, t: "2026-03-10T14:30:00Z", ...over });

  it("classifies trades", () => {
    expect(validateRawTrade(trade())).toBeNull();
    expect(validateRawTrade(trade({ s: 0 }))?.code).toBe("ZERO_SIZE");
    expect(validateRawTrade(trade({ p: 0 }))?.code).toBe("NON_POSITIVE_PRICE");
    expect(validateRawTrade(trade({ p: "abc" }))?.code).toBe("NON_FINITE_PRICE");
    expect(validateRawTrade(trade({ s: -5 }))?.code).toBe("NEGATIVE_SIZE");
  });

  it("classifies bars", () => {
    expect(validateRawBar(bar())).toBeNull();
    expect(validateRawBar(bar({ h: 499.5 }))?.code).toBe("INVALID_BAR_RANGE");
    expect(validateRawBar(bar({ l: 501 }))?.code).toBe("INVALID_BAR_RANGE");
    expect(validateRawBar(bar({ c: 0 }))?.code).toBe("NON_POSITIVE_PRICE");
    expect(validateRawBar(bar({ v: -1 }))?.code).toBe("NEGATIVE_SIZE");
    expect(validateRawBar(bar({ v: undefined }))?.code).toBe("MISSING_FIELD");
  });
});
