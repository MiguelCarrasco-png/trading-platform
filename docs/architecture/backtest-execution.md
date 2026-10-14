# Backtest decisions and fills

How a backtest decides when a strategy acts and what price its orders get.
Covers strategy triggers, the bar-completion clock, and the two execution
models (bar and quote).

## Decision clock: strategy triggers

A strategy declares which market events call its `evaluate()`:

```ts
readonly triggers: readonly ("bar" | "quote" | "trade")[] = ["bar"];
```

The orchestrator skips every other event kind for that strategy, live and in
backtests, so both sample the market the same way. Every event still updates
symbol state, so a bar strategy can read the latest quote. A strategy that
declares no triggers is called on every quote, trade and bar, and must guard
against counting one observation twice itself.

`PairsStrategy` triggers on bars. It takes one observation per minute, from
both legs' completed bars (their closes), and only when both legs printed a bar
that minute. Live, the two bars arrive in separate messages in either order, so
the minute is scored when the second one arrives, and never twice.

## When decisions happen

A bar is stamped with the start of its interval, so the 10:00 bar's close is
only known at 10:01. The backtest processes each batch of same-minute bars at
its **end** (`barEndMs`). Strategies, risk checks and new orders all see that
time. Staleness checks measure from when the reference price became known:
`SymbolState.latestMidTs` holds a quote's time, or a bar's end when a bar close
set the mid. A bar close never overwrites a fresher quote mid.

`BACKTEST_ENGINE_VERSION` records these semantics. It is stamped on every queued
config and result, and it is part of the dedup fingerprint, so results produced
under older semantics are never reused.

## Execution models

| | Bar model (default) | Quote model |
|---|---|---|
| Price | Next bar's open ± `halfSpreadBps` ± `slippageBps` | The real bid/ask prevailing when the order reaches the market |
| Timing | Next bar's open | Decision time + `latencyMs` |
| Data | Minute bars only | Historical SIP quotes and trades, a few seconds per order |
| Limit orders | Synthetic touch check at the next open | Marketable on arrival: fill at the touch. Otherwise IOC/FOK expires and DAY/GTC rests until a trade prints *through* the price |
| Stops | Treated as market orders (known gap) | Fall back to the bar model, flagged |

Under both models, an order only fills against a bar that ends after the order
was placed. Engine v1 could fill an order for a symbol published later in the
same batch at that symbol's same-minute open, which is before the decision.

### Quote model details (`core/execution/quoteFillModel.ts`)

- **Arrival.** The order reaches the market `latencyMs` after the decision. It
  trades against the last quote at or before arrival, if that quote is no older
  than `quoteLookbackMs`. Otherwise it trades against the first quote within
  `maxQuoteWaitMs` after arrival.
- **Fill size.** A marketable order fills in full at the touch. Displayed size
  and queue position are not modelled; the club's order sizes are small next to
  the displayed size of liquid names. `extraSlippageBps` adds adverse slippage
  but never pushes the price past a limit.
- **Resting limits.** These are checked minute by minute during the regular
  session. Trades are fetched only for minutes whose bar range reached through
  the limit. A resting limit fills at its limit price, up to the size printed
  through it. A print exactly at the limit is not a fill.
- **DAY orders.** As in the bar model, DAY orders are not expired at the close.
  They rest until filled, canceled, or the run ends.
- **Fallback.** If no usable quote is found, or Alpaca refuses the data, the
  order is priced by the bar model at the next open. The fill records
  `fallbackReason`. The free plan cannot read SIP data from the last 15
  minutes, so a backtest ending "now" falls back for its final orders.

The engine stays synchronous where events are published. Between timestamp
batches it awaits the quote windows it needs (`planArrivals`, `planResting`),
then publishes each decision at its own time.

## Using it

Ask for quote fills per backtest with `execution` in `POST /api/backtests/run`:

```json
{
  "strategyConfig": { "type": "pairs_trading", "symbols": ["SPY", "QQQ"] },
  "startDate": "2026-10-12T13:30:00Z",
  "endDate": "2026-10-13T20:00:00Z",
  "execution": { "model": "quote", "latencyMs": 250 }
}
```

Omitted fields take defaults: 250 ms latency, 5 s lookback, 5 s wait, 0 bps
extra slippage, SIP feed. `latencyMs + maxQuoteWaitMs` may not exceed 30 s.

To check the model against reality, use `POST /api/runs/:runId/compare-backtest`
with the same `execution` body. That replays a live paper run's window with
quote fills, kept separate from the bar-model comparison. Compare its fill
prices with the run's actual Alpaca fills to calibrate `latencyMs`.

### What a result reports

- Each fill carries `source` (`quote`, `trade` or `bar`), `arrivalBid`/
  `arrivalAsk`, `decisionMid`, and `fallbackReason` where relevant. These fields
  are kept in staged results and API responses; `backtest_fills` has fixed
  columns, so they are dropped on save.
- `metrics.meta.execution` is persisted. It holds the effective settings, fill
  counts by source, fallbacks by reason, and the notional-weighted
  `avgSpreadCostBps` (fill vs arrival mid) and `avgDelayCostBps` (mid move from
  decision to arrival, against the order).

## Data and cache

`AlpacaHistoricalClient` (`adapters/alpaca/historicalData.ts`) pages Alpaca's
`/quotes` and `/trades` endpoints on an explicit feed. A per-process rate limiter
spaces the requests (`ALPACA_DATA_REQUESTS_PER_MINUTE`, default 190 of the free
plan's 200), using the real clock.

Fetched windows are cached as JSON lines under `MARKET_DATA_DIR` (default
`.local/marketdata`, gitignored):

```
{feed}/{quotes|trades}/{SYMBOL}/{YYYY-MM-DD}/{startMs}-{endMs}.jsonl
```

Files hold Alpaca's raw records and are readable from Python
(`pandas.read_json(path, lines=True)`). Order ticks with `rfc3339ToNanos`;
Alpaca trims trailing fraction digits, so the timestamp strings do not sort.

Cost: about one request per order on the first run, then nothing. In one
measurement, 186 orders over two SPY/QQQ sessions took about 60 s to fetch at the
free rate limit. A re-run took under a second.

## Not covered yet

- Strategies triggered by quotes or trades in backtests. That needs every quote
  and trade replayed through the engine, not sparse windows: millions of events
  per liquid symbol-day. It also needs an O(1) rolling window, because
  `RollingTimeWindow` copies its array on every eviction.
- Stop orders (both models) and DAY expiry at the close.
- The local `sim` runtime still uses the bar model on live bars.
