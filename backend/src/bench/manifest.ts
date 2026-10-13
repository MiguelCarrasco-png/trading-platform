/**
 * bench/manifest.ts
 *
 * Builds the run manifest: everything needed to judge whether two runs are
 * comparable — code identity, host and container limits, runtime versions,
 * clock-synchronisation state, and the command's own workload description.
 *
 * Collection is best-effort and never fatal: a tool or file that is missing is
 * recorded under `unavailable` instead of being guessed. Only an allowlist of
 * environment variables is copied, and the finished manifest is secret-scanned
 * by RunArtifacts before it is written.
 *
 * Inputs:  Run id, command name, command-specific run description.
 * Outputs: RunManifest (manifest.json).
 */

import fs from "fs";
import os from "os";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { BOOT_ID, CLOCK_DOMAIN_ID } from "../core/telemetry/clock";
import { findRepoRoot } from "./artifacts";
import { env } from "../config/env";

export const MANIFEST_SCHEMA_VERSION = 1;

/** Environment variables safe and useful to record. Never credentials. */
const ENV_ALLOWLIST = [
  "NODE_ENV",
  "EXECUTION_TARGET",
  "ALPACA_TRADING_MODE",
  "ALPACA_DATA_STREAM_URL",
  "ALPACA_PAPER_BASE_URL",
  "APP_RUNTIME_ORIGIN",
  "APP_BUILD_SHA",
  "UV_THREADPOOL_SIZE",
  "LOG_LEVEL",
  "TZ",
];

export interface RunManifest {
  schema_version: number;
  run_id: string;
  command: string;
  argv: string[];
  created_utc: string;
  code: Record<string, unknown>;
  host: Record<string, unknown>;
  runtime: Record<string, unknown>;
  limits: Record<string, unknown>;
  clock: Record<string, unknown>;
  environment: Record<string, string>;
  run: Record<string, unknown>;
  validity: { valid: boolean; reasons: string[] };
  unavailable: string[];
}

