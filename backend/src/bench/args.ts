/**
 * bench/args.ts
 *
 * Strict command-line parsing for the benchmark CLI: `--name value`,
 * `--name=value`, and bare boolean `--flag`. Every flag a command does not
 * read is an error, so a mistyped safety option fails loudly instead of being
 * silently ignored.
 *
 * Inputs:  process.argv.slice(2).
 * Outputs: Typed getters; assertAllUsed().
 */

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

export class Args {
  readonly command: string | null;
  private readonly flags = new Map<string, string | true>();
  private readonly used = new Set<string>();

  constructor(readonly argv: string[]) {
    let i = 0;
    this.command = argv[0] && !argv[0].startsWith("--") ? argv[i++] : null;
    for (; i < argv.length; i++) {
      const token = argv[i];
      if (!token.startsWith("--")) throw new ArgError(`Unexpected argument "${token}" (flags look like --name value)`);
      const eq = token.indexOf("=");
      if (eq > 0) {
        this.flags.set(token.slice(2, eq), token.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        this.flags.set(token.slice(2), argv[++i]);
      } else {
        this.flags.set(token.slice(2), true);
      }
    }
  }

  has(name: string): boolean {
    this.used.add(name);
    return this.flags.has(name);
  }

  bool(name: string): boolean {
    this.used.add(name);
    const v = this.flags.get(name);
    if (v === undefined) return false;
    if (v === true || v === "true") return true;
    if (v === "false") return false;
    throw new ArgError(`--${name} is a switch; got "${v}"`);
  }

  str(name: string, fallback?: string): string {
    this.used.add(name);
    const v = this.flags.get(name);
    if (v === undefined) {
      if (fallback === undefined) throw new ArgError(`--${name} is required`);
      return fallback;
    }
    if (v === true) throw new ArgError(`--${name} needs a value`);
    return v;
  }

  optStr(name: string): string | undefined {
    this.used.add(name);
    const v = this.flags.get(name);
    if (v === true) throw new ArgError(`--${name} needs a value`);
    return v;
  }

  num(name: string, fallback?: number, opts: { min?: number; max?: number; integer?: boolean } = {}): number {
    const raw = this.optStr(name);
    if (raw === undefined) {
      if (fallback === undefined) throw new ArgError(`--${name} is required`);
      return fallback;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new ArgError(`--${name} must be a number, got "${raw}"`);
    if (opts.integer && !Number.isInteger(n)) throw new ArgError(`--${name} must be a whole number`);
    if (opts.min !== undefined && n < opts.min) throw new ArgError(`--${name} must be ≥ ${opts.min}`);
    if (opts.max !== undefined && n > opts.max) throw new ArgError(`--${name} must be ≤ ${opts.max}`);
    return n;
  }

  list(name: string, fallback?: string[]): string[] {
    const raw = this.optStr(name);
    if (raw === undefined) {
      if (fallback === undefined) throw new ArgError(`--${name} is required`);
      return fallback;
    }
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  choice<T extends string>(name: string, choices: readonly T[], fallback?: T): T {
    const v = this.str(name, fallback);
    if (!(choices as readonly string[]).includes(v)) throw new ArgError(`--${name} must be one of ${choices.join(", ")}; got "${v}"`);
    return v as T;
  }

  /** Throws for any flag the command did not read. */
  assertAllUsed(): void {
    const unknown = [...this.flags.keys()].filter((k) => !this.used.has(k));
    if (unknown.length) throw new ArgError(`Unknown option(s) for "${this.command}": ${unknown.map((k) => `--${k}`).join(", ")}`);
  }
}
