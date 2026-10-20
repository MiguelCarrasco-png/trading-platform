# Lesson steps: build and launch your first strategy

You will write a tiny trading strategy, release it, and watch it trade on a paper
account from the platform's web page. Every step ends with something you can
**run and see**, so you are never more than a minute from a working state.

## Before you start: local setup

Follow [the setup guide](setup.md) to install Git, Node.js, and Docker Desktop,
download this repo, configure your own Alpaca paper keys, and sign in locally.
It includes both local simulation with live data and optional execution on your
personal Alpaca paper account. Finish its startup checks before Step 1 below.

> The finished version of this strategy already exists as the **answer key**:
> `backend/src/strategies/beginnerReversal/`. Don't open it until you have tried
> the steps. You will build your own copy, `jcavallin_reversal`, next to it.

## Choose your own strategy name

Use the **first letter of your first name + your last name**, lowercase, followed
by `_reversal`. For example, first initial `j` and last name `cavallin` become
`jcavallin_reversal`. This keeps learners' strategy types, files, and catalog
entries distinct when their work is combined in the same repo.

The examples below use that name. **Replace the example prefix with your own
throughout every step**, keeping these forms consistent:

| Where | Example |
|---|---|
| Strategy type and log prefix | `jcavallin_reversal` |
| Folder | `jcavallinReversal` |
| Strategy file | `jcavallinReversalStrategy.ts` |
| Class and config interface | `JcavallinReversalStrategy`, `JcavallinReversalConfig` |
| Manifest export | `jcavallinReversalManifest` |
| Display name | `Jcavallin Reversal` |

Use only letters for the personal prefix; omit spaces, hyphens, and apostrophes.
If another learner has the same first initial and last name, agree on a distinct
suffix before registering your types. Append your entry to the existing type
lists and catalog; preserve everyone else's entries.

**The strategy in one sentence:** if a stock's latest 1-minute bar closed *higher*
than the bar before, sell one share; if it closed *lower*, buy one share.

Each file below is shown in full. Paths are from the repo root. Lines marked
`// CHANGED` are the only ones that differ from the previous step.

---

## Step 1: An empty strategy

A strategy is a class with one method, `evaluate()`. The platform calls it every
time a new 1-minute bar arrives (that is what the `triggers` line asks for). It
returns a **signal** ("do this") or `null` ("do nothing"). For now it always says
nothing.

First, tell the platform the new type's name. In `backend/src/types/strategy.ts`,
add one line to the `StrategyType` list:

```ts
  | "beginner_reversal"
  | "jcavallin_reversal";   // CHANGED: add this line (and move the ";" up from the line above)
```

Create `backend/src/strategies/jcavallinReversal/jcavallinReversalStrategy.ts`:

```ts
// backend/src/strategies/jcavallinReversal/jcavallinReversalStrategy.ts
import { BaseStrategy } from "../base/strategy";
import type { EvaluationContext } from "../base/strategy";
import type { BaseStrategyConfig, StrategySignal, StrategyType } from "../../types/strategy";
import type { MarketEventKind } from "../../types/market";

export interface JcavallinReversalConfig extends BaseStrategyConfig {
  type: "jcavallin_reversal";
}

// Defines a class for the strategy that can be used to create and run multiple instances at the same time or manage exectuion - start, stop, pause
// Same code reused across paper, live, and backtesting
export class JcavallinReversalStrategy extends BaseStrategy {
  readonly type: StrategyType = "jcavallin_reversal";
  static readonly VERSION = 1;
  readonly version = JcavallinReversalStrategy.VERSION;
  readonly triggers: readonly MarketEventKind[] = ["bar"]; // call evaluate() only when a bar arrives

  constructor(readonly myConfig: JcavallinReversalConfig) {
    super(myConfig);
  }

  // Generate signals, later ingested by the core engine for live and paper trading
  evaluate(_context: EvaluationContext): StrategySignal | null {
    // we will fill this in the next steps
    return null; // null = no signal generated; do nothing on this evaluation
  }
}
```

**Check it:** `cd backend && npm run typecheck`. No errors means the platform
accepts your class.

---

## Step 2: Register it and launch it locally

