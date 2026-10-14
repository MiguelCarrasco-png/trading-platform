/**
 * bench/artifacts.ts
 *
 * Benchmark output directory and writers. Every run gets its own immutable
 * directory, artifacts/latency/<run-id>/, created exclusively — a run never
 * overwrites another run's results. Everything written through RunArtifacts is
 * scanned for configured secret values first; a match aborts the write.
 *
 * Inputs:  Run id, base directory, values that must never appear in output.
 * Outputs: JSON, CSV and NDJSON files inside the run directory.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";
import { env } from "../config/env";

export class SecretLeakError extends Error {
  constructor(where: string) {
    super(`Refusing to write ${where}: it contains a configured credential value`);
    this.name = "SecretLeakError";
  }
}

/**
 * Credential values from the environment that must never reach an artifact.
 * Short values are ignored to avoid false positives on common substrings.
 */
export function knownSecretValues(): string[] {
  const values = [
    env.alpacaApiKey,
    env.alpacaApiSecret,
    env.alpacaDataKey,
    env.alpacaDataSecret,
    env.supabaseAnonKey,
    env.supabaseServiceRoleKey,
  ];
  // The password component of a connection string, if any.
  const pw = /:\/\/[^:/]+:([^@]+)@/.exec(env.databaseUrl ?? "");
  if (pw) values.push(pw[1]);
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.length >= 8))];
}

/** Throws SecretLeakError if any secret value appears anywhere in text. */
export function assertNoSecrets(text: string, secrets: string[], where: string): void {
  for (const secret of secrets) {
    if (text.includes(secret)) throw new SecretLeakError(where);
  }
}

/** Walks up from start looking for the repository root (a directory holding .git). */
export function findRepoRoot(start = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Default base directory: <repo>/artifacts/latency in a checkout, else
 * ./artifacts/latency, else (a read-only image such as the production one,
 * which runs as a non-root user) <tmp>/shpe-latency.
 */
export function defaultArtifactsBase(): string {
  const root = findRepoRoot();
  if (root) return path.join(root, "artifacts", "latency");
  try {
    fs.accessSync(process.cwd(), fs.constants.W_OK);
    return path.join(process.cwd(), "artifacts", "latency");
  } catch {
    return path.join(os.tmpdir(), "shpe-latency");
  }
}

/** Sortable, unique run id, e.g. 20261012T214501Z-fixture-3fa2. */
export function newRunId(kind: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${kind.replace(/[^a-z0-9-]/gi, "")}-${randomBytes(2).toString("hex")}`;
}

/** CSV cell escaping per RFC 4180. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(","));
  return lines.join("\n") + "\n";
}

/** JSON.stringify that writes bigint as a decimal string. */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
}

export class RunArtifacts {
  private constructor(readonly runId: string, readonly dir: string, private readonly secrets: string[]) {}

  /**
   * Creates <base>/<runId>/ exclusively.
   * @throws if the directory already exists
   */
  static create(runId: string, base = defaultArtifactsBase(), secrets = knownSecretValues()): RunArtifacts {
    fs.mkdirSync(base, { recursive: true });
    const dir = path.join(base, runId);
    fs.mkdirSync(dir); // throws EEXIST: run directories are immutable
    return new RunArtifacts(runId, dir, secrets);
  }

  /** Opens an existing run directory (for reports over saved results). */
  static open(dir: string, secrets = knownSecretValues()): RunArtifacts {
    if (!fs.existsSync(dir)) throw new Error(`No such run directory: ${dir}`);
    return new RunArtifacts(path.basename(dir), dir, secrets);
  }

  path(name: string): string {
    return path.join(this.dir, name);
  }

  writeText(name: string, text: string): string {
    assertNoSecrets(text, this.secrets, name);
    const p = this.path(name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  }

  writeJson(name: string, value: unknown): string {
    return this.writeText(name, stringifyJson(value));
  }

  writeCsv(name: string, rows: Array<Record<string, unknown>>, columns?: string[]): string {
    return this.writeText(name, toCsv(rows, columns));
  }

  writeNdjson(name: string, rows: unknown[]): string {
    return this.writeText(name, rows.map((r) => JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).join("\n") + (rows.length ? "\n" : ""));
  }

  readJson<T>(name: string): T | null {
    const p = this.path(name);
    return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as T) : null;
  }

  exists(name: string): boolean {
    return fs.existsSync(this.path(name));
  }
}
