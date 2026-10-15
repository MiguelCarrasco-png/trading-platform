import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ExecutionSummary from "../../features/backtest/ExecutionSummary";
import type { ExecutionReport } from "../../types/portfolio";

const report: ExecutionReport = {
  model: "quote", latencyMs: 250, feed: "sip", extraSlippageBps: 0,
  fills: { quote: 186, trade: 4, bar: 2 },
  fallbacks: { no_quote: 2 },
  expiredUnmarketable: 0, expiredAtClose: 1, stopsTriggered: 0, tradeDataUnavailable: 0,
  avgSpreadCostBps: 0.1937, avgDelayCostBps: null,
};

describe("ExecutionSummary", () => {
  it("shows what priced the fills and what they cost", () => {
    render(<ExecutionSummary report={report} />);
    expect(screen.getByText("Fills from real quotes · 250 ms latency · SIP")).toBeInTheDocument();
    expect(screen.getByText("186")).toBeInTheDocument();
    expect(screen.getByText("0.19 bps")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("explains fallbacks and expiries, and stays quiet about what did not happen", () => {
    render(<ExecutionSummary report={report} />);
    expect(screen.getByText("2 orders were priced at the next bar's open instead (no quote in time: 2).")).toBeInTheDocument();
    expect(screen.getByText("1 resting order expired at the close.")).toBeInTheDocument();
    expect(screen.queryByText(/stops? triggered/)).not.toBeInTheDocument();
    expect(screen.queryByText(/IOC/)).not.toBeInTheDocument();
  });
});