A strategy must be **registered** before it can run. Use `experimental` while developing
locally; `ready` releases it for shared trading.
Create the manifest, the strategy's "ID card" for the platform:

```ts
// backend/src/strategies/jcavallinReversal/manifest.ts
import type { StrategyManifest } from "../../config/strategyManifest";
import { JcavallinReversalStrategy, type JcavallinReversalConfig } from "./jcavallinReversalStrategy";

const DEFAULTS = {
  name: "Jcavallin Reversal",
  type: "jcavallin_reversal",
  symbols: ["SPY"],
  rollingWindowMs: 60_000,
  maxPositionSizeUsd: 10_000,
  cooldownMs: 0,
  enabled: true,
};

export const jcavallinReversalManifest: StrategyManifest = {
  type: "jcavallin_reversal",
  status: "experimental", // local sim/personal paper + backtests; ready = shared trading
  label: "Jcavallin Reversal",
  description: "Sell after an up bar, buy after a down bar.",
  version: JcavallinReversalStrategy.VERSION,
  defaultConfig: DEFAULTS,
  create: (config) => new JcavallinReversalStrategy({ ...DEFAULTS, ...config } as unknown as JcavallinReversalConfig),
  params: [{ key: "symbols", label: "Symbols", kind: "symbols" }],
};
```

Then add it to the list in `backend/src/config/strategyCatalog.ts`:

```ts
import { jcavallinReversalManifest } from "../strategies/jcavallinReversal/manifest"; // CHANGED

export const STRATEGY_CATALOG: readonly StrategyManifest[] = [
  pairsManifest,
  minuteReversalManifest,
  beginnerReversalManifest,
  jcavallinReversalManifest, // CHANGED
];
```

Also add `| "jcavallin_reversal"` to `StrategyType` in `frontend/types/strategy.ts`.

**Check it:** use `STRATEGY_POLICY_PROFILE=development` and `EXECUTION_TARGET=sim`
(the local Docker stack already sets these). Restart the backend, open the **Strategies** page, and pick
**Jcavallin Reversal** in *Strategy Type*. Click *Save as new configuration*, then
*Start Selected Version on Paper*. A run appears under *All Runs* and... does
nothing. That is correct: it is running, and has nothing to say yet.

> The `params` list draws the trading and backtest forms. No separate backtest
> factory registration is needed. On a shared runtime, this experimental strategy
> appears on Backtests but is excluded from new trading launches.

---

## Step 3: Notice a new bar

`evaluate()` is called once per arriving bar. We still remember the last bar we
looked at, and only act when a **new** one arrives, so a bar that is ever delivered
twice is not counted twice.

```ts
// backend/src/strategies/jcavallinReversal/jcavallinReversalStrategy.ts
import { BaseStrategy } from "../base/strategy";
import { logger } from "../../utils/logger"; // CHANGED
import type { EvaluationContext } from "../base/strategy";
import type { BaseStrategyConfig, StrategySignal, StrategyType } from "../../types/strategy";
import type { MarketEventKind } from "../../types/market";

export interface JcavallinReversalConfig extends BaseStrategyConfig {
  type: "jcavallin_reversal";
}

export class JcavallinReversalStrategy extends BaseStrategy {
  readonly type: StrategyType = "jcavallin_reversal";
  static readonly VERSION = 1;
  readonly version = JcavallinReversalStrategy.VERSION;
  readonly triggers: readonly MarketEventKind[] = ["bar"]; // call evaluate() only when a bar arrives

  /** The last bar we looked at, per symbol. */ // CHANGED (this and everything below)
  private readonly lastBar = new Map<string, { ts: number; close: number }>();

  constructor(readonly myConfig: JcavallinReversalConfig) {
    super(myConfig);
  }

  evaluate(context: EvaluationContext): StrategySignal | null {
    if (!this.isActive || !this.myConfig.enabled) return null;
    const { symbol } = context;

    const bar = context.symbolState.get(symbol)?.latestBar;
    if (!bar) return null;

    const prev = this.lastBar.get(symbol);
    if (prev && bar.ts <= prev.ts) return null; // same bar as last time
    this.lastBar.set(symbol, { ts: bar.ts, close: bar.close });

    logger.info(`jcavallin_reversal: ${symbol} new bar, close ${bar.close}`);
    return null;
  }
}
```