function run(cmd: string, args: string[], cwd?: string, timeoutMs = 3_000): string | null {
  try {
    return execFileSync(cmd, args, { cwd, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function readFirst(paths: string[]): string | null {
  for (const p of paths) {
    try {
      return fs.readFileSync(p, "utf8").trim();
    } catch {
      /* next */
    }
  }
  return null;
}

function collectCode(unavailable: string[]): Record<string, unknown> {
  const root = findRepoRoot();
  const sha = root ? run("git", ["rev-parse", "HEAD"], root) : null;
  if (!sha) {
    unavailable.push("git (using APP_BUILD_SHA/APP_BUILD_DIRTY instead)");
    return { git_sha: env.buildSha, dirty: env.buildDirty, source: "env" };
  }
  const porcelain = run("git", ["status", "--porcelain"], root!) ?? "";
  const diff = run("git", ["diff", "HEAD"], root!, 10_000) ?? "";
  const changed = porcelain.split("\n").filter(Boolean);
  return {
    git_sha: sha,
    branch: run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root!),
    dirty: changed.length > 0,
    changed_files: changed.slice(0, 200).map((l) => l.slice(3)),
    changed_file_digest: changed.length > 0 ? createHash("sha256").update(porcelain).update(diff).digest("hex") : null,
    source: "git",
  };
}

/** EC2 instance identity via IMDSv2. Returns null off EC2 (fast timeout). */
async function fetchEc2Identity(unavailable: string[]): Promise<Record<string, unknown> | null> {
  if (process.platform !== "linux") return null;
  const ctl = (ms: number): AbortSignal => AbortSignal.timeout(ms);
  try {
    const token = await fetch("http://169.254.169.254/latest/api/token", {
      method: "PUT", headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" }, signal: ctl(400),
    }).then((r) => (r.ok ? r.text() : null));
    if (!token) return null;
    const doc = (await fetch("http://169.254.169.254/latest/dynamic/instance-identity/document", {
      headers: { "X-aws-ec2-metadata-token": token }, signal: ctl(400),
    }).then((r) => (r.ok ? r.json() : null))) as Record<string, unknown> | null;
    if (!doc) return null;
    // Deliberately omits accountId, instanceId and private IP.
    return {
      instance_type: doc["instanceType"],
      region: doc["region"],
      availability_zone: doc["availabilityZone"],
      architecture: doc["architecture"],
      image_id: doc["imageId"],
      burstable: typeof doc["instanceType"] === "string" && /^t\d/.test(doc["instanceType"] as string),
    };
  } catch {
    unavailable.push("ec2 instance metadata (not on EC2, or IMDS blocked)");
    return null;
  }
}

function collectClock(unavailable: string[]): Record<string, unknown> {
  const clock: Record<string, unknown> = {
    clock_domain_id: CLOCK_DOMAIN_ID,
    boot_id: BOOT_ID,
    wall_source: "Date.now() (ms resolution)",
    monotonic_source: "process.hrtime.bigint() (ns units)",
  };
  const cap = (s: string | null): string | null => (s === null ? null : s.slice(0, 4_000));
  if (process.platform === "linux") {
    const chrony = run("chronyc", ["-n", "tracking"]);
    if (chrony) clock["chronyc_tracking"] = cap(chrony);
    else unavailable.push("chronyc tracking");
    const sources = run("chronyc", ["-n", "sources", "-v"]);
    if (sources) clock["chronyc_sources"] = cap(sources);
    const timedatectl = run("timedatectl", ["show"]);
    if (timedatectl) clock["timedatectl"] = cap(timedatectl);
    else unavailable.push("timedatectl");
  } else if (process.platform === "win32") {
    const w32 = run("w32tm", ["/query", "/status"]);
    if (w32) clock["w32tm_status"] = cap(w32);
    else unavailable.push("w32tm /query /status");
  } else if (process.platform === "darwin") {
    const sntp = run("sntp", ["time.apple.com"], undefined, 5_000);
    if (sntp) clock["sntp_offset"] = cap(sntp);
    else unavailable.push("sntp");
  }
  return clock;
}

function collectLimits(unavailable: string[]): Record<string, unknown> {
  const cpuMax = readFirst(["/sys/fs/cgroup/cpu.max"]);
  const memMax = readFirst(["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]);
  if (process.platform === "linux" && cpuMax === null && memMax === null) unavailable.push("cgroup limits");
  let cpuLimitCores: number | null = null;
  if (cpuMax && !cpuMax.startsWith("max")) {
    const [quota, period] = cpuMax.split(/\s+/).map(Number);
    if (quota > 0 && period > 0) cpuLimitCores = quota / period;
  }
  return {
    cgroup_cpu_max: cpuMax,
    cgroup_cpu_limit_cores: cpuLimitCores,
    cgroup_memory_max: memMax,
    available_parallelism: os.availableParallelism(),
  };
}

export interface ManifestInput {
  runId: string;
  command: string;
  argv: string[];
  /** Command-specific description: workload, strategies, sinks, limits, seeds. */
  run: Record<string, unknown>;
  /** Directory whose filesystem free space to record. */
  storageDir?: string;
}

export async function buildManifest(input: ManifestInput): Promise<RunManifest> {
  const unavailable: string[] = [];
  const environment: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (v !== undefined) environment[key] = v;
  }
  let storage: Record<string, unknown> | null = null;
  if (input.storageDir) {
    try {
      const st = await fs.promises.statfs(input.storageDir);
      storage = { free_bytes: Number(st.bavail) * Number(st.bsize), total_bytes: Number(st.blocks) * Number(st.bsize) };
    } catch {
      unavailable.push("statfs");
    }
  }
  const cpus = os.cpus();
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    run_id: input.runId,
    command: input.command,
    argv: input.argv,
    created_utc: new Date().toISOString(),
    code: collectCode(unavailable),
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      os_type: os.type(),
      os_release: os.release(),
      os_version: typeof os.version === "function" ? os.version() : null,
      arch: process.arch,
      cpu_model: cpus[0]?.model ?? null,
      cpu_count: cpus.length,
      total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
      free_memory_mb_at_start: Math.round(os.freemem() / 1024 / 1024),
      load_average: os.loadavg(),
      uptime_s: os.uptime(),
      ec2: await fetchEc2Identity(unavailable),
      storage,
      in_container: fs.existsSync("/.dockerenv"),
    },
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      uv: process.versions.uv,
      pid: process.pid,
      exec_argv: process.execArgv,
    },
    limits: collectLimits(unavailable),
    clock: collectClock(unavailable),
    environment,
    run: input.run,
    validity: { valid: true, reasons: [] },
    unavailable,
  };
}

/** Marks a manifest invalid for comparison, keeping every reason. */
export function invalidate(manifest: RunManifest, reason: string): void {
  manifest.validity.valid = false;
  manifest.validity.reasons.push(reason);
}
