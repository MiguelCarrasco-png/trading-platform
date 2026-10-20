# Glossary

| Word | Plain meaning |
|---|---|
| **Strategy** | A rule that looks at market data and decides "buy", "sell" or "do nothing". |
| **Bar** | A summary of one minute of trading: open, high, low, close prices and volume. |
| **Close** | The last price in a bar. "Closed up" means it is higher than the previous bar's close. |
| **Signal** | The strategy's decision, e.g. "sell 1 SPY". It is a request, not an order yet. |
| **Order** | What is actually sent to the broker after the platform's risk checks pass. |
| **Position** | How many shares you hold. Positive = long (you own them). Negative = short (you owe them). |
| **Long / short** | Betting a price rises (buy) / falls (sell first, buy back later). |
| **Paper trading** | Trading with pretend money on a real market feed. Real prices, no real risk. |
| **Symbol** | A stock's ticker: SPY, AAPL. |
| **Config** | The strategy's settings (symbols, max position). Same code, different config. |
| **Version** | A saved snapshot of a config. Every save makes a new one, so changes are traceable. |
| **Status** | Whether a strategy type may be launched: `planned` (hidden), `ready`, `retired`. |
| **Run** | One launched instance of a strategy. It has a start, maybe a stop, and a history. |
| **Reversal** | Betting that a move will undo itself: sell after up, buy after down. |
| **Momentum** | The opposite bet: a move will continue. |