**Check it:** restart the backend (see *Before class* in the README). A run left
running is adopted again automatically, now using your new code; if you stopped it,
start it again. Watch the backend terminal: you will see one line per symbol per
bar (replayed bars arrive fast when `REPLAY_SPEED` is raised; live bars arrive once a
minute during market hours).

---

## Step 4: Decide, and send a signal

Compare the new bar with the one before it. The first bar has nothing to compare
against, so it only sets the baseline.

```ts
// backend/src/strategies/jcavallinReversal/jcavallinReversalStrategy.ts
import { BaseStrategy } from "../base/strategy";
import { logger } from "../../utils/logger";
import type { EvaluationContext } from "../base/strategy";
import type { BaseStrategyConfig, StrategySignal, StrategyType } from "../../types/strategy";
import type { MarketEventKind } from "../../types/market";

export interface JcavallinReversalConfig extends BaseStrategyConfig {
  type: "jcavallin_reversal";
}

export class JcavallinReversalStrategy extends BaseStrategy {
  readonly type: StrategyType = "jcavallin_reversal";
  static readonly VERSION = 1;
  readonly version = JcavallinReversalStrategy.VERSION;
  readonly triggers: readonly MarketEventKind[] = ["bar"]; // call evaluate() only when a bar arrives

  private readonly lastBar = new Map<string, { ts: number; close: number }>();

  constructor(readonly myConfig: JcavallinReversalConfig) {
    super(myConfig);
  }

  evaluate(context: EvaluationContext): StrategySignal | null {
    if (!this.isActive || !this.myConfig.enabled) return null;
    const { symbol } = context;

    const bar = context.symbolState.get(symbol)?.latestBar;
    if (!bar) return null;

    const prev = this.lastBar.get(symbol);
    if (prev && bar.ts <= prev.ts) return null; // same bar as last time
    this.lastBar.set(symbol, { ts: bar.ts, close: bar.close });

    if (!prev || bar.close === prev.close) return null; // CHANGED (everything below)

    const side = bar.close > prev.close ? "sell" : "buy";
    logger.info(`jcavallin_reversal: ${symbol} ${prev.close} -> ${bar.close}, so ${side} 1 share`);

    return this.buildSignal({
      symbol,
      direction: side === "sell" ? "short" : "long",
      qty: 1,
      triggerLabel: side === "sell" ? "bar_up_sell" : "bar_down_buy",
    });
  }
}
```

**Check it:** restart the backend. On the next bar that moves, the log explains the
decision and an order shows up on the **Portfolio** page (and on the run's own page,
reached from *All Runs*). **That is a real paper trade, placed by code you wrote.**

---

## Step 5: Don't pile up

Right now a long run of up bars would keep selling short. Add a safety cap, and
label trades that *reduce* a position as closes.

```ts
// backend/src/strategies/jcavallinReversal/jcavallinReversalStrategy.ts
import { BaseStrategy } from "../base/strategy";
import { logger } from "../../utils/logger";
import type { EvaluationContext } from "../base/strategy";
import type { BaseStrategyConfig, SignalDirection, StrategySignal, StrategyType } from "../../types/strategy";
import type { MarketEventKind } from "../../types/market";

const MAX_POSITION = 1; // CHANGED: most shares we will hold, long or short

export interface JcavallinReversalConfig extends BaseStrategyConfig {
  type: "jcavallin_reversal";
}

export class JcavallinReversalStrategy extends BaseStrategy {
  readonly type: StrategyType = "jcavallin_reversal";
  static readonly VERSION = 2; // CHANGED: the logic changed, so the version goes up
  readonly version = JcavallinReversalStrategy.VERSION;
  readonly triggers: readonly MarketEventKind[] = ["bar"]; // call evaluate() only when a bar arrives

  private readonly lastBar = new Map<string, { ts: number; close: number }>();

  constructor(readonly myConfig: JcavallinReversalConfig) {
    super(myConfig);
  }

  evaluate(context: EvaluationContext): StrategySignal | null {
    if (!this.isActive || !this.myConfig.enabled) return null;
    const { symbol } = context;

    const bar = context.symbolState.get(symbol)?.latestBar;
    if (!bar) return null;

    const prev = this.lastBar.get(symbol);
    if (prev && bar.ts <= prev.ts) return null; // same bar as last time
    this.lastBar.set(symbol, { ts: bar.ts, close: bar.close });

    if (!prev || bar.close === prev.close) return null;

    const side = bar.close > prev.close ? "sell" : "buy";

    const position = context.portfolioState.getPosition(symbol)?.qty ?? 0; // CHANGED (guard)
    const after = position + (side === "buy" ? 1 : -1);
    if (Math.abs(after) > MAX_POSITION) return null; // would hold too much: skip

    logger.info(`jcavallin_reversal: ${symbol} ${prev.close} -> ${bar.close}, so ${side} 1 share`);

    return this.buildSignal({
      symbol,
      direction: this.directionFor(side, position), // CHANGED
      qty: 1,
      triggerLabel: side === "sell" ? "bar_up_sell" : "bar_down_buy",
    });
  }

  /** Reducing an existing position is a "close", not a new long or short. */ // CHANGED
  private directionFor(side: "buy" | "sell", position: number): SignalDirection {
    if (side === "buy") return position < 0 ? "close_short" : "long";
    return position > 0 ? "close_long" : "short";
  }
}
```

