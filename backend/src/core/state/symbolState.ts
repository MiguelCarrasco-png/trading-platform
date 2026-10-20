/**
 * core/state/symbolState.ts
 *
 * Per-symbol in-memory state manager. Maintains rolling windows of quotes,
 * trades, midprices, and spreads, along with the latest snapshot for each
 * tracked symbol. Strategies query this to compute signals.
 *
 * Inputs:  Normalized Quote, Trade, Bar events from the EventBus handlers.
 * Outputs: Current symbol state and rolling windows queried by strategies.
 */

import { RollingTimeWindow } from "./rollingWindow";
import { DEFAULT_WINDOWS } from "../../config/defaults";
import { barEndMs } from "../../utils/time";
import type { Quote, Trade, Bar } from "../../types/market";
import type { EpochMs, Symbol } from "../../types/common";

// ------------------------------------------------------------------
// Per-symbol state shape
// ------------------------------------------------------------------

export interface SymbolState {
  symbol: Symbol;

  // Latest values
  latestQuote: Quote | null;
  latestTrade: Trade | null;
  latestBar: Bar | null;
  latestBid: number | null;
  latestAsk: number | null;
  latestMid: number | null;
  /**
   * When latestMid became known: the quote's time, or a bar's end (not its
   * start) when a bar close set it. Staleness checks measure age from here.
   */
  latestMidTs: EpochMs | null;
  latestSpread: number | null;

  // Rolling windows
  quotesWindow: RollingTimeWindow<Quote>;
  tradesWindow: RollingTimeWindow<Trade>;
  midpricesWindow: RollingTimeWindow<number>;
  spreadsWindow: RollingTimeWindow<number>;

  // Update counters (for diagnostics)
  quoteCount: number;
  tradeCount: number;
  barCount: number;
}

// ------------------------------------------------------------------
// SymbolStateManager
// ------------------------------------------------------------------

export class SymbolStateManager {
  private states: Map<Symbol, SymbolState> = new Map();

  /**
   * Returns the current state for a symbol, creating it if not yet tracked.
   * @param symbol - Ticker symbol
   * @returns SymbolState for the given symbol
   */
  getOrCreate(symbol: Symbol): SymbolState {
    if (!this.states.has(symbol)) {
      this.states.set(symbol, this._createInitialState(symbol));
    }
    return this.states.get(symbol)!;
  }

  /**
   * Returns the current state for a symbol, or null if not tracked.
   * @param symbol - Ticker symbol
   * @returns SymbolState or null
   */
  get(symbol: Symbol): SymbolState | null {
    return this.states.get(symbol) ?? null;
  }

  /**
   * Returns all tracked symbols.
   * @returns Array of Symbol strings
   */
  getSymbols(): Symbol[] {
    return [...this.states.keys()];
  }

  /**
   * Handles a new quote event: updates latest values and rolling windows.
   * Called by the Orchestrator when a QUOTE_RECEIVED event arrives.
   * @param quote - Normalized Quote
   */
  onQuote(quote: Quote): void {
    const state = this.getOrCreate(quote.symbol);
    state.latestQuote = quote;
    state.latestBid = quote.bidPrice;
    state.latestAsk = quote.askPrice;
    state.latestMid = quote.midPrice;
    state.latestMidTs = quote.ts;
    state.latestSpread = quote.spread;
    state.quoteCount++;
    state.quotesWindow.push({ ts: quote.ts, value: quote });
    state.midpricesWindow.push({ ts: quote.ts, value: quote.midPrice });
    state.spreadsWindow.push({ ts: quote.ts, value: quote.spread });
  }

  /**
   * Handles a new trade event: updates latest trade and trade window.
   * @param trade - Normalized Trade
   */
  onTrade(trade: Trade): void {
    const state = this.getOrCreate(trade.symbol);
    state.latestTrade = trade;
    state.tradeCount++;
    state.tradesWindow.push({ ts: trade.ts, value: trade });
  }

  /**
   * Handles a new bar event: updates the latest bar.
   * @param bar - Normalized Bar
   */
  onBar(bar: Bar): void {
    const state = this.getOrCreate(bar.symbol);
    state.latestBar = bar;
    state.barCount++;
    // Fallback: a bar close stands in for the mid so quote-based code can run
    // on bars — but only when nothing fresher is known. A quote received after
    // the bar completed is the better current price.
    const endTs = barEndMs(bar);
    if (state.latestMidTs === null || endTs >= state.latestMidTs) {
      state.latestMid = bar.close;
      state.latestMidTs = endTs;
    }
  }

  /**
   * Clears all state for all symbols. Used in tests and resets.
   */
  clear(): void {
    this.states.clear();
  }

  // ------------------------------------------------------------------
  // Private
  // ------------------------------------------------------------------

  private _createInitialState(symbol: Symbol): SymbolState {
    return {
      symbol,
      latestQuote: null,
      latestTrade: null,
      latestBar: null,
      latestBid: null,
      latestAsk: null,
      latestMid: null,
      latestMidTs: null,
      latestSpread: null,
      quotesWindow: new RollingTimeWindow(DEFAULT_WINDOWS.medium),
      tradesWindow: new RollingTimeWindow(DEFAULT_WINDOWS.medium),
      midpricesWindow: new RollingTimeWindow(DEFAULT_WINDOWS.medium),
      spreadsWindow: new RollingTimeWindow(DEFAULT_WINDOWS.medium),
      quoteCount: 0,
      tradeCount: 0,
      barCount: 0,
    };
  }
}
