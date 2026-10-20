/**
 * features/strategy/GenericStrategyForm.tsx
 *
 * One form for every strategy that describes its parameters in the backend
 * catalog (the manifest's `params`). Draws a field per ParamSpec, so a new
 * strategy needs no frontend code. Pairs trading keeps its own richer form.
 *
 * Pick a saved config or start from the type's defaults, save it (every save
 * is an immutable version), then start the latest saved version on paper.
 *
 * Inputs:  type — the strategy type to edit; onSubmit — starts the run.
 * Outputs: Calls onSubmit with the saved strategy and its latest version.
 */

"use client";

import { useState } from "react";
import type { ParamSpec, RiskBudget, StrategyType } from "../../types/strategy";
import { useStrategyConfigs } from "../../hooks/useStrategyConfigs";
import { useStrategyVersions } from "../../hooks/useStrategyVersions";
import RiskBudgetSection, { type RiskBudgetState } from "../shared/RiskBudgetSection";

interface Props {
  type: StrategyType;
  onSubmit: (selection: { strategyId: string; versionId: string }) => Promise<void>;
}

/** "spy, aapl" -> ["SPY", "AAPL"]; an array passes through. */
function parseSymbols(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/** The value a field shows: symbol arrays read back as comma-separated text. */
function displayValue(spec: ParamSpec, value: unknown): string | number | boolean {
  if (spec.kind === "symbols") return Array.isArray(value) ? value.join(", ") : String(value ?? "");
  if (spec.kind === "boolean") return Boolean(value);
  if (spec.kind === "number") return typeof value === "number" ? value : Number(value ?? 0);
  return String(value ?? "");
}

/** Returns an error message for the first out-of-range number or empty symbol list. */
function validateParams(params: ParamSpec[], values: Record<string, unknown>): string | null {
  for (const spec of params) {
    const value = values[spec.key];
    if (spec.kind === "symbols" && parseSymbols(value).length === 0) {
      return `${spec.label} must list at least one symbol.`;
    }
    if (spec.kind === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) return `${spec.label} must be a number.`;
      if (spec.min !== undefined && n < spec.min) return `${spec.label} must be at least ${spec.min}.`;
      if (spec.max !== undefined && n > spec.max) return `${spec.label} must be at most ${spec.max}.`;
    }
  }
  return null;
}

function budgetStateFrom(budget: RiskBudget | undefined): RiskBudgetState {
  return {
    maxCapitalPct: Math.round((budget?.maxCapitalPct ?? 0.2) * 100),
    maxOpenOrders: budget?.maxOpenOrders ?? null,
    maxOrderNotionalPct: budget?.maxOrderNotionalPct != null ? Math.round(budget.maxOrderNotionalPct * 100) : null,
  };
}

function budgetFrom(state: RiskBudgetState): RiskBudget {
  return {
    maxCapitalPct: state.maxCapitalPct / 100,
    ...(state.maxOpenOrders !== null && { maxOpenOrders: state.maxOpenOrders }),
    ...(state.maxOrderNotionalPct !== null && { maxOrderNotionalPct: state.maxOrderNotionalPct / 100 }),
  };
}

