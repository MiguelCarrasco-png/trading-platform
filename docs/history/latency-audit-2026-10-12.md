# Latency audit and benchmark implementation — 2026-10-12

Point-in-time record for [the agent guide](../guides/LATENCY_BENCHMARK_AGENT_GUIDE.md)'s
Ticket A, plus what was built for Tickets B–I and what is still outstanding.
How to run everything: [guides/latency-benchmark.md](../guides/latency-benchmark.md).

- **Inspected commit:** `f2e3ce6` (branch `JC`), clean working tree before these changes.
- **Measured on:** a Windows 11 desktop (Ryzen 7 3700X, 16 GB, Node 25.2) with
  **synthetic** input only. Every number below is indicative of processing cost
  on that machine. None is a live, AWS or Alpaca measurement.

## 1. Guide §3 observations, rechecked

| Observation | Holds? | Evidence |
|---|---|---|
| Adapter subscribes to quotes, trades and bars | Yes | `marketData.ts` `subscribe()` sends all three |
| Orchestrator evaluates every strategy on every quote/trade/bar | Yes | `_onQuote/_onTrade/_onBar` → `_evaluateStrategies` |
| Event bus is synchronous; a slow handler delays the next frame | Yes | `EventBus.publish` loops handlers inline |
| `ts` is ms, `isoTs` keeps the string; no receipt-to-order tracing existed | Yes | `normalizer.ts`; nothing stamped receipt |
| Quote normalizer modelled one `exchange` field; sizes unit unclear | Yes | Alpaca sends `bx`/`ax`, not `x`; docs state quote sizes are **round lots** |
| Bars overwrite `latestMid` with the close | Yes | `SymbolStateManager.onBar` |
| Awaited journal write before every broker call | Yes | `JournaledExecutionSink` (fail-closed) |
| Backtest factory registers only `pairs_trading` | Yes | `core/backtest/strategyFactory.ts` (the runtime factory also has `minute_reversal`) |
| Replay components are bar/event replays, not recorded frame replay | Yes | `ReplayEngine` (events), `ReplayBarFeed` (cached bars) |
| Production colocates api, paper-trading and a 1-CPU backtest worker | Yes | `deploy/docker-compose.prod.yml` |
| Local default is `EXECUTION_TARGET=sim` | Yes | `config/env.ts`, `docker-compose.dev.yml` |

## 2. What existed vs. what was missing (before)

| Capability | Before | Now |
|---|---|---|
| Receipt stamping, frame/epoch identity | none | `AlpacaMarketDataAdapter` (optional, `options.probe/observers`) |
| Stage timing and correlation | none | `core/telemetry/latencyProbe.ts`; orchestrator `options.probe`; order-path decorators |
| Bounded histograms | none | `core/telemetry/histogram.ts` (fixed memory, mergeable) |
| Provider-time precision | `Date` (ms) only | `core/telemetry/clock.ts` keeps all 9 digits |
| Data validation / quarantine | none | `validateRaw*` in the normalizer; opt-in `invalidData: "quarantine"` |
| Raw frame recording | none | `core/telemetry/frameRecorder.ts` (bounded, hashed, loss-accounted) |
| Recorded frame replay with pacing | none | `bench/processingReplay.ts` through the real adapter path |
| Strategy delay/cost simulation | none | `bench/delaySimulator.ts` |
| Resource sampling | none | `core/telemetry/resourceMonitor.ts` |
| Run manifest, report | none | `bench/manifest.ts`, `bench/report.ts` |
| Paper-order probe | none | `bench/paperProbe.ts` (gated) |

Behaviour with instrumentation **off** (the default everywhere) is unchanged. A
test asserts the adapter publishes identical events with and without a probe.
Another asserts the engine makes identical decisions under every
instrumentation level.

## 3. Changes to existing code

All are small and default-off:

