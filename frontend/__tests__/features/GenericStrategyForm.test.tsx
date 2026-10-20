import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The real hook returns stable state, so the mock hands back the same objects every render.
const configs = vi.hoisted(() => ({
  save: vi.fn(async () => ({ id: "strat-new" })),
  update: vi.fn(async () => ({ id: "ver-2", versionNumber: 2 })),
  strategies: [
    {
      id: "strat-1",
      name: "Saved reversal",
      strategy_type: "beginner_reversal",
      config: { symbols: ["QQQ"], qtyPerTrade: 2, maxPositionQty: 4 },
    },
  ],
  definition: {
    type: "beginner_reversal",
    label: "Beginner Reversal (course)",
    description: "Course example.",
    algorithmVersion: 1,
    defaultConfig: { name: "Beginner Reversal", symbols: ["SPY", "AAPL"], qtyPerTrade: 1, maxPositionQty: 1 },
    params: [
      { key: "symbols", label: "Symbols", kind: "symbols" },
      { key: "qtyPerTrade", label: "Shares per trade", kind: "number", min: 1 },
      { key: "maxPositionQty", label: "Max position (shares)", kind: "number", min: 1 },
    ],
  },
}));
const versions = vi.hoisted(() => ({ list: [{ id: "ver-9" }] as unknown[], none: [] as unknown[], refetch: vi.fn(async () => {}) }));

vi.mock("../../hooks/useStrategyConfigs", () => ({
  useStrategyConfigs: () => ({
    strategies: configs.strategies,
    definition: configs.definition,
    isLoading: false,
    error: null,
    save: configs.save,
    update: configs.update,
    remove: vi.fn(),
    refetch: vi.fn(),
  }),
}));
vi.mock("../../hooks/useStrategyVersions", () => ({
  useStrategyVersions: (id: string | null) => ({
    versions: id ? versions.list : versions.none,
    isLoading: false,
    error: null,
    refetch: versions.refetch,
  }),
}));

import GenericStrategyForm from "../../features/strategy/GenericStrategyForm";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GenericStrategyForm", () => {
  it("draws a field for each param, pre-filled from the type's defaults", () => {
    render(<GenericStrategyForm type="beginner_reversal" onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Symbols")).toHaveValue("SPY, AAPL");
    expect(screen.getByLabelText("Shares per trade")).toHaveValue(1);
    expect(screen.getByLabelText("Max position (shares)")).toHaveValue(1);
  });

  it("saves a new config with symbols parsed into an upper-case list", async () => {
    render(<GenericStrategyForm type="beginner_reversal" onSubmit={vi.fn()} />);
    await userEvent.clear(screen.getByLabelText("Symbols"));
    await userEvent.type(screen.getByLabelText("Symbols"), "nvda, tsla,");
    await userEvent.click(screen.getByRole("button", { name: "Save as new configuration" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(configs.save).toHaveBeenCalled());
    expect(configs.save).toHaveBeenCalledWith(
      "Beginner Reversal",
      expect.objectContaining({
        type: "beginner_reversal",
        symbols: ["NVDA", "TSLA"],
        qtyPerTrade: 1,
        riskBudget: expect.objectContaining({ maxCapitalPct: 0.2 }),
      }),
    );
  });

  it("refuses to save an out-of-range value and says why", async () => {
    render(<GenericStrategyForm type="beginner_reversal" onSubmit={vi.fn()} />);
    await userEvent.clear(screen.getByLabelText("Shares per trade"));
    await userEvent.type(screen.getByLabelText("Shares per trade"), "0");
    await userEvent.click(screen.getByRole("button", { name: "Save as new configuration" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Shares per trade must be at least 1.")).toBeInTheDocument();
    expect(configs.save).not.toHaveBeenCalled();
  });

  it("loads a saved config's values and starts its latest version", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<GenericStrategyForm type="beginner_reversal" onSubmit={onSubmit} />);
    await userEvent.selectOptions(screen.getByLabelText("Configuration"), "strat-1");

    expect(screen.getByLabelText("Symbols")).toHaveValue("QQQ");
    expect(screen.getByLabelText("Shares per trade")).toHaveValue(2);

    await userEvent.click(screen.getByRole("button", { name: "Start Latest Saved Version on Paper" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ strategyId: "strat-1", versionId: "ver-9" }));
  });

  it("will not start an unsaved configuration", async () => {
    const onSubmit = vi.fn();
    render(<GenericStrategyForm type="beginner_reversal" onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "Start Latest Saved Version on Paper" }));
    expect(await screen.findByText(/Save this configuration before starting/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("shows the backend's reason when starting fails", async () => {
    const onSubmit = vi.fn(async () => { throw new Error("Paper sandbox limit reached"); });
    render(<GenericStrategyForm type="beginner_reversal" onSubmit={onSubmit} />);
    await userEvent.selectOptions(screen.getByLabelText("Configuration"), "strat-1");
    await userEvent.click(screen.getByRole("button", { name: "Start Latest Saved Version on Paper" }));
    expect(await screen.findByText("Paper sandbox limit reached")).toBeInTheDocument();
  });
});