**Check it:** restart the backend and watch the position on the **Portfolio** page
stay between -1 and +1.

---

## Step 6: Make the cap a setting

Hard-coded numbers are for prototypes. Move `MAX_POSITION` into the config so it
shows up in the form. Three small edits:

**1.** In `jcavallinReversalStrategy.ts`, delete the `MAX_POSITION` constant, add the
field to the config, and read it from there:

```ts
export interface JcavallinReversalConfig extends BaseStrategyConfig {
  type: "jcavallin_reversal";
  maxPositionQty: number; // CHANGED
}
// ...
    if (Math.abs(after) > this.myConfig.maxPositionQty) return null; // CHANGED
```

**2.** In `manifest.ts`, give it a default and a form field:

```ts
const DEFAULTS = {
  // ...
  enabled: true,
  maxPositionQty: 1, // CHANGED
};
// ...
  params: [
    { key: "symbols", label: "Symbols", kind: "symbols" },
    { key: "maxPositionQty", label: "Max position (shares)", kind: "number", min: 1 }, // CHANGED
  ],
```

**3.** Restart. The form now has a **Max position** box. Change it to `2`, write
*"allow 2 shares"* in *What changed?*, press *Save changes*, and start the latest
version. Every save is stored as a new immutable version with your note attached;
that is how a team can later see who changed what, and why.

You have now done the whole loop that professional quant teams do: **write → register
→ configure → paper trade → record what changed.**

---

## Backtest your strategy

After step 5 (or step 6), open **Backtests**, choose **Jcavallin Reversal (experimental)**,
and choose your saved configuration or enter a new one. Select dates with cached
or fetchable 1-minute bars, choose the initial capital and fill model, then press
**Run Backtest**. Inspect orders, fills, rejected orders, and the equity curve. If you
edit a saved configuration for a test, save a new configuration/version before using
the result as evidence for that exact saved version.

The historical worker and paper runner instantiate the same class through the
catalog. Historical playback and live execution use different data/execution adapters,
so their fills need not match. Backtesting a prototype is allowed on shared cloud
runtimes too; it does not release it for shared paper or real-money trading.

When you want the team to launch it on the shared paper account, change its manifest
status to `ready`, review/test the change, and deploy it. Real-money runs still need
the existing lead approval. The Beginner Reversal answer key stays hidden throughout.

---

## Exercises

1. **Flip it.** Swap `"sell"` and `"buy"` so it follows the move instead of
   fading it (momentum). Bump `VERSION`. Run both side by side.
2. **A threshold.** Only trade if the bar moved more than 0.1%. Add it as a
   config parameter.
3. **Restart blindness.** Stop and start the backend mid-session. What does the
   strategy do with its first bar? Why? (Hint: the answer key's `warmUp` idea.)
4. **Retire it.** Set `status: "retired"` and restart. What disappears from the
   picker? What happens to a run that was already going?
