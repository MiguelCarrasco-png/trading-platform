/**
 * features/strategy/VersionSelect.tsx
 *
 * Chooses which saved version of a strategy to run on paper. Versions are
 * immutable snapshots, newest first; the newest is the default, so picking an
 * older one is a deliberate act (e.g. last week's version behaves better).
 *
 * Inputs:  versions (newest first), the picked id (null = newest), onChange.
 * Outputs: Controlled select; null from onChange is never emitted.
 */

"use client";

import type { StrategyVersion } from "../../types/review";

interface Props {
  versions: StrategyVersion[];
  /** The id the member picked, or null to run the newest. */
  value: string | null;
  onChange: (versionId: string | null) => void;
}

/** "v3 - widened the window - Ana (Oct 19)" */
export function versionLabel(v: StrategyVersion): string {
  const note = v.changeSummary?.trim() || "no note";
  const who = v.createdByName ? ` - ${v.createdByName}` : "";
  return `v${v.versionNumber} - ${note}${who} (${new Date(v.createdAt).toLocaleDateString()})`;
}

export default function VersionSelect({ versions, value, onChange }: Props) {
  if (versions.length === 0) return null;
  const newest = versions[0];
  const picked = versions.find((v) => v.id === value) ?? newest;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="version-select" className="text-xs font-medium text-zinc-500">Version to run</label>
      <select
        id="version-select"
        value={picked.id}
        onChange={(e) => onChange(e.target.value === newest.id ? null : e.target.value)}
        className="w-full rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
      >
        {versions.map((v, i) => (
          <option key={v.id} value={v.id}>
            {versionLabel(v)}{i === 0 ? " (latest)" : ""}
          </option>
        ))}
      </select>
      {picked.id !== newest.id && (
        <span className="text-[11px] text-amber-600 dark:text-amber-400">
          Running an older version (v{picked.versionNumber}); the latest is v{newest.versionNumber}.
        </span>
      )}
    </div>
  );
}
