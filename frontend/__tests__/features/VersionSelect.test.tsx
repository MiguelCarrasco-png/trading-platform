import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import VersionSelect, { versionLabel } from "../../features/strategy/VersionSelect";
import type { StrategyVersion } from "../../types/review";

function version(n: number, extra: Partial<StrategyVersion> = {}): StrategyVersion {
  return {
    id: `ver-${n}`, strategyId: "s", versionNumber: n, config: {}, changeSummary: `change ${n}`,
    createdBy: "u", createdAt: Date.UTC(2026, 9, 19, 12), createdByName: "Ana", ...extra,
  };
}

describe("VersionSelect", () => {
  it("renders nothing for a strategy with no versions", () => {
    const { container } = render(<VersionSelect versions={[]} value={null} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("defaults to the newest version and says so", () => {
    render(<VersionSelect versions={[version(3), version(2)]} value={null} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Version to run")).toHaveValue("ver-3");
    expect(screen.getByRole("option", { name: /v3 .* \(latest\)/ })).toBeInTheDocument();
  });

  it("reports null when the member goes back to the newest", async () => {
    const onChange = vi.fn();
    render(<VersionSelect versions={[version(3), version(2)]} value="ver-2" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText("Version to run"), "ver-3");
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows the algorithm version a saved config was written for", () => {
    expect(versionLabel(version(2, { algorithmVersion: 4 }))).toMatch(/^v2 - algo v4 - change 2 - Ana/);
    expect(versionLabel(version(2, { algorithmVersion: null }))).not.toMatch(/algo/);
    expect(versionLabel(version(2))).not.toMatch(/algo/);
  });

  it("warns that a config predating the current algorithm will run on the current one", () => {
    render(
      <VersionSelect versions={[version(3, { algorithmVersion: 1 })]} value={null} onChange={vi.fn()} currentAlgorithmVersion={2} />,
    );
    expect(screen.getByText(/saved for algorithm v1; the current algorithm is v2/)).toBeInTheDocument();
    expect(screen.getByText(/will run on v2/)).toBeInTheDocument();
  });

  it.each([
    ["written for the current algorithm", 2, 2],
    ["of unknown origin (saved before it was recorded)", null, 2],
  ])("does not warn about a config %s", (_label, saved, current) => {
    render(
      <VersionSelect versions={[version(3, { algorithmVersion: saved })]} value={null} onChange={vi.fn()} currentAlgorithmVersion={current} />,
    );
    expect(screen.queryByText(/current algorithm is/)).not.toBeInTheDocument();
  });
});