export default function GenericStrategyForm({ type, onSubmit }: Props) {
  const { strategies, definition, isLoading, save, update } = useStrategyConfigs(type);
  const [selectedId, setSelectedId] = useState<string>("new");
  const { versions, refetch: refetchVersions } = useStrategyVersions(selectedId !== "new" ? selectedId : null);

  // What the user changed on top of the selected config; cleared when the selection changes.
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [riskEdit, setRiskEdit] = useState<RiskBudgetState | null>(null);

  const [isSavingNew, setIsSavingNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [changeSummary, setChangeSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const params = definition?.params ?? [];
  const saved = strategies.find((s) => s.id === selectedId);
  const base: Record<string, unknown> = { ...definition?.defaultConfig, ...saved?.config };
  const valueOf = (key: string): unknown => (key in edits ? edits[key] : base[key]);
  const name = nameEdit ?? saved?.name ?? String(base.name ?? "");
  const risk = riskEdit ?? budgetStateFrom(base.riskBudget as RiskBudget | undefined);

  const resetEdits = () => {
    setEdits({});
    setNameEdit(null);
    setRiskEdit(null);
  };

  const select = (id: string) => {
    setSelectedId(id);
    setIsSavingNew(false);
    setError(null);
    setNotice(null);
    resetEdits();
  };

  /** The config as saved: the base, the user's edits, and a normalised risk budget. */
  const buildConfig = (): Record<string, unknown> => {
    const config: Record<string, unknown> = { ...base, type, name };
    for (const spec of params) {
      const value = valueOf(spec.key);
      config[spec.key] = spec.kind === "symbols" ? parseSymbols(value) : value;
    }
    config.riskBudget = budgetFrom(risk);
    return config;
  };

  const withValidConfig = (action: (config: Record<string, unknown>) => Promise<void>) => async () => {
    setError(null);
    setNotice(null);
    const config = buildConfig();
    const problem = validateParams(params, config);
    if (problem) {
      setError(problem);
      return;
    }
    try {
      await action(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  const handleSaveNew = withValidConfig(async (config) => {
    const created = await save(newName.trim() || name, config);
    setSelectedId(created.id);
    setIsSavingNew(false);
    setNewName("");
    resetEdits();
    setNotice("Saved. Start it below when you are ready.");
  });

  const handleSaveChanges = withValidConfig(async (config) => {
    const version = await update(selectedId, name, config, changeSummary.trim() || undefined);
    setChangeSummary("");
    resetEdits();
    setNotice(`Saved as v${version.versionNumber}. It is now available for paper trading.`);
    await refetchVersions();
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (selectedId === "new") {
      setError("Save this configuration before starting a paper sandbox.");
      return;
    }
    const latest = versions[0];
    if (!latest) {
      setError("This strategy has no saved version to run.");
      return;
    }
    setIsStarting(true);
    try {
      await onSubmit({ strategyId: selectedId, versionId: latest.id });
      setNotice("Started. Watch it under All Runs.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the strategy");
    } finally {
      setIsStarting(false);
    }
  };

  if (isLoading || !definition) {
    return <div className="h-40 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800" />;
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{definition.label}</h3>
      <p className="text-xs text-zinc-500">{definition.description}</p>

      <div className="flex flex-col gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
        <Field label="Configuration" htmlFor="config-picker">
          <select id="config-picker" className={inputClass} value={selectedId} onChange={(e) => select(e.target.value)}>
            <option value="new">New Configuration</option>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <Field label={isSavingNew ? "New Config Name" : "Config Name"} htmlFor="config-name">
          {isSavingNew ? (
            <input
              id="config-name"
              type="text"
              placeholder={name}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className={inputClass}
              autoFocus
            />
          ) : (
            <input
              id="config-name"
              type="text"
              value={name}
              onChange={(e) => setNameEdit(e.target.value)}
              className={inputClass}
            />
          )}
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
        {params.map((spec) => (
          <ParamField
            key={spec.key}
            spec={spec}
            value={displayValue(spec, valueOf(spec.key))}
            onChange={(v) => setEdits((prev) => ({ ...prev, [spec.key]: v }))}
          />
        ))}
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-700">
        <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">Portfolio Allocation</p>
        <RiskBudgetSection value={risk} onChange={setRiskEdit} />
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {notice && (
        <p className="rounded-md border border-zinc-200 bg-zinc-50 p-2 text-xs text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          {notice}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {selectedId !== "new" && (
          <>
            <Field label="What changed? (saved with this version)" htmlFor="change-summary">
              <input
                id="change-summary"
                type="text"
                value={changeSummary}
                onChange={(e) => setChangeSummary(e.target.value)}
                placeholder="e.g. allowed 2 shares per symbol"
                className={inputClass}
              />
            </Field>
            <button type="button" onClick={handleSaveChanges} className={secondaryButton}>
              Save changes
            </button>
          </>
        )}

        {isSavingNew ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSaveNew}
              className="flex-1 rounded-md bg-zinc-800 px-3 py-1.5 text-sm text-white hover:bg-zinc-700 dark:bg-zinc-200 dark:text-zinc-900"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => { setIsSavingNew(false); setNewName(""); setError(null); }}
              className="rounded-md px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-700"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setIsSavingNew(true)} className={secondaryButton}>
            Save as new configuration
          </button>
        )}

        <button
          type="submit"
          disabled={isStarting}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
        >
          {isStarting ? "Starting…" : "Start Latest Saved Version on Paper"}
        </button>
      </div>
    </form>
  );
}

function ParamField({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec;
  value: string | number | boolean;
  onChange: (next: string | number | boolean) => void;
}) {
  const id = `param-${spec.key}`;
  if (spec.kind === "boolean") {
    return (
      <div className="col-span-2 flex items-center gap-2">
        <input id={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <label htmlFor={id} className="text-xs font-medium text-zinc-500">{spec.label}</label>
        {spec.hint && <span className="text-[11px] text-zinc-400">{spec.hint}</span>}
      </div>
    );
  }
  const wide = spec.kind === "symbols" || spec.kind === "text";
  return (
    <div className={wide ? "col-span-2" : undefined}>
      <Field label={spec.label} htmlFor={id}>
        {spec.kind === "number" ? (
          <input
            id={id}
            type="number"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={Number(value)}
            onChange={(e) => onChange(Number(e.target.value))}
            className={inputClass}
          />
        ) : (
          <input id={id} type="text" value={String(value)} onChange={(e) => onChange(e.target.value)} className={inputClass} />
        )}
        {spec.hint && <span className="text-[11px] text-zinc-400">{spec.hint}</span>}
      </Field>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-zinc-500">{label}</label>
      {children}
    </div>
  );
}

const inputClass =
  "w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50";

const secondaryButton =
  "rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800";
