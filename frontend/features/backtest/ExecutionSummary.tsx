/**
 * features/backtest/ExecutionSummary.tsx
 *
 * How a backtest that priced its orders from real quotes got its fills
 * (metrics.meta.execution): what priced them, what fell back to the bar model
 * and why, and the average cost of crossing the spread and of the delay
 * between decision and arrival.
 *
 * Inputs:  the execution report.
 * Outputs: Rendered metric cards and notes.
 */

import type { ExecutionReport } from "../../types/portfolio";

const FALLBACK_REASONS: Record<string, string> = {
  no_quote: "no quote in time",
  quote_data_unavailable: "quotes unavailable",
  invalid_order: "incomplete order",
};

function formatBps(value: number | null): string {
  return value == null ? "—" : `${value.toFixed(2)} bps`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default function ExecutionSummary({ report }: { report: ExecutionReport }) {
  const cards = [
    { label: "Quote Fills", value: String(report.fills.quote), hint: "Priced at the bid/ask when the order reached the market" },
    { label: "Resting Fills", value: String(report.fills.trade), hint: "Resting limits filled by trades printing through them" },
    { label: "Avg Spread Cost", value: formatBps(report.avgSpreadCostBps), hint: "Fill price against the mid on arrival" },
    { label: "Avg Delay Cost", value: formatBps(report.avgDelayCostBps), hint: "Move of the mid between decision and arrival, against the order" },
  ];

  const notes: string[] = [];
  const fallbacks = Object.entries(report.fallbacks);
  const fellBack = fallbacks.reduce((sum, [, n]) => sum + n, 0);
  if (fellBack > 0) {
    const reasons = fallbacks.map(([reason, n]) => `${FALLBACK_REASONS[reason] ?? reason}: ${n}`).join(", ");
    notes.push(`${plural(fellBack, "order was", "orders were")} priced at the next bar's open instead (${reasons}).`);
  }
  if (report.stopsTriggered) notes.push(`${plural(report.stopsTriggered, "stop", "stops")} triggered.`);
  if (report.expiredUnmarketable > 0) {
    notes.push(`${plural(report.expiredUnmarketable, "IOC limit", "IOC limits")} expired, not marketable on arrival.`);
  }
  if (report.expiredAtClose) notes.push(`${plural(report.expiredAtClose, "resting order", "resting orders")} expired at the close.`);
  if (report.tradeDataUnavailable > 0) {
    notes.push(`${plural(report.tradeDataUnavailable, "minute", "minutes")} of resting orders went unchecked: trades unavailable.`);
  }

  const slippage = report.extraSlippageBps > 0 ? ` · +${report.extraSlippageBps} bps slippage` : "";

  return (
    <div className="flex flex-col gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
      <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
        Fills from real quotes · {report.latencyMs} ms latency · {report.feed.toUpperCase()}{slippage}
      </p>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {cards.map(({ label, value, hint }) => (
          <div key={label} title={hint}>
            <dt className="text-xs text-zinc-500">{label}</dt>
            <dd className="mt-1 text-base font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</dd>
          </div>
        ))}
      </dl>
      {notes.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-zinc-500">
          {notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </div>
  );
}
