import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The form re-populates its fields in an effect keyed on `strategies` and
// `definition`, so the mocks hand back the same objects on every render.
const configs = vi.hoisted(() => ({
  strategies: [] as unknown[],
  definition: { algorithmVersion: 5, defaultConfig: { leg1Symbol: "SPY", leg2Symbol: "QQQ" } },
  versions: [] as unknown[],
}));

vi.mock("../../hooks/useStrategyConfigs", () => ({
  useStrategyConfigs: () => ({ strategies: configs.strategies, definition: configs.definition, isLoading: false }),
}));
vi.mock("../../hooks/useStrategyVersions", () => ({
  useStrategyVersions: () => ({ versions: configs.versions, isLoading: false }),
}));

import BacktestForm from "../../features/backtest/BacktestForm";
import type { BacktestConfig } from "../../types/api";

const submitted = () => vi.fn<(config: Omit<BacktestConfig, "id">) => Promise<void>>(async () => {});

beforeEach(() => vi.clearAllMocks());

describe("BacktestForm fills", () => {
  it("leaves the execution model to the server by default (next bar's open)", async () => {
    const onSubmit = submitted();
    render(<BacktestForm onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "Run Backtest" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("execution");
  });

  it("asks for quote fills with the chosen latency", async () => {
    const onSubmit = submitted();
    render(<BacktestForm onSubmit={onSubmit} />);
    // The form's labels sit beside their controls, so controls are found by what they show.
    await userEvent.selectOptions(screen.getByDisplayValue("Next bar's open"), "quote");
    const latency = screen.getByDisplayValue("250");
    await userEvent.clear(latency);
    await userEvent.type(latency, "400");
    await userEvent.click(screen.getByRole("button", { name: "Run Backtest" }));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ execution: { model: "quote", latencyMs: 400 } });
  });
});
