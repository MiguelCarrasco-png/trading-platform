# Adding a strategy

A strategy becomes launchable from the frontend by being listed, with a status, in
the strategy catalog. No frontend code is needed if it describes its parameters.

## The four edits

1. **Write the strategy** in `backend/src/strategies/<name>/`: a class extending
   `BaseStrategy` with `evaluate()` and a `static readonly VERSION`.
2. **Name the type**: add it to `StrategyType` in `backend/src/types/strategy.ts`
   (and `frontend/types/strategy.ts` so the frontend types agree).
3. **Write its manifest**: `backend/src/strategies/<name>/manifest.ts` exporting a
   `StrategyManifest` (type in `backend/src/config/strategyManifest.ts`).
4. **List it** in `backend/src/config/strategyCatalog.ts`.

The reference implementation is `backend/src/strategies/beginnerReversal/`.

## What the manifest declares

| Field | Purpose |
|---|---|
| `type`, `label`, `description` | Identity and picker text |
| `status` | `planned`, `ready` or `retired` (below) |
| `version` | `YourStrategy.VERSION`. Read it from the class so they cannot drift |
| `defaultConfig` | Fully-populated config that pre-fills a new configuration |
| `create(config)` | Builds the strategy from a saved config; fill missing fields from defaults here |
| `params` | Optional. Fields for the generic form (`number`, `text`, `symbols`, `boolean`). Omit for a strategy with a bespoke form, or one that should not be offered in the UI |

## Two things the manifest does not cover

- **Decision clock.** Declare `readonly triggers: readonly MarketEventKind[]` on the strategy
  (pairs trading and `beginnerReversal` use `["bar"]`). The orchestrator only calls
  `evaluate()` for those event kinds, live and in backtests. Omit it and the strategy is called on
  every quote, trade and bar, and must itself avoid counting one observation twice.
- **Backtesting.** Being `ready` makes a strategy launchable on paper; it does not make it
  backtestable. The backtest engine builds strategies from `BACKTESTABLE_TYPES` and
  `buildBacktestStrategies` in `backend/src/core/backtest/strategyFactory.ts`, which today
  only knows pairs trading.

## Status: a gate on new launches only

| Status | Picker | Save a config | Start / approve a run | Existing runs |
|---|---|---|---|---|
| `planned` | hidden | refused | refused | n/a |
| `ready` | shown (if it has `params`) | yes | yes | keep running |
| `retired` | hidden | refused | refused | **keep running, and are restored after a restart** |

The runtime never consults status when it rebuilds a persisted run. It resolves the
factory by type alone (`STRATEGY_FACTORY`, which includes every status), so changing a
strategy's status cannot interrupt or orphan anything that is already trading. Only
three places check it, all in the API: creating a config, starting a run, and approving
a proposal (`isLaunchable()` in `config/strategyDefaults.ts`).

`GET /api/strategies/configs/types` returns the `ready` types with their `params`; the
Strategies page builds its picker and form from that response.

## Why the catalog is in `config/`

`scripts/check-strategy-versions.mjs` fails CI when a file in
`backend/src/strategies/<dir>/` or `strategies/base/` changes without a `VERSION` bump.
A manifest is not algorithm behaviour, so the two older strategies (pairs trading,
minute reversal) are declared inline in `strategyCatalog.ts` rather than gaining a
manifest file that would force a bump. New strategies keep their manifest in their own
folder; it is part of their first version, so no bump is needed.

## What a planned strategy still costs

`planned` stops a strategy being launched, not compiled: its code is imported by the
catalog like any other, so a type error in it still breaks the build. Keep unfinished
work on a branch until it compiles.

## Tests to write

- A unit test for `evaluate()` (see `backend/src/tests/strategy/beginnerReversalStrategy.test.ts`).
- Nothing else is required for registration: the catalog test in
  `backend/src/tests/http/strategies.test.ts` covers the gate for every type.
