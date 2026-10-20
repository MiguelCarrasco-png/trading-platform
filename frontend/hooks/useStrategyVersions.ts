/**
 * hooks/useStrategyVersions.ts
 *
 * Loads the config edit history for one saved strategy — every version, newest
 * first, with who made each edit. Backs the "version history" panel in
 * StrategyForm.
 */

"use client";

import { useState, useEffect, useCallback } from "react";
import { fetchVersions } from "../services/proposalsService";
import { useAuth } from "../context/AuthContext";
import type { StrategyVersion } from "../types/review";

interface UseStrategyVersionsResult {
  versions: StrategyVersion[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

/** Pass null/undefined for a strategy that has not been saved yet ("new"). */
export function useStrategyVersions(strategyId: string | null | undefined): UseStrategyVersionsResult {
  const { user, isLoading: authLoading } = useAuth();
  // The list is stored with the strategy it belongs to, so switching strategies
  // never shows (or lets a caller start) the previous strategy's versions.
  const [loaded, setLoaded] = useState<{ id: string; versions: StrategyVersion[] } | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user || !strategyId) {
      setLoaded(null);
      setIsFetching(false);
      return;
    }
    setIsFetching(true);
    try {
      setLoaded({ id: strategyId, versions: await fetchVersions(strategyId) });
      setError(null);
    } catch (err) {
      setLoaded({ id: strategyId, versions: [] });
      setError(err instanceof Error ? err.message : "Failed to load version history");
    } finally {
      setIsFetching(false);
    }
  }, [strategyId, user]);

  useEffect(() => {
    if (!authLoading) void load();
  }, [authLoading, load]);

  const current = loaded !== null && loaded.id === strategyId;
  // Loading also covers the render between selecting a strategy and its fetch starting.
  const waiting = !!user && !!strategyId && !current;
  return {
    versions: current ? loaded.versions : [],
    isLoading: isFetching || authLoading || waiting,
    error,
    refetch: load,
  };
}