- `types/events.ts`: optional `trace` on events (JSON-safe; strategies never read it).
- `types/market.ts`: optional `bidExchange`, `askExchange`, `tape` on `Quote`; size-unit doc; `MarketDataIssue` type.
- `adapters/alpaca/normalizer.ts`: keeps `bx`/`ax`/`z`; `NORMALIZER_VERSION`, `QUOTE_SIZE_UNIT`; validators.
- `adapters/alpaca/marketData.ts`: optional probe/observers/URL/quarantine. `ingestFrame()` for replay. Records lifecycle (incl. the server's subscription ack, previously ignored). **Fix:** a frame that parsed to a non-array, or an array with `null` elements, threw inside the socket callback; it is now counted and skipped.
- `adapters/alpaca/orderExecution.ts`: optional `onTradeUpdate` receipt hook (sees `new`/`accepted` acks, which never reach the bus).
- `core/engine/orchestrator.ts`: optional `probe`. Carries `trace` from market event → signal → intent. Times state/evaluate (stage detail) and the risk path.
- `runtime/bootstrap.ts`, `config/env.ts`: `LATENCY_PROBE=1` attaches instrumentation to the runner's own stream (no second connection).

## 4. Findings with evidence

Ordered by the guide's §17 priority. None is fixed in this change: the guide asks
for one material change at a time against a preserved baseline.

1. **One-sided IEX quotes become prices (correctness, priority 1).** IEX sends
   quotes with `bp` or `ap` = 0. They normalize to a mid of about half the
   price, which then marks positions (`portfolioState.updatePrice`) and can trip
   drawdown checks. The validator classifies them as `ONE_SIDED_QUOTE`.
   `invalidData: "quarantine"` drops them, but it is **not enabled** in the
   runtime. Recommended next step: count them in a live capture
   (`issues.quote.ONE_SIDED_QUOTE`), then enable quarantine as its own versioned
   change.
2. **Unparseable timestamps can wedge rolling windows (correctness).** A quote
   with a bad `t` gets `ts = NaN`. `RollingTimeWindow.evict` cannot order `NaN`,
   so the item is never evicted cleanly. Quarantine also prevents this.
3. **A full portfolio snapshot on every market event (priority 3).**
   `_proactivePortfolioCheck` calls `portfolioState.getSnapshot()` per
   quote/trade/bar. That builds every position, an ISO timestamp and a UUID.
   CPU profile of the uninstrumented engine on synthetic quotes: `getSnapshot`
   is **18%** of busy CPU and UUID generation **12%**. Cheaper alternatives (a
   numeric equity check, or a snapshot without id/ISO fields) should be measured
   with `bench replay` before and after.
4. **Strategies are re-sorted on every event (priority 3).**
   `_evaluateStrategies` copies and sorts the registry each call (21% inclusive,
   including the evaluation itself). It scales with strategy count: 20
   `quote_imbalance` instances cut synthetic throughput from ~40k to ~15k
   frames/s.
5. **Rolling-window eviction copies arrays (priority 3).** `evict()` uses
   `slice`, an O(window) copy per evicting push. It is small at synthetic rates
   (2%); re-measure with real symbol counts.
6. **Not consumed downstream (information, not a bug):** trade corrections `c`,
   cancels/errors `x`, updated bars `u`, statuses `s` and LULD `l` arrive (the
   first two are subscribed automatically with trades) and are now counted as
   `messages.unhandled.*`. Late-trade bar revisions (`u`) are why a minute bar's
   close can differ from the revision.

Instrumentation overhead (A/A, 5 interleaved repetitions, maximum throughput):
counters-only about 9% (2 µs/frame) and the intended sampled config about 12%
(3 µs/frame). On this desktop that is inside the run-to-run spread (13–25%), so
it is **not established** against the provisional 5% gate. Re-run
`bench fixture` / `bench replay --overhead` on the Linux target. At live IEX
frame rates, 3 µs per frame is negligible against a 10 ms budget, but that is an
inference, not a measurement.

Synthetic processing (one strategy, null sink, max throughput): frame
receive-to-done p99 about 0.11 ms; in-memory receive-to-submit p95 about
0.16 ms (n = 240, so no p99). These say nothing about Supabase journal latency,
Alpaca REST latency or live event age, which need the steps below.

## 5. Ticket status

| Ticket | Status |
|---|---|
| A audit | This document |
| B trace context and metrics | Done (frame and stage detail levels; A/A tested) |
| C normalization fidelity | Done (validation, venues, units documented, precise time); quarantine available but not enabled in the runtime |
| D bounded recorder | Done (rotation, hashes, gaps, disk caps, truncated-tail handling, redaction) |
| E replay and load generator | Done (max/paced/burst, lateness, coordinated omission, null and sim sinks, determinism checksums) |
| F delay simulator | Done (plan-gated, splits, ledger, empirical delays) |
| G runtime health and AWS baseline | Code done (monitor, manifest incl. EC2/cgroup/clock); **AWS runs not yet done** |
| H bounded paper probe | Code done and gated; **not run** (needs a dedicated paper account during market hours) |
| I evidence-based optimization | **Not started by design.** Findings 1–5 are candidates once live/AWS baselines exist |

## 6. Outstanding external prerequisites

1. A market-hours `bench capture` with personal data keys (SPY/QQQ first, then
   wider), checking `issues.*`, event ages and acknowledged subscriptions.
2. Replay of that capture, locally and on the EC2 host (contended and idle).
   `bench report --compare` across them.
3. A `LATENCY_PROBE=1` window on a runner, to measure the real Supabase journal
   and Alpaca paths.
4. Optionally `bench paper` on a dedicated paper account.
5. `bench delay` with a predeclared plan on real captures (development split
   first; evaluation once).
