import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const auth = vi.hoisted(() => ({ user: { id: "u1" } as null | { id: string }, isLoading: false }));

vi.mock("../../context/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("../../services/proposalsService", () => ({ fetchVersions: vi.fn() }));

import { useStrategyVersions } from "../../hooks/useStrategyVersions";
import * as service from "../../services/proposalsService";

const fetchVersions = vi.mocked(service.fetchVersions);
const version = (id: string, strategyId: string) => ({ id, strategyId, versionNumber: 1 }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = { id: "u1" };
  auth.isLoading = false;
});

describe("useStrategyVersions", () => {
  it("loads a saved strategy's versions", async () => {
    fetchVersions.mockResolvedValue([version("v1", "a")]);
    const { result } = renderHook(() => useStrategyVersions("a"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.versions).toEqual([version("v1", "a")]);
  });

  it("never shows the previous strategy's versions while the next one loads", async () => {
    fetchVersions.mockResolvedValueOnce([version("v1", "a")]);
    const { result, rerender } = renderHook(({ id }) => useStrategyVersions(id), { initialProps: { id: "a" } });
    await waitFor(() => expect(result.current.versions).toHaveLength(1));

    let release: (v: never[]) => void = () => {};
    fetchVersions.mockReturnValueOnce(new Promise((resolve) => { release = resolve as typeof release; }));
    rerender({ id: "b" });

    expect(result.current.versions).toEqual([]);
    expect(result.current.isLoading).toBe(true);

    release([version("v2", "b")] as never[]);
    await waitFor(() => expect(result.current.versions).toEqual([version("v2", "b")]));
    expect(result.current.isLoading).toBe(false);
  });

  it("is empty and idle for an unsaved strategy", async () => {
    const { result } = renderHook(() => useStrategyVersions(null));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.versions).toEqual([]);
    expect(fetchVersions).not.toHaveBeenCalled();
  });

  it("stops loading and reports the error when the fetch fails", async () => {
    fetchVersions.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useStrategyVersions("a"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.versions).toEqual([]);
    expect(result.current.error).toBe("boom");
  });
});
